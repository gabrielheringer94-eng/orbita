// Edge Function: pocket-english
// Proxy autenticado para a Anthropic API usado pelo Pocket Phrasebook (aba Inglês).
// Recebe { prompt, quick } e devolve o JSON gerado pelo modelo (equivale ao sample.json do app original).

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
  const userRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  });
  if (!userRes.ok) return json({ error: 'Faça login para usar o Pocket Phrasebook' }, 401);

  let prompt: string, quick: boolean;
  try {
    const body = await req.json();
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
