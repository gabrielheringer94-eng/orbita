// Edge Function: smart-capture-place
// Proxy autenticado pra Anthropic API que extrai dados de um lugar
// a partir de texto livre (nome, descrição) ou URL do Google Maps.

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

const SYSTEM_PROMPT = `Você extrai dados estruturados sobre estabelecimentos (bares, restaurantes, cafés, etc.) a partir de texto livre ou URLs do Google Maps em português.

Receberá uma frase, descrição ou URL e deve retornar APENAS um objeto JSON (sem markdown, sem explicação) com:

{
  "name": "Nome do estabelecimento",
  "type": "bar" | "boteco" | "restaurante" | "cafe" | "doceria" | "outro",
  "neighborhood": "Nome do bairro ou null",
  "city": "Nome da cidade (default São Paulo se não especificada)",
  "address": "Rua e número se mencionados, ou null",
  "tags": ["tag1", "tag2"] | [],
  "notes": "Comentários do usuário, opcional",
  "status": "visited" | "wishlist",
  "explanation": "Frase curta explicando o que entendeu"
}

Regras:
- "type": classifica baseado em pistas no texto:
    * "bar"  → bares mais formais, coqueteleria, drinks autorais, rooftop, lounge.
    * "boteco" → bar de bairro, mesa na calçada, chopp, petisco, classudo no informal.
    * "restaurante" → comida, jantar, almoço, cantina, cozinha (italiana, japonesa…), brasserie.
    * "cafe" → café, cafeteria, padaria, brunch, café da manhã, cafeteria de especialidade.
    * "doceria" → sorveteria, gelateria, doceria, confeitaria, brigaderia, açaí, frozen.
    * "outro" → tudo que não couber acima.
- "tags": extrai descritores curtos do texto (ex: "drinks autorais", "italiano", "brunch", "vista", "rooftop", "vegano", "japonês"). Máximo 5.
- "notes": só se houver comentários pessoais ou descrição extra. Não repita o nome ou tipo.
- "status": default "wishlist". Se a frase mencionar "fui", "comi", "já estive", marca "visited".
- "name": só o nome do lugar, sem prefixos tipo "restaurante", "bar".
- Se receber URL do Google Maps, extrai o que conseguir da URL e infere o resto.

Exemplos:

Entrada: "Bar dos Arcos, no centro de SP, drinks autorais"
Saída: {"name":"Bar dos Arcos","type":"bar","neighborhood":"Centro","city":"São Paulo","address":null,"tags":["drinks autorais"],"notes":null,"status":"wishlist","explanation":"Bar no centro de SP com drinks autorais"}

Entrada: "Já fui no Coffee Lab em Pinheiros, café incrível"
Saída: {"name":"Coffee Lab","type":"cafe","neighborhood":"Pinheiros","city":"São Paulo","address":null,"tags":["café especial"],"notes":"café incrível","status":"visited","explanation":"Café em Pinheiros, já visitado"}

Entrada: "Veridiana, R. dos Pinheiros 1227, restaurante italiano"
Saída: {"name":"Veridiana","type":"restaurante","neighborhood":"Pinheiros","city":"São Paulo","address":"R. dos Pinheiros, 1227","tags":["italiano","pizza"],"notes":null,"status":"wishlist","explanation":"Restaurante italiano em Pinheiros"}

Entrada: "https://www.google.com/maps/place/Padaria+Bella+Paulista/..."
Saída: {"name":"Padaria Bella Paulista","type":"cafe","neighborhood":null,"city":"São Paulo","address":null,"tags":["padaria"],"notes":null,"status":"wishlist","explanation":"Padaria identificada pela URL"}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY não configurada na função' }, 500);
  }

  let text: string;
  try {
    const body = await req.json();
    text = (body?.text ?? '').toString().trim();
    if (!text) return json({ error: 'Campo "text" obrigatório' }, 400);
    if (text.length > 2000) return json({ error: 'Texto muito longo (máx 2000 chars)' }, 400);
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
        max_tokens: 600,
        system: SYSTEM_PROMPT,
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
