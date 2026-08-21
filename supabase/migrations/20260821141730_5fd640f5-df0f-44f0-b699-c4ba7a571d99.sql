
create or replace function public.apply_check_contact_carryover(p_check_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check public.check_intake_items%rowtype;
  v_claim text;
begin
  select * into v_check from public.check_intake_items where id = p_check_id;
  if not found then
    return;
  end if;

  v_claim := nullif(trim(coalesce(v_check.detected_claim_number, v_check.freedom_claim_number, '')), '');
  if v_claim is null and v_check.claim_id is null then
    return;
  end if;

  if v_check.property_address is null or v_check.payee_address is null then
    update public.check_intake_items c
       set property_address = coalesce(c.property_address, prior.property_address),
           payee_address    = coalesce(c.payee_address, prior.payee_address)
      from (
        select p.property_address, p.payee_address
          from public.check_intake_items p
         where p.id <> p_check_id
           and p.tenant_id is not distinct from v_check.tenant_id
           and (
                 (v_check.claim_id is not null and p.claim_id = v_check.claim_id)
              or (v_claim is not null and (
                    lower(trim(coalesce(p.detected_claim_number, ''))) = lower(v_claim)
                 or lower(trim(coalesce(p.freedom_claim_number, ''))) = lower(v_claim)))
               )
           and (p.property_address is not null or p.payee_address is not null)
         order by p.created_at desc
         limit 1
      ) prior
     where c.id = p_check_id;
  end if;

  update public.check_payees cp
     set contact_email = coalesce(cp.contact_email, (
           select pp.contact_email
             from public.check_payees pp
             join public.check_intake_items pc on pc.id = pp.check_id
            where pp.check_id <> p_check_id
              and pc.tenant_id is not distinct from v_check.tenant_id
              and public.normalize_payee_key(pp.payee_name) = public.normalize_payee_key(cp.payee_name)
              and pp.contact_email is not null
              and (
                    (v_check.claim_id is not null and pc.claim_id = v_check.claim_id)
                 or (v_claim is not null and (
                       lower(trim(coalesce(pc.detected_claim_number, ''))) = lower(v_claim)
                    or lower(trim(coalesce(pc.freedom_claim_number, ''))) = lower(v_claim)))
                  )
            order by pp.updated_at desc nulls last, pp.created_at desc nulls last
            limit 1
         )),
         contact_phone = coalesce(cp.contact_phone, (
           select pp.contact_phone
             from public.check_payees pp
             join public.check_intake_items pc on pc.id = pp.check_id
            where pp.check_id <> p_check_id
              and pc.tenant_id is not distinct from v_check.tenant_id
              and public.normalize_payee_key(pp.payee_name) = public.normalize_payee_key(cp.payee_name)
              and pp.contact_phone is not null
              and (
                    (v_check.claim_id is not null and pc.claim_id = v_check.claim_id)
                 or (v_claim is not null and (
                       lower(trim(coalesce(pc.detected_claim_number, ''))) = lower(v_claim)
                    or lower(trim(coalesce(pc.freedom_claim_number, ''))) = lower(v_claim)))
                  )
            order by pp.updated_at desc nulls last, pp.created_at desc nulls last
            limit 1
         ))
   where cp.check_id = p_check_id
     and (cp.contact_email is null or cp.contact_phone is null);
end;
$$;

revoke all on function public.apply_check_contact_carryover(uuid) from public, anon, authenticated;

do $$
declare r record;
begin
  for r in
    select c.id
      from public.check_intake_items c
     where coalesce(nullif(trim(c.detected_claim_number),''), nullif(trim(c.freedom_claim_number),'')) is not null
        or c.claim_id is not null
  loop
    perform public.apply_check_contact_carryover(r.id);
  end loop;
end $$;
