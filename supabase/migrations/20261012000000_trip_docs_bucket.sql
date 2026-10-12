-- Bucket privado para documentos da viagem (passaporte, cartões de embarque, apólices)
-- Path schema: {user_id}/trip/{file_id}-{nome}
-- Privado: leitura só via signed URL, e só dentro da pasta do próprio usuário.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'trip-docs',
  'trip-docs',
  false,
  10485760,                                      -- 10MB por arquivo
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;

drop policy if exists "trip-docs: usuários veem seus documentos" on storage.objects;
create policy "trip-docs: usuários veem seus documentos"
  on storage.objects for select
  using (
    bucket_id = 'trip-docs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "trip-docs: usuários inserem na própria pasta" on storage.objects;
create policy "trip-docs: usuários inserem na própria pasta"
  on storage.objects for insert
  with check (
    bucket_id = 'trip-docs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "trip-docs: usuários deletam seus documentos" on storage.objects;
create policy "trip-docs: usuários deletam seus documentos"
  on storage.objects for delete
  using (
    bucket_id = 'trip-docs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
