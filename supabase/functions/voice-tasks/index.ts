// Edge Function: voice-tasks
// Recebe a transcrição de um ditado por voz (tela de Tarefas do Órbita) e devolve
// uma lista de tarefas estruturadas. Um ditado pode conter várias tarefas.
// Body: { text: string, today?: 'YYYY-MM-DD', projects?: string[] }
// Resposta: { tasks: [{ title, date, priority, project }] } ou { error }

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('VOICE_TASKS_MODEL') ?? 'claude-haiku-5-5';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// "Hoje" vem do cliente (fuso de São Paulo); fallback calcula no fuso BR.
function resolveToday(raw: unknown): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildSystemPrompt(today: string, projects: string[]): string {
  const weekday = new Date(today + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });
  const projList = projects.length ? projects.map(p => `"${p}"`).join(', ') : '(nenhum ainda)';
  return `Você transforma ditados por voz em tarefas de uma to-do list pessoal, em português do Brasil.
Hoje é ${weekday}, ${today}. Amanhã é ${addDays(today, 1)}.

O texto vem de reconhecimento de voz: pode ter erros de transcrição, falta de pontuação, hesitações ("é...", "tipo", "ah") e frases como "cria uma tarefa", "me lembra de", "preciso". Ignore esses ruídos e extraia só a intenção.

Retorne APENAS um JSON (sem markdown, sem explicação) no formato:
{"tasks":[{"title":"...","date":"YYYY-MM-DD ou null","priority":"low|med|high","project":"string ou null"}]}

Regras:
- Um ditado pode conter VÁRIAS tarefas ("ligar pro contador e mandar a proposta sexta" = 2 tarefas). Separe-as.
- title: verbo no infinitivo, curto e claro, primeira letra maiúscula, sem a data e sem a prioridade no texto. Ex.: "Ligar para o contador".
- date: só se o usuário mencionar quando (hoje, amanhã, sexta, dia 20, semana que vem = próxima segunda). Dias da semana referem-se à próxima ocorrência a partir de hoje (se hoje é sexta e ele diz "sexta", é hoje). Sem menção, null.
- priority: "high" se disser urgente, importante, prioridade alta, sem falta, crítico; "low" se disser sem pressa, quando der, prioridade baixa; caso contrário "med".
- project: se o usuário citar um projeto/contexto e ele corresponder (mesmo aproximadamente) a um destes projetos existentes, use o nome EXATO existente: ${projList}. Se ele disser explicitamente "projeto X" que não existe, use X. Caso contrário null.
- Se não houver nenhuma tarefa identificável, retorne {"tasks":[]}.`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY não configurada na função' }, 500);

  // verify_jwt também aceita a anon key pública, então confere se há usuário logado.
  const userRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  });
  if (!userRes.ok) return json({ error: 'Faça login para criar tarefas por voz' }, 401);

  let text: string, today: string, projects: string[];
  try {
    const body = await req.json();
    text = (body?.text ?? '').toString().trim();
    if (!text) return json({ error: 'Não ouvi nada. Tente de novo.' }, 400);
    if (text.length > 1500) return json({ error: 'Ditado muito longo (máx 1500 caracteres)' }, 400);
    today = resolveToday(body?.today);
    projects = Array.isArray(body?.projects)
      ? body.projects.filter((p: unknown) => typeof p === 'string').map((p: string) => p.slice(0, 60)).slice(0, 40)
      : [];
  } catch {
    return json({ error: 'Body inválido' }, 400);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: buildSystemPrompt(today, projects),
        messages: [{ role: 'user', content: text }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return json({ error: `Anthropic ${response.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await response.json();
    const raw = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('');
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    let parsed: { tasks?: unknown };
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return json({ error: 'Resposta do modelo não é JSON válido', raw }, 502);
    }

    // Saneamento: garante o formato esperado pelo cliente.
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .map((t: Record<string, unknown>) => ({
        title: String(t?.title ?? '').trim().slice(0, 200),
        date: typeof t?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null,
        priority: ['low', 'med', 'high'].includes(t?.priority as string) ? t.priority : 'med',
        project: typeof t?.project === 'string' && t.project.trim() ? t.project.trim().slice(0, 60) : null,
      }))
      .filter((t: { title: string }) => t.title)
      .slice(0, 20);

    return json({ tasks });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Erro desconhecido' }, 500);
  }
});
