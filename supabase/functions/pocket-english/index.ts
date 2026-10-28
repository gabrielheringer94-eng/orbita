// Edge Function: pocket-english
// Proxy autenticado para a Anthropic API usado pelo Pocket Phrasebook (aba Inglês).
// Recebe { prompt, quick } e devolve o JSON gerado pelo modelo (equivale ao sample.json do app original).
// Com { stream: true, messages } devolve o texto em streaming (aba Ask: dúvidas respondidas na hora).

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('POCKET_MODEL') ?? 'claude-sonnet-4-6';
const QUICK_MODEL = Deno.env.get('POCKET_QUICK_MODEL') ?? 'claude-haiku-4-5';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

// Extrai o primeiro valor JSON (objeto ou lista) do texto do modelo
function extractJSON(raw: string): unknown {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* tenta recortar */ }
  const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) throw new Error('sem JSON');
  const start = Math.min(...starts);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  return JSON.parse(cleaned.slice(start, end + 1));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY não configurada na função' }, 500);

  // verify_jwt também aceita a anon key pública, então confere se há usuário logado.
  // A checagem roda em paralelo com o resto para não atrasar a resposta.
  const authP = fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  }).then((r) => r.ok).catch(() => false);
  const denied = () => json({ error: 'Faça login para usar o Pocket Phrasebook' }, 401);

  let prompt: string, quick: boolean;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Body inválido' }, 400); }

  // Modo conversa com streaming: devolve só o texto, pedaço por pedaço, para a resposta aparecer na hora
  if (body?.stream) {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const messages = msgs
      .filter((m: { role?: string; content?: unknown }) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
      .slice(-16)
      .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content.slice(0, 8000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'Envie a pergunta' }, 400);
    const system = typeof body.system === 'string' ? body.system.slice(0, 4000) : undefined;
    const ctl = new AbortController();
    const upP = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: body.quick === false ? MODEL : QUICK_MODEL, max_tokens: Math.min(Number(body.max_tokens) || 900, 2000), stream: true, ...(system ? { system } : {}), messages }),
    });
    if (!(await authP)) { ctl.abort(); upP.catch(() => {}); return denied(); }
    let upstream: Response;
    try { upstream = await upP; } catch (e) { return json({ error: e instanceof Error ? e.message : 'Falha na IA' }, 502); }
    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      return json({ error: `Anthropic ${upstream.status}: ${errText.slice(0, 300)}` }, upstream.status === 429 ? 429 : 502);
    }
    const enc = new TextEncoder(), dec = new TextDecoder();
    const reader = upstream.body.getReader();
    const out = new ReadableStream({
      async start(controller) {
        let buf = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
              if (!line.startsWith('data:')) continue;
              try {
                const ev = JSON.parse(line.slice(5));
                if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') controller.enqueue(enc.encode(ev.delta.text));
              } catch { /* linha incompleta */ }
            }
          }
        } catch { /* conexão encerrada */ }
        controller.close();
      },
    });
    return new Response(out, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } });
  }

  if (!(await authP)) return denied();

  try {
    prompt = (body?.prompt ?? '').toString();
    quick = !!body?.quick;
    if (!prompt.trim()) return json({ error: 'Campo "prompt" obrigatório' }, 400);
    if (prompt.length > 30000) return json({ error: 'Pedido muito longo' }, 400);
  } catch {
    return json({ error: 'Body inválido' }, 400);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: quick ? QUICK_MODEL : MODEL,
        max_tokens: quick ? 1500 : 4000,
        system: 'Responda somente com um único valor JSON válido (objeto ou lista), sem markdown, sem texto antes ou depois.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      return json({ error: `Anthropic ${response.status}: ${errText.slice(0, 300)}` }, 502);
    }
    const data = await response.json();
    const raw = (data.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    try {
      return json({ value: extractJSON(raw) });
    } catch {
      return json({ error: 'Resposta do modelo não é JSON válido', raw: raw.slice(0, 500) }, 502);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Erro desconhecido' }, 500);
  }
});
