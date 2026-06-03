-- Histórico de versões de notas.
-- Cada save (com pelo menos 5min de intervalo da última versão da mesma nota)
-- adiciona uma linha aqui. Mantém os últimos 20 snapshots por nota.

create table if not exists public.note_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null,
  title text,
  body text not null,
  char_count integer generated always as (length(body)) stored,
  created_at timestamptz default now()
);

create index if not exists note_versions_user_note_idx
  on public.note_versions (user_id, note_id, created_at desc);

alter table public.note_versions enable row level security;

drop policy if exists "note_versions: users see own" on public.note_versions;
create policy "note_versions: users see own"
  on public.note_versions for select
  using (auth.uid() = user_id);

drop policy if exists "note_versions: users insert own" on public.note_versions;
create policy "note_versions: users insert own"
  on public.note_versions for insert
  with check (auth.uid() = user_id);

drop policy if exists "note_versions: users delete own" on public.note_versions;
create policy "note_versions: users delete own"
  on public.note_versions for delete
  using (auth.uid() = user_id);
