// Edge Function: google-calendar
// Ponte entre o Órbita e o Google Agenda do usuário logado.
// Body: { action: 'connect' | 'status' | 'disconnect' | 'list' | 'create', ... }
//   connect    { refresh_token }                       guarda a autorização
//   status     {}                                      -> { connected }
//   disconnect {}                                      revoga e apaga
//   list       { timeMin, timeMax }  (ISO)             -> { events: [...] }
//   create     { title, startDate, endDate, start, end, allDay?, timeZone? } -> { event }
// Secrets: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (os mesmos do provedor Google do Supabase Auth).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET');
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

async function getRefreshToken(userId: string): Promise<string | null> {
  const r = await db(`google_calendar_tokens?user_id=eq.${userId}&select=refresh_token`);
  if (!r.ok) throw new Error(`Banco: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0]?.refresh_token ?? null;
}

async function deleteToken(userId: string) {
  await db(`google_calendar_tokens?user_id=eq.${userId}`, { method: 'DELETE' });
}

class NeedsReconnect extends Error {}

async function accessToken(userId: string): Promise<string> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET não configurados na função');
  const refresh = await getRefreshToken(userId);
  if (!refresh) throw new NeedsReconnect('Google Agenda não conectado');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const data = await r.json();
  if (!r.ok) {
    if (data?.error === 'invalid_grant') { await deleteToken(userId); throw new NeedsReconnect('A autorização do Google expirou. Conecte de novo.'); }
    throw new Error(`Google token: ${data?.error_description || data?.error || r.status}`);
  }
  return data.access_token;
}

function mapEvent(e: Record<string, any>) {
  const allDay = !!e.start?.date;
  return {
    id: e.id,
    title: e.summary || '(sem título)',
    allDay,
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    link: e.htmlLink ?? null,
    location: e.location ?? null,
  };
}

function addDay(iso: string) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: req.headers.get('Authorization') ?? '', apikey: ANON_KEY },
  });
  if (!userRes.ok) return json({ error: 'Faça login no Órbita' }, 401);
  const user = await userRes.json();
  const userId: string = user?.id;
  if (!userId) return json({ error: 'Faça login no Órbita' }, 401);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'Body inválido' }, 400); }

  try {
    switch (body.action) {
      case 'connect': {
        const token = String(body.refresh_token ?? '').trim();
        if (!token) return json({ error: 'refresh_token ausente' }, 400);
        const r = await db('google_calendar_tokens?on_conflict=user_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ user_id: userId, refresh_token: token, updated_at: new Date().toISOString() }),
        });
        if (!r.ok) throw new Error(`Banco: ${r.status} ${await r.text()}`);
        return json({ connected: true });
      }
      case 'status':
        return json({ connected: !!(await getRefreshToken(userId)) });
      case 'disconnect': {
        const refresh = await getRefreshToken(userId);
        if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
        await deleteToken(userId);
        return json({ connected: false });
      }
      case 'list': {
        const at = await accessToken(userId);
        const qs = new URLSearchParams({
          timeMin: String(body.timeMin), timeMax: String(body.timeMax),
          singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
        });
        const r = await fetch(`${CAL}?${qs}`, { headers: { Authorization: `Bearer ${at}` } });
        const data = await r.json();
        if (!r.ok) throw new Error(`Google Agenda: ${data?.error?.message || r.status}`);
        const events = (data.items ?? []).filter((e: any) => e.status !== 'cancelled').map(mapEvent);
        return json({ events });
      }
      case 'create': {
        const title = String(body.title ?? '').trim();
        const startDate = String(body.startDate ?? '');
        const endDate = String(body.endDate || startDate);
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return json({ error: 'Título e data são obrigatórios' }, 400);
        const tz = String(body.timeZone || 'America/Sao_Paulo');
        const allDay = !!body.allDay || !body.start;
        const event = allDay
          ? { summary: title, start: { date: startDate }, end: { date: addDay(endDate) } }
          : {
              summary: title,
              start: { dateTime: `${startDate}T${body.start}:00`, timeZone: tz },
              end: { dateTime: `${endDate}T${body.end || body.start}:00`, timeZone: tz },
            };
        const at = await accessToken(userId);
        const r = await fetch(CAL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(`Google Agenda: ${data?.error?.message || r.status}`);
        return json({ event: mapEvent(data) });
      }
      default:
        return json({ error: 'Ação inválida' }, 400);
    }
  } catch (err) {
    if (err instanceof NeedsReconnect) return json({ error: err.message, needsReconnect: true }, 200);
    return json({ error: err instanceof Error ? err.message : 'Erro desconhecido' }, 500);
  }
});
