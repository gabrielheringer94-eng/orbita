// Edge Function: smart-capture
// Proxy autenticado pra Anthropic API. Recebe { text } do cliente,
// monta o system prompt do classificador de intenções e devolve o JSON.

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('SMART_CAPTURE_MODEL') ?? 'claude-sonnet-4-6';

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

function buildSystemPrompt(): string {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const todayStr = today.toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);

  return `Você é um classificador de intenções para um app de produtividade pessoal em português. Hoje é ${todayStr} (${todayIso}).

Receberá uma frase do usuário e deve retornar APENAS um objeto JSON (sem markdown, sem explicação) com a estrutura:

{
  "type": "shopping" | "task" | "event" | "habit" | "goal",
  "title": "string concisa, sem prefixos como 'comprar' se for shopping",
  "date": "YYYY-MM-DD ou null",
  "time": "HH:MM ou null",
  "endTime": "HH:MM ou null",
  "priority": "low" | "med" | "high",
  "category": "string ou null",
  "project": "string ou null",
  "recurring": true | false,
  "explanation": "frase curta explicando como interpretou"
}

Regras de classificação:
- "shopping": comprar coisas, item de mercado/farmácia/supermercado. Title é só o item ("leite", não "comprar leite"). Category sugerida: "mercado", "farmácia", "casa", etc.
- "event": aniversários, reuniões, compromissos com data/hora específica. Aniversários são recurring=true e priority=med. Para aniversários sem hora, use time="09:00".
- "task": ação a fazer sem ser compra nem evento marcado. Tem data se mencionada (hoje, amanhã, próxima segunda, etc.)
- "habit": hábito recorrente que não tem data específica ("ler mais", "treinar todo dia", "meditar"). Title curto.
- "goal": objetivo com prazo longo ou métrica ("aprender inglês até dezembro", "correr 100km no mês")

Datas relativas: "hoje" = ${todayIso}. "amanhã" = ${tomorrowIso}. "próxima segunda" = calcule. Se mencionar só dia e mês ("22 de maio"), assuma o ano atual ou próximo se já passou.

Exemplos:
"comprar leite" → {"type":"shopping","title":"leite","category":"mercado","date":null,"time":null,"endTime":null,"priority":"low","project":null,"recurring":false,"explanation":"item de mercado adicionado à lista"}

"aniversário do Pedro dia 22 de maio" → {"type":"event","title":"Aniversário do Pedro","date":"${todayIso.slice(0,4)}-05-22","time":"09:00","endTime":"09:30","priority":"med","category":"pessoal","project":null,"recurring":true,"explanation":"lembrete recorrente anual"}

"treinar amanhã 18h" → {"type":"event","title":"Treino","date":"${tomorrowIso}","time":"18:00","endTime":"19:00","priority":"med","category":"saúde","project":"Saúde","recurring":false,"explanation":"bloco de treino agendado"}

"ler mais" → {"type":"habit","title":"Leitura diária","date":null,"time":null,"endTime":null,"priority":"med","category":null,"project":null,"recurring":true,"explanation":"hábito recorrente"}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY não configurada na função' }, 500);
  }

  // O Supabase só repassa o request pra função se o JWT do usuário for válido
  // (quando verify_jwt=true no config.toml). Não precisamos re-validar aqui.

  let text: string;
  try {
    const body = await req.json();
    text = (body?.text ?? '').toString().trim();
    if (!text) return json({ error: 'Campo "text" obrigatório' }, 400);
    if (text.length > 500) return json({ error: 'Frase muito longa (máx 500 chars)' }, 400);
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
        max_tokens: 500,
        system: buildSystemPrompt(),
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return json({ error: 'Resposta do modelo não é JSON válido', raw }, 502);
    }

    return json(parsed);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Erro desconhecido' }, 500);
  }
});
