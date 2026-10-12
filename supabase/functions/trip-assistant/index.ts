// Edge Function: trip-assistant
// Assistente da aba Viagem. Recebe o que o usuário escreveu (ou um pedido de
// revisão) + o estado das checklists e devolve, em JSON estruturado, onde
// cada item deve entrar, dicas, urgência e o que já pode ser marcado como feito.

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { betaZodOutputFormat } from 'npm:@anthropic-ai/sdk@0.133.0/helpers/beta/zod';
import * as z from 'npm:zod@4.1.12/v4';

const MODEL = Deno.env.get('TRIP_ASSISTANT_MODEL') ?? 'claude-opus-5-5';
const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

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

// ---------- leitura de prints/PDFs (modo "extract") ----------
const MAX_EXTRACT_FILES = 6;
const MAX_EXTRACT_B64 = 15_000_000;
const ExtractInputSchema = z.object({
  mode: z.literal('extract'),
  today: z.string().max(10),
  files: z.array(z.object({
    media_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    data: z.string().min(10),
    name: z.string().max(200).default(''),
  })).min(1).max(MAX_EXTRACT_FILES),
});

const DOC_FIELD_KEYS = [
  'airline', 'flight', 'date', 'time', 'from', 'to', 'locator', 'ticket', 'seat', 'terminal', 'baggage',
  'company', 'code', 'name', 'address', 'checkin', 'checkout', 'confirmation', 'phone',
  'policy', 'coverage', 'holder', 'number', 'expiry', 'country', 'relation', 'title', 'value', 'notes',
] as const;
const ExtractOutputSchema = z.object({
  message: z.string(),
  cards: z.array(z.object({
    type: z.enum(['flight', 'transport', 'hotel', 'insurance', 'passport', 'contact', 'other']),
    source_index: z.number().int(),
    fields: z.object(Object.fromEntries(DOC_FIELD_KEYS.map(k => [k, z.string().nullable()])) as Record<typeof DOC_FIELD_KEYS[number], z.ZodNullable<z.ZodString>>),
  })),
});

const EXTRACT_SYSTEM = `Você lê prints de tela e PDFs de viagem (cartões de embarque, e-mails e apps de companhias aéreas, confirmações de reserva de hotel/Airbnb, bilhetes de trem/ônibus, aluguel de carro, apólices de seguro viagem, passaporte) e extrai os dados importantes para um app pessoal em português do Brasil.

Para cada item distinto encontrado, crie um card. Um mesmo arquivo pode ter vários (ex.: ida e volta = 2 voos; cada trecho com conexão = 1 voo por trecho). source_index é o número do arquivo (começando em 0) de onde o card saiu.

Tipos e campos usados (os demais ficam null):
- flight: airline, flight (ex.: "TP 82"), date, time (partida), from, to, locator (código da reserva/PNR, ~6 caracteres), ticket (nº do bilhete/e-ticket, ~13 dígitos), seat, terminal (terminal/portão), baggage, notes.
- transport (trem, ônibus, carro alugado, transfer): company, code (localizador/reserva), date, time, from, to, seat, notes.
- hotel (inclui Airbnb): name, address, checkin, checkout, confirmation, phone, notes.
- insurance: company, policy, phone (emergência), coverage, notes.
- passport (ou outro documento de identidade): holder, number, expiry, country, notes.
- contact: name, phone, relation, notes.
- other: title, value, notes.

Regras:
- Copie códigos EXATAMENTE como aparecem (localizador, bilhete, apólice, nº de reserva, nº do passaporte), sem inventar nem "corrigir". Se um caractere estiver ilegível, deixe o campo null e avise em notes.
- Datas sempre YYYY-MM-DD; horários HH:MM (24h). Se o ano não aparecer, use o próximo ano em que a data cai a partir de hoje.
- Aeroportos no formato "GRU · São Paulo" (código IATA + cidade) quando o código existir; senão só a cidade.
- notes: só informações úteis curtas que não cabem nos outros campos (ex.: "Embarque 21:50 · Grupo 3", "Café incluso", "Conexão em Lisboa"). Senão null.
- Não crie cards para propaganda, termos de uso ou itens sem dados úteis.
- message: 1 frase em português dizendo o que foi encontrado (ou que nada útil foi encontrado e por quê).`;

async function handleExtract(raw: unknown) {
  const parsed = ExtractInputSchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'Envie de 1 a 6 imagens (JPG/PNG/WebP) ou PDFs' }, 400);
  const input = parsed.data;
  const total = input.files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_EXTRACT_B64) return json({ error: 'Arquivos grandes demais. Envie menos de uma vez.' }, 400);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  input.files.forEach((f, i) => {
    content.push({ type: 'text', text: `Arquivo ${i}${f.name ? ` (${f.name})` : ''}:` });
    if (f.media_type === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } });
    }
  });
  content.push({ type: 'text', text: `Hoje é ${input.today}. Extraia os dados de viagem desses arquivos.` });

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(ExtractOutputSchema) },
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') {
    return json({ error: 'Não consegui ler esse arquivo. Tente outro print.' }, 422);
  }
  if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
    return json({ error: 'Leitura incompleta. Tente com menos arquivos de uma vez.' }, 502);
  }
  const out = response.parsed_output;
  return json({
    message: out.message,
    cards: out.cards.map(c => ({
      type: c.type,
      source_index: c.source_index >= 0 && c.source_index < input.files.length ? c.source_index : 0,
      // só campos preenchidos
      fields: Object.fromEntries(Object.entries(c.fields).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim()])),
    })).filter(c => Object.keys(c.fields).length),
  });
}

// ---------- entrada ----------
const InputSchema = z.object({
  mode: z.enum(['route', 'next']),
  text: z.string().max(2000).default(''),
  trip: z.object({
    name: z.string().max(200).default(''),
    cities: z.string().max(500).default(''),
    start: z.string().max(10).default(''),
    end: z.string().max(10).default(''),
    today: z.string().max(10),
    lists: z.array(z.object({
      id: z.string().max(40),
      name: z.string().max(120),
      items: z.array(z.object({
        id: z.string().max(40),
        text: z.string().max(300),
        done: z.boolean(),
      })).max(150),
    })).max(30),
    days: z.array(z.object({
      date: z.string().max(10),
      title: z.string().max(200),
      stops: z.array(z.string().max(200)).max(40),
    })).max(60).default([]),
  }),
});
type Input = z.infer<typeof InputSchema>;

// ---------- saída ----------
const OutputSchema = z.object({
  message: z.string(),
  items: z.array(z.object({
    text: z.string(),
    list_id: z.string().nullable(),
    new_list_name: z.string().nullable(),
    new_list_emoji: z.string().nullable(),
    tip: z.string().nullable(),
    urgent: z.boolean(),
  })),
  completed_item_ids: z.array(z.string()),
});

const SYSTEM = `Você é o assistente de viagem do Órbita, um app pessoal de produtividade. O usuário é brasileiro e está se preparando para uma viagem internacional. Responda sempre em português do Brasil, de forma direta e prática, como um amigo experiente em viagens.

Você recebe o estado da viagem (datas, destinos, checklists com ids e itens, roteiro) e um pedido em um de dois modos:

MODO "route" — o usuário escreveu, do jeito dele, coisas que precisa fazer, comprar ou levar (pode ser uma lista bagunçada, frases soltas, ou "já fiz X").
- Separe em itens curtos e acionáveis (comece com verbo quando for uma ação: "Comprar adaptador tipo C").
- Para cada item, escolha a checklist existente mais adequada (list_id com o id exato) ou, se nenhuma servir, deixe list_id null e proponha new_list_name e new_list_emoji. Reaproveite uma lista nova proposta para itens parecidos (mesmo nome).
- Não duplique itens que já existem nas checklists (mesmo sentido); nesse caso, omita.
- Se o usuário disser que já fez/comprou/separou algo que existe nas checklists, coloque o id desse item em completed_item_ids.
- tip: uma dica curta e útil quando agregar (prazo, onde comprar, cuidado comum). Senão null.
- urgent: true se precisa ser feito antes do embarque com pouco tempo, ou se esquecer impede a viagem (documentos, seguro, check-in, remédios).
- message: 1 a 3 frases orientando o que fazer primeiro, considerando quantos dias faltam.

MODO "next" — o usuário quer saber o que falta.
- Analise o que está pendente e os dias até o embarque. Em message, dê os próximos passos priorizados (até 5, em frases curtas, uma por linha começando com "• ").
- Em items, sugira só o que está FALTANDO nas checklists e é realmente relevante para esta viagem (destinos, época do ano, duração). No máximo 8. Pode ser lista vazia.
- completed_item_ids deve ser vazio neste modo.

Regras gerais: não invente fatos sobre a reserva do usuário; quando algo depender de regra externa que pode mudar (vistos, ETIAS, regras de bagagem), recomende conferir na fonte oficial. Seja conciso.`;

function buildUserMessage(input: Input): string {
  const { trip } = input;
  const lists = trip.lists.map(l =>
    `- [${l.id}] ${l.name}\n` + l.items.map(i => `    - (${i.id}) ${i.done ? '[x]' : '[ ]'} ${i.text}`).join('\n')
  ).join('\n');
  const days = trip.days.length
    ? trip.days.map(d => `- ${d.date}${d.title ? ' — ' + d.title : ''}${d.stops.length ? ': ' + d.stops.join(', ') : ''}`).join('\n')
    : '(sem roteiro ainda)';
  return `Hoje: ${trip.today}
Viagem: ${trip.name || 'sem nome'}
Destinos: ${trip.cities || 'não informados'}
Ida: ${trip.start || 'não informada'} · Volta: ${trip.end || 'não informada'}

Checklists (id entre colchetes; itens com id entre parênteses):
${lists || '(nenhuma)'}

Roteiro:
${days}

Modo: ${input.mode}
${input.mode === 'route' ? `O que o usuário escreveu:\n"""\n${input.text}\n"""` : 'O usuário pediu: "o que falta?"'}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!Deno.env.get('ANTHROPIC_API_KEY')) {
    return json({ error: 'ANTHROPIC_API_KEY não configurada na função' }, 500);
  }

  // verify_jwt também aceita a anon key pública, então confere se há usuário logado.
  const userRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  });
  if (!userRes.ok) return json({ error: 'Faça login para usar o assistente' }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body inválido' }, 400);
  }
  if (body && typeof body === 'object' && (body as { mode?: string }).mode === 'extract') {
    try {
      return await handleExtract(body);
    } catch (err) {
      return apiError(err);
    }
  }

  let input: Input;
  try {
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'Dados da viagem inválidos ou grandes demais' }, 400);
    input = parsed.data;
  } catch {
    return json({ error: 'Body inválido' }, 400);
  }
  if (input.mode === 'route' && !input.text.trim()) {
    return json({ error: 'Escreva o que você precisa fazer ou levar' }, 400);
  }

  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(OutputSchema) },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildUserMessage(input) }],
    });

    if (response.stop_reason === 'refusal') {
      return json({ error: 'O assistente não conseguiu responder a esse pedido. Tente reformular.' }, 422);
    }
    if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
      return json({ error: 'Resposta incompleta do assistente. Tente com menos itens de uma vez.' }, 502);
    }

    // Só aceita ids que existem de fato nas checklists enviadas
    const listIds = new Set(input.trip.lists.map(l => l.id));
    const itemIds = new Set(input.trip.lists.flatMap(l => l.items.map(i => i.id)));
    const out = response.parsed_output;
    return json({
      message: out.message,
      items: out.items
        .filter(i => i.text.trim())
        .map(i => ({
          ...i,
          list_id: i.list_id && listIds.has(i.list_id) ? i.list_id : null,
          new_list_name: i.list_id && listIds.has(i.list_id) ? null : (i.new_list_name || 'Outros'),
        })),
      completed_item_ids: input.mode === 'route' ? out.completed_item_ids.filter(id => itemIds.has(id)) : [],
    });
  } catch (err) {
    return apiError(err);
  }
});

function apiError(err: unknown) {
  if (err instanceof Anthropic.RateLimitError) {
    return json({ error: 'Muitas solicitações agora. Tente de novo em alguns segundos.' }, 429);
  } else if (err instanceof Anthropic.AuthenticationError) {
    return json({ error: 'Chave da Anthropic inválida na função' }, 500);
  } else if (err instanceof Anthropic.APIError) {
    return json({ error: `Anthropic ${err.status}: ${err.message.slice(0, 300)}` }, 502);
  }
  return json({ error: err instanceof Error ? err.message : 'Erro desconhecido' }, 500);
}
