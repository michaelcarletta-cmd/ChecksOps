
create or replace function public.normalize_payee_key(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]', '', 'g'), '')
$$;

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

  -- Carry forward property / payee mailing address from the most recent prior check on the same claim
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

  -- Carry forward payee contact email / phone by matching payee name on prior checks for the same claim
  update public.check_payees cp
     set contact_email = coalesce(cp.contact_email, prior.contact_email),
         contact_phone = coalesce(cp.contact_phone, prior.contact_phone)
    from lateral (
      select pp.contact_email, pp.contact_phone
        from public.check_payees pp
        join public.check_intake_items pc on pc.id = pp.check_id
       where pp.check_id <> p_check_id
         and pc.tenant_id is not distinct from v_check.tenant_id
         and public.normalize_payee_key(pp.payee_name) = public.normalize_payee_key(cp.payee_name)
         and (pp.contact_email is not null or pp.contact_phone is not null)
         and (
               (v_check.claim_id is not null and pc.claim_id = v_check.claim_id)
            or (v_claim is not null and (
                  lower(trim(coalesce(pc.detected_claim_number, ''))) = lower(v_claim)
               or lower(trim(coalesce(pc.freedom_claim_number, ''))) = lower(v_claim)))
             )
       order by pp.updated_at desc nulls last, pp.created_at desc nulls last
       limit 1
    ) prior
   where cp.check_id = p_check_id
     and (cp.contact_email is null or cp.contact_phone is null);
end;
$$;

create or replace function public.trg_check_contact_carryover()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_check_contact_carryover(new.id);
  return new;
end;
$$;

drop trigger if exists check_intake_contact_carryover on public.check_intake_items;
create trigger check_intake_contact_carryover
after insert or update of detected_claim_number, freedom_claim_number, claim_id
on public.check_intake_items
for each row
execute function public.trg_check_contact_carryover();

create or replace function public.trg_payee_contact_carryover()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.contact_email is null or new.contact_phone is null then
    perform public.apply_check_contact_carryover(new.check_id);
  end if;
  return new;
end;
$$;

drop trigger if exists check_payee_contact_carryover on public.check_payees;
create trigger check_payee_contact_carryover
after insert on public.check_payees
for each row
execute function public.trg_payee_contact_carryover();
