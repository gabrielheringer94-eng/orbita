-- Autorização do Google Agenda por usuário. Só a Edge Function google-calendar
-- (service role) lê e grava: RLS ligado e nenhuma policy para o cliente.
create table if not exists public.google_calendar_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);
alter table public.google_calendar_tokens enable row level security;
revoke all on public.google_calendar_tokens from anon, authenticated;
