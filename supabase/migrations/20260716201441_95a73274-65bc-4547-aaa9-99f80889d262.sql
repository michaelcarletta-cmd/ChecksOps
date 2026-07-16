do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Mortgage agents can upload mortgage ops check documents'
  ) then
    create policy "Mortgage agents can upload mortgage ops check documents"
    on storage.objects
    for insert
    to authenticated
    with check (
      bucket_id = 'claim-files'
      and (storage.foldername(name))[1] = 'checks'
      and (storage.foldername(name))[3] = 'mortgage-ops'
      and public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
      and public.mortgage_agent_can_view_check(((storage.foldername(name))[2])::uuid)
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Mortgage agents can view mortgage ops check documents'
  ) then
    create policy "Mortgage agents can view mortgage ops check documents"
    on storage.objects
    for select
    to authenticated
    using (
      bucket_id = 'claim-files'
      and (storage.foldername(name))[1] = 'checks'
      and (storage.foldername(name))[3] = 'mortgage-ops'
      and public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
      and public.mortgage_agent_can_view_check(((storage.foldername(name))[2])::uuid)
    );
  end if;
end $$;