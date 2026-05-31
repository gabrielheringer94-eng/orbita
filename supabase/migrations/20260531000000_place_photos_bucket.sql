-- Bucket pra fotos de visitas a lugares
-- Path schema: {user_id}/{place_id}/{visit_id}-{timestamp}.jpg
-- Bucket é privado; acesso via signed URLs OU policies que vinculam o path ao user_id autenticado.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'place-photos',
  'place-photos',
  true,                                          -- público pra leitura via URL direta (mais simples no client)
  5242880,                                       -- 5MB por arquivo
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

-- RLS: cada usuário só lê/escreve dentro da sua própria pasta (primeiro segmento do path = user_id)
drop policy if exists "place-photos: usuários veem suas próprias fotos" on storage.objects;
create policy "place-photos: usuários veem suas próprias fotos"
  on storage.objects for select
  using (
    bucket_id = 'place-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "place-photos: usuários inserem na própria pasta" on storage.objects;
create policy "place-photos: usuários inserem na própria pasta"
  on storage.objects for insert
  with check (
    bucket_id = 'place-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "place-photos: usuários atualizam suas fotos" on storage.objects;
create policy "place-photos: usuários atualizam suas fotos"
  on storage.objects for update
  using (
    bucket_id = 'place-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "place-photos: usuários deletam suas fotos" on storage.objects;
create policy "place-photos: usuários deletam suas fotos"
  on storage.objects for delete
  using (
    bucket_id = 'place-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
