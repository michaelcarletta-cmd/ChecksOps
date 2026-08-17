# Plan - Prevent Endorsement Duplication and Stalled Checks

Investigated the root cause of the Kalyan check issue where duplicate signatures were required, causing the check to stall. The duplication stemmed from multiple `check_payees` records triggering redundant `check_endorsements` entries without strict unique constraints.

## User Review Required

> [!IMPORTANT]
> This plan involves database schema changes (unique indexes and trigger updates). These changes will prevent future duplication but will not automatically merge existing duplicates on other checks. I will provide a separate cleanup script if requested.

- The new unique constraint will treat a payee as a duplicate if the name (case-insensitive) and check ID match. This is standard for insurance checks where one person should only sign once.

## Proposed Changes

### Database (Lovable Cloud)

#### Hardening `check_endorsements` table
- Add a unique index on `(check_id, COALESCE(payee_id, '00000000-0000-0000-0000-000000000000'), lower(trim(payee_name)))`.
- This ensures that for a specific check, a payee (linked by ID or name) can only have one endorsement record.

#### Hardening `tg_mirror_payee_to_endorsement` trigger
- Update the trigger function to handle conflicts gracefully.
- Instead of just checking for existence, it will use the new unique index to prevent duplicate inserts and ensure updates correctly target the existing record.

#### Hardening OCR commit logic
- Ensure `ocr_commit_results` correctly manages the lifecycle of payees to avoid orphaned endorsement records when OCR is re-run.

## Technical Details

### SQL Migration
```sql
-- 1. Create a robust unique index
CREATE UNIQUE INDEX IF NOT EXISTS check_endorsements_unique_payee_robust 
ON public.check_endorsements (check_id, COALESCE(payee_id, '00000000-0000-0000-0000-000000000000'), lower(trim(payee_name)));

-- 2. Update tg_mirror_payee_to_endorsement to be more defensive
CREATE OR REPLACE FUNCTION public.tg_mirror_payee_to_endorsement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant uuid;
  v_existing uuid;
  v_type text;
BEGIN
  -- Handle DELETE
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.check_endorsements
    WHERE check_id = OLD.check_id
      AND (payee_id = OLD.id
           OR (payee_id IS NULL AND lower(trim(payee_name)) = lower(trim(OLD.payee_name))))
      AND status NOT IN ('signed','waived');
    RETURN OLD;
  END IF;

  -- Resolve tenant
  v_tenant := NEW.tenant_id;
  IF v_tenant IS NULL THEN
    SELECT tenant_id INTO v_tenant FROM public.check_intake_items WHERE id = NEW.check_id;
  END IF;

  v_type := public.normalize_endorsement_payee_type(NEW.payee_type);

  -- UPSERT logic using the unique index
  INSERT INTO public.check_endorsements (
    check_id, tenant_id, payee_id, payee_name, payee_type,
    status, signature_method, contact_email, contact_phone, signed_at
  ) VALUES (
    NEW.check_id, v_tenant, NEW.id, NEW.payee_name, v_type,
    CASE
      WHEN NEW.endorsed_at IS NOT NULL THEN 'signed'
      WHEN NEW.endorsement_status IN ('signed','endorsed','complete','completed') THEN 'signed'
      WHEN NEW.endorsement_status = 'waived' THEN 'waived'
      ELSE 'pending'
    END,
    'portal', NEW.contact_email, NEW.contact_phone, NEW.endorsed_at
  )
  ON CONFLICT (check_id, COALESCE(payee_id, '00000000-0000-0000-0000-000000000000'), lower(trim(payee_name)))
  DO UPDATE SET
    payee_id = EXCLUDED.payee_id,
    payee_type = EXCLUDED.payee_type,
    contact_email = COALESCE(EXCLUDED.contact_email, check_endorsements.contact_email),
    contact_phone = COALESCE(EXCLUDED.contact_phone, check_endorsements.contact_phone),
    status = CASE 
      WHEN check_endorsements.status IN ('signed', 'waived') THEN check_endorsements.status
      ELSE EXCLUDED.status
    END,
    signed_at = COALESCE(check_endorsements.signed_at, EXCLUDED.signed_at),
    updated_at = now();

  RETURN NEW;
END;
$$;
```
