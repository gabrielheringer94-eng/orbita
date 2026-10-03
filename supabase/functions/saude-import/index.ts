// Edge Function: saude-import
// Proxy autenticado pra Anthropic API. Recebe prints do app Saúde (iPhone) e/ou
// laudos de exame (imagem ou PDF) e devolve os dados estruturados pra conferência.

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('SAUDE_IMPORT_MODEL') ?? 'claude-sonnet-5-5';
const MAX_FILES = 12;
const MAX_TOTAL_B64 = 18_000_000;

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

const MARCADORES = [
  'Glicose em jejum', 'Hemoglobina glicada (HbA1c)', 'Insulina', 'Colesterol total', 'HDL', 'LDL',
  'Triglicerídeos', 'Hemoglobina', 'Hematócrito', 'Leucócitos', 'Plaquetas', 'Ferritina',
  'Vitamina D (25-OH)', 'Vitamina B12', 'TSH', 'T4 livre', 'Testosterona total', 'Creatinina',
  'Ureia', 'Ácido úrico', 'TGO (AST)', 'TGP (ALT)', 'Gama GT', 'CK (CPK)', 'PCR ultrassensível',
];

const day = { type: 'string', description: 'Data no formato YYYY-MM-DD' };
const TOOL = {
  name: 'registrar_saude',
  description: 'Registra os dados de saúde lidos nos arquivos.',
  input_schema: {
    type: 'object',
    properties: {
      sono: {
        type: 'array',
        description: 'Horas dormidas por dia (o dia em que a pessoa acordou, como o app Saúde agrupa).',
        items: { type: 'object', properties: { data: day, horas: { type: 'number' } }, required: ['data', 'horas'] },
      },
      peso: {
        type: 'array',
        items: { type: 'object', properties: { data: day, kg: { type: 'number' } }, required: ['data', 'kg'] },
      },
      fc_repouso: {
        type: 'array',
        description: 'Frequência cardíaca em repouso (bpm) por dia.',
        items: { type: 'object', properties: { data: day, bpm: { type: 'number' } }, required: ['data', 'bpm'] },
      },
      atividades: {
        type: 'array',
        description: 'Treinos/exercícios registrados (musculação, futebol, corrida, caminhada...).',
        items: {
          type: 'object',
          properties: { data: day, tipo: { type: 'string' }, minutos: { type: 'number' } },
          required: ['data', 'tipo'],
        },
      },
      exames: {
        type: 'array',
        description: 'Um item por laudo/data de coleta.',
        items: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'Data da coleta, YYYY-MM-DD' },
            laboratorio: { type: 'string' },
            marcadores: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  nome: { type: 'string' },
                  valor: { type: 'number' },
                  unidade: { type: 'string' },
                  ref_min: { type: ['number', 'null'] },
                  ref_max: { type: ['number', 'null'] },
                },
                required: ['nome', 'valor'],
              },
            },
          },
          required: ['data', 'marcadores'],
        },
      },
      avisos: {
        type: 'array',
        description: 'Pontos de atenção curtos em português: o que não deu para ler, médias sem valor diário, datas inferidas.',
        items: { type: 'string' },
      },
    },
    required: ['sono', 'peso', 'fc_repouso', 'atividades', 'exames', 'avisos'],
  },
};

function systemPrompt(today: string) {
  return `Você extrai dados de saúde de arquivos enviados por uma pessoa no Brasil. Hoje é ${today}.

Os arquivos podem ser:
1. Prints do app Saúde do iPhone em português (Sono, Peso, Frequência Cardíaca em Repouso, Exercícios/Treinos, Fitness). Costumam estar na visão "S" (semana) ou "D" (dia).
2. Laudos de exames de sangue (foto, print ou PDF).

Regras gerais:
- Extraia SOMENTE valores legíveis. Nunca invente nem estime. Na dúvida, deixe de fora e explique em "avisos".
- Datas: no app Saúde a semana aparece com iniciais (D S T Q Q S S) e um intervalo no topo (ex.: "28 de set. – 4 de out. de 2026"). Use o intervalo e as iniciais para chegar à data exata de cada barra. Se o ano não aparecer, use o ano mais recente que não fique no futuro em relação a hoje.
- Se o print mostra só a média da semana e não dá para ler o valor de cada dia, NÃO distribua a média pelos dias: registre só os dias que dá para ler e cite a média em "avisos".
- Ao tocar numa barra, o app mostra o valor exato do dia num balão: priorize esse valor.

Sono: use o tempo "Dormindo" (não "Na cama"). Converta "7 h 32 min" para 7.53 (horas decimais, 2 casas). A data é o dia em que a pessoa acordou, como o próprio app agrupa.
Peso: em kg. Frequência cardíaca em repouso: em bpm. Atividades: tipo em português (ex.: "Musculação", "Futebol", "Corrida", "Caminhada") e duração em minutos se aparecer.

Exames:
- Um item por data de coleta. "laboratorio" = nome do laboratório, se aparecer.
- Se o marcador for um destes, use EXATAMENTE este nome: ${MARCADORES.join('; ')}. Caso contrário, use o nome do laudo em português, curto.
- Valor numérico (vírgula decimal vira ponto). Ignore resultados não numéricos (ex.: "Não reagente").
- Referência: use a do laudo para o sexo masculino adulto quando houver separação por sexo. "Inferior a 130" ou "< 130" → ref_min null, ref_max 130. "Superior a 40" → ref_min 40, ref_max null. Faixas com várias categorias (ex.: "Desejável < 190") → use a faixa desejável/normal.
- Leucócitos em /mm³; plaquetas em mil/mm³ (converta se o laudo usar outra escala e diga em "avisos").

Chame a ferramenta registrar_saude uma vez, com listas vazias para o que não estiver nos arquivos.`;
}

type FileIn = { media_type: string; data: string; name?: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY não configurada na função' }, 500);

  // verify_jwt=true também aceita a chave pública (anon), que está no HTML do site.
  // Então confirmamos que existe um usuário logado antes de gastar crédito da API.
  const userRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  });
  if (!userRes.ok) return json({ error: 'Faça login para importar' }, 401);

  let files: FileIn[];
  let today: string;
  try {
    const body = await req.json();
    files = Array.isArray(body?.files) ? body.files : [];
    today = /^\d{4}-\d{2}-\d{2}$/.test(body?.today ?? '') ? body.today : new Date().toISOString().slice(0, 10);
  } catch {
    return json({ error: 'Body inválido' }, 400);
  }
  if (!files.length) return json({ error: 'Nenhum arquivo enviado' }, 400);
  if (files.length > MAX_FILES) return json({ error: `Máximo de ${MAX_FILES} arquivos por vez` }, 400);
  const total = files.reduce((a, f) => a + (f.data?.length ?? 0), 0);
  if (total > MAX_TOTAL_B64) return json({ error: 'Arquivos grandes demais. Envie menos de uma vez.' }, 413);

  const content: unknown[] = [];
  for (const f of files) {
    if (f.media_type === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
    } else if (/^image\/(jpeg|png|webp|gif)$/.test(f.media_type)) {
      content.push({ type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } });
    } else {
      return json({ error: `Tipo de arquivo não suportado: ${f.media_type}` }, 400);
    }
  }
  content.push({ type: 'text', text: `São ${files.length} arquivo(s). Extraia os dados.` });

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
        max_tokens: 8000,
        system: systemPrompt(today),
        tools: [TOOL],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return json({ error: `Anthropic ${response.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await response.json();
    const blocks = data.content ?? [];
    const use = blocks.find((b: { type: string }) => b.type === 'tool_use');
    if (use) return json(use.input);
    // Fallback: o modelo respondeu em texto. Tenta achar um JSON no meio.
    const raw = blocks.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return json(JSON.parse(m[0])); } catch { /* cai no erro abaixo */ } }
    return json({ error: 'O modelo não devolveu dados estruturados', raw: raw.slice(0, 300) }, 502);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Erro desconhecido' }, 500);
  }
});
