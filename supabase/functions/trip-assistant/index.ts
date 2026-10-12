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

  let input: Input;
  try {
    const parsed = InputSchema.safeParse(await req.json());
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
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: 'Muitas solicitações agora. Tente de novo em alguns segundos.' }, 429);
    } else if (err instanceof Anthropic.AuthenticationError) {
      return json({ error: 'Chave da Anthropic inválida na função' }, 500);
    } else if (err instanceof Anthropic.APIError) {
      return json({ error: `Anthropic ${err.status}: ${err.message.slice(0, 300)}` }, 502);
    }
    return json({ error: err instanceof Error ? err.message : 'Erro desconhecido' }, 500);
  }
});
