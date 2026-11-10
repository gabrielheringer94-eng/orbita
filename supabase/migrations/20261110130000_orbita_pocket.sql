-- Dados do Inglês (Pocket Phrasebook) em tabela própria, um documento por linha,
-- e cópia de segurança do estado completo antes da separação.
create table if not exists public.orbita_backup (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.orbita_backup enable row level security;
create policy "backup: users see own" on public.orbita_backup for select using (auth.uid() = user_id);

create table if not exists public.orbita_pocket (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  col text not null,
  doc_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, doc_id)
);
create index if not exists orbita_pocket_user_updated on public.orbita_pocket (user_id, updated_at);
alter table public.orbita_pocket enable row level security;
create policy "pocket: users see own" on public.orbita_pocket for select using (auth.uid() = user_id);
create policy "pocket: users insert own" on public.orbita_pocket for insert with check (auth.uid() = user_id);
create policy "pocket: users update own" on public.orbita_pocket for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "pocket: users delete own" on public.orbita_pocket for delete using (auth.uid() = user_id);
grant select, insert, update, delete on public.orbita_pocket to authenticated;
grant select on public.orbita_backup to authenticated;

create or replace function public.orbita_pocket_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger orbita_pocket_touch before update on public.orbita_pocket for each row execute function public.orbita_pocket_touch();
