
create or replace function public.ensure_partner_stakeholders(p_check_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_tenant uuid;
  v_share record;
  v_acct uuid;
  v_result jsonb := '[]'::jsonb;
begin
  -- caller must belong to a tenant that can see this check
  select tenant_id into v_source_tenant from public.check_intake_items where id = p_check_id;
  if v_source_tenant is null then
    return v_result;
  end if;
  if not exists (
    select 1 from public.tenant_users tu
    where tu.user_id = auth.uid() and tu.tenant_id = v_source_tenant
  ) then
    return v_result;
  end if;

  for v_share in
    select sc.target_tenant_id, t.name as target_name, sc.shared_by
    from public.shared_checks sc
    join public.tenants t on t.id = sc.target_tenant_id
    where sc.check_id = p_check_id and sc.revoked_at is null
  loop
    v_acct := null;

    select id into v_acct
    from public.stakeholder_accounts
    where tenant_id = v_share.target_tenant_id
      and is_active = true
      and verification_status in ('verified','admin_override')
    order by is_partner_payout desc nulls last, is_primary desc, created_at asc
    limit 1;

    if v_acct is not null then
      insert into public.check_stakeholders (
        check_intake_item_id, stakeholder_account_id, tenant_id,
        added_via, partner_tenant_id, added_by
      ) values (
        p_check_id, v_acct, v_source_tenant, 'partner_share',
        v_share.target_tenant_id, coalesce(v_share.shared_by, auth.uid())
      )
      on conflict do nothing;
    end if;

    v_result := v_result || jsonb_build_object(
      'partner_tenant_id', v_share.target_tenant_id,
      'partner_name', v_share.target_name,
      'stakeholder_account_id', v_acct,
      'ready', v_acct is not null
    );
  end loop;

  return v_result;
end;
$$;

revoke all on function public.ensure_partner_stakeholders(uuid) from public;
grant execute on function public.ensure_partner_stakeholders(uuid) to authenticated;
