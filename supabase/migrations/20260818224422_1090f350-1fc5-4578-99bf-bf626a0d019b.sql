
create or replace function public.ensure_partner_stakeholders(p_check_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_tenant uuid;
  v_share record;
  v_acct public.stakeholder_accounts%rowtype;
  v_result jsonb := '[]'::jsonb;
begin
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
    select * into v_acct
    from public.stakeholder_accounts
    where tenant_id = v_share.target_tenant_id
      and is_active = true
      and verification_status in ('verified','admin_override')
    order by is_partner_payout desc nulls last, is_primary desc, created_at asc
    limit 1;

    if v_acct.id is not null then
      insert into public.check_stakeholders (
        check_intake_item_id, stakeholder_account_id, tenant_id,
        added_via, partner_tenant_id, added_by
      ) values (
        p_check_id, v_acct.id, v_source_tenant, 'partner_share',
        v_share.target_tenant_id, coalesce(v_share.shared_by, auth.uid())
      )
      on conflict do nothing;
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'partner_tenant_id', v_share.target_tenant_id,
      'partner_name', v_share.target_name,
      'ready', v_acct.id is not null,
      'account', case when v_acct.id is null then null else jsonb_build_object(
        'id', v_acct.id,
        'nickname', coalesce(v_acct.nickname, v_share.target_name),
        'account_type', coalesce(v_acct.account_type, 'other'),
        'is_active', true,
        'is_primary', false,
        'verification_status', v_acct.verification_status,
        'provider', v_acct.provider,
        'provider_bank_name', v_acct.provider_bank_name,
        'provider_last_four', v_acct.provider_last_four,
        'provider_account_id', v_acct.provider_account_id,
        'provider_bank_account_id', v_acct.provider_bank_account_id
      ) end
    ));
    v_acct := null;
  end loop;

  return v_result;
end;
$$;

revoke all on function public.ensure_partner_stakeholders(uuid) from public;
grant execute on function public.ensure_partner_stakeholders(uuid) to authenticated;
