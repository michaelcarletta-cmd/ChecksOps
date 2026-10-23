-- SQL 113: production payee setup. A homeowner or a Settings stakeholder (individual or
-- business) that a tenant pays is set up as a Moov payee through a secure link, without a
-- ChecksOps login, and becomes payable only once Moov verifies it.
--
-- Why:
-- 1) The Moov recipient flow exists only for sandbox (providers/parity/moov-onboard.mjs). Its
--    rows are written by the browser or a tenant session under RLS, the /pay-setup link has no
--    working anonymous path on AWS (it needs a tenant identity), its handlers write
--    external_payment_recipients columns that no migration creates (tos_accepted_at,
--    disconnected_at), and the stakeholder row it inserts uses origin 'provider_recipient',
--    which the stakeholder_accounts_origin_check (supabase migration 20260728110453) refuses.
-- 2) public.external_payment_recipients' grants came from a supabase migration that the AWS
--    copy restored without ACLs; no aws/workflows/sql migration grants it to checksops, so
--    PostgreSQL refuses checksops before any policy is evaluated (as SQL 104, 105 and 112 found
--    for other tables). Whether production already holds the grant is what the read-only
--    inspect of this migration records.
--
-- What this file does:
-- a) public.external_payment_recipients: ADD COLUMN IF NOT EXISTS for the payee state the
--    production flow records: tos_accepted_at, identity_submitted_at, bank_verified_at,
--    verified_at, disconnected_at (timestamptz), provider_bank_account_id (text),
--    setup_attempts (integer NOT NULL DEFAULT 0), and, where an older copy lacks them,
--    stakeholder_account_id (uuid), provider_bank_name, provider_last_four (text) and
--    bank_linked_at (timestamptz). No column is dropped, renamed or retyped. No identity
--    number, bank account number or routing number is ever stored: the SSN or EIN goes to Moov
--    only, and only the bank's name and last four digits are kept.
-- b) stakeholder_accounts_origin_check: adds 'provider_recipient' to the four values supabase
--    migration 20260728110453 allows (tenant_owned, partner_shared, homeowner_link,
--    provider_connected). Refuses (55000 sql113_origin_check_unexpected) when the live check is
--    anything other than those four values, so no other live value is ever dropped; a check
--    that already allows provider_recipient is left as it is.
-- c) GRANT SELECT ON public.external_payment_recipients TO checksops, authenticated, so a
--    tenant member can list its payees under the existing SELECT policy
--    (aws_select_external_payment_recipients, aws/rls/sql/12). No INSERT, UPDATE or DELETE
--    grant: every write goes through the functions below. No PUBLIC, no anon.
-- d) Six SECURITY DEFINER functions (VOLATILE, search_path = public, owned by the applying
--    login like the other aws/workflows/sql DEFINER functions; EXECUTE revoked from PUBLIC and
--    granted to checksops only). Tenant-side functions check that auth.uid() (the
--    application user the API set) is a member of the tenant (aws_user_tenant_ids()); public
--    functions are keyed by the secure link token alone; status functions are called by the
--    API after it has read the payee's state from Moov.
--      aws_payee_create(...)         tenant member: one external_payment_recipients row and
--                                    its stakeholder_accounts row (origin provider_recipient,
--                                    verification_status pending), in one call; a replay with
--                                    the same recipient id returns the same rows.
--      aws_payee_reissue_link(...)   tenant member: a new link token for a payee that is not
--                                    verified or disconnected.
--      aws_payee_disconnect(...)     tenant member: the payee can no longer be paid (stakeholder
--                                    inactive, link closed, bank methods disconnected).
--      aws_public_payee_by_token(_token)        the payee's own setup state, no PII.
--      aws_public_payee_record(_token, _event, _data)  one setup step: tos_accepted,
--                                    identity_submitted, bank_linked, bank_verified.
--      aws_payee_apply_status(_environment, _provider_account_id, _status)  Moov's verdict:
--                                    verified (only after terms, identity and a verified bank),
--                                    pending_review or failed.
--    A payee becomes payable (stakeholder verification_status 'verified' with its Moov account
--    and bank ids) only through aws_payee_apply_status('verified'). Nothing here moves money.
--
-- Not changed: no policy, no RLS flag, no other table's columns, no other grant, no existing
-- function, no row of another tenant.
--
-- Refuses to run (55000 sql113_prerequisite_missing) without the tables and columns the
-- functions use and role checksops, and (55000 sql113_definer_cannot_write) unless the
-- applying login owns public.external_payment_recipients, public.stakeholder_accounts and
-- public.payment_provider_methods without FORCE ROW LEVEL SECURITY (or is a superuser or
-- BYPASSRLS).
--
-- Transactions: no BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: ADD COLUMN IF NOT EXISTS, the origin check is replaced only when it lacks
-- provider_recipient, GRANT of a held privilege is a no-op, and the functions are CREATE OR
-- REPLACE.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $sql113_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.external_payment_recipients', to_regclass('public.external_payment_recipients')::oid),
      ('public.stakeholder_accounts', to_regclass('public.stakeholder_accounts')::oid),
      ('public.payment_provider_methods', to_regclass('public.payment_provider_methods')::oid),
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('function public.aws_user_tenant_ids()', to_regprocedure('public.aws_user_tenant_ids()')::oid),
      ('function auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('external_payment_recipients', 'id'), ('external_payment_recipients', 'tenant_id'),
        ('external_payment_recipients', 'provider'), ('external_payment_recipients', 'environment'),
        ('external_payment_recipients', 'display_name'), ('external_payment_recipients', 'email'),
        ('external_payment_recipients', 'recipient_type'), ('external_payment_recipients', 'relationship'),
        ('external_payment_recipients', 'provider_account_id'), ('external_payment_recipients', 'onboarding_status'),
        ('external_payment_recipients', 'secure_token'), ('external_payment_recipients', 'token_expires_at'),
        ('external_payment_recipients', 'token_used_at'), ('external_payment_recipients', 'claim_id'),
        ('external_payment_recipients', 'check_id'), ('external_payment_recipients', 'created_by'),
        ('external_payment_recipients', 'updated_at'),
        ('stakeholder_accounts', 'id'), ('stakeholder_accounts', 'tenant_id'),
        ('stakeholder_accounts', 'created_by'), ('stakeholder_accounts', 'nickname'),
        ('stakeholder_accounts', 'custname'), ('stakeholder_accounts', 'account_type'),
        ('stakeholder_accounts', 'origin'), ('stakeholder_accounts', 'is_active'),
        ('stakeholder_accounts', 'is_primary'), ('stakeholder_accounts', 'is_partner_payout'),
        ('stakeholder_accounts', 'verification_status'), ('stakeholder_accounts', 'verification_source'),
        ('stakeholder_accounts', 'verification_recipient_email'), ('stakeholder_accounts', 'verified_at'),
        ('stakeholder_accounts', 'verification_completed_at'), ('stakeholder_accounts', 'homeowner_email'),
        ('stakeholder_accounts', 'homeowner_name'), ('stakeholder_accounts', 'provider'),
        ('stakeholder_accounts', 'provider_environment'), ('stakeholder_accounts', 'provider_account_id'),
        ('stakeholder_accounts', 'provider_bank_account_id'), ('stakeholder_accounts', 'provider_bank_name'),
        ('stakeholder_accounts', 'provider_last_four'), ('stakeholder_accounts', 'updated_at'),
        ('payment_provider_methods', 'id'), ('payment_provider_methods', 'tenant_id'),
        ('payment_provider_methods', 'external_recipient_id'), ('payment_provider_methods', 'provider'),
        ('payment_provider_methods', 'environment'), ('payment_provider_methods', 'provider_account_id'),
        ('payment_provider_methods', 'provider_bank_account_id'), ('payment_provider_methods', 'bank_name'),
        ('payment_provider_methods', 'account_type'), ('payment_provider_methods', 'last_four'),
        ('payment_provider_methods', 'holder_name'), ('payment_provider_methods', 'verification_status'),
        ('payment_provider_methods', 'connection_status'), ('payment_provider_methods', 'can_receive'),
        ('payment_provider_methods', 'can_send'), ('payment_provider_methods', 'connected_at'),
        ('payment_provider_methods', 'disconnected_at'), ('payment_provider_methods', 'updated_at'),
        ('tenants', 'id'), ('tenants', 'name'),
        ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql113_prerequisite_missing: SQL 113 needs the payee tables; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.external_payment_recipients'::regclass,
                    'public.stakeholder_accounts'::regclass,
                    'public.payment_provider_methods'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql113_definer_cannot_write: the applying login must own public.external_payment_recipients, public.stakeholder_accounts and public.payment_provider_methods (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql113_prereq$;

-- a) Payee state columns (no PII).
ALTER TABLE public.external_payment_recipients
  ADD COLUMN IF NOT EXISTS stakeholder_account_id uuid,
  ADD COLUMN IF NOT EXISTS provider_bank_name text,
  ADD COLUMN IF NOT EXISTS provider_last_four text,
  ADD COLUMN IF NOT EXISTS bank_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_bank_account_id text,
  ADD COLUMN IF NOT EXISTS tos_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS bank_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS setup_attempts integer NOT NULL DEFAULT 0;

-- b) Allow payee stakeholder rows.
DO $sql113_origin$
DECLARE
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.stakeholder_accounts'::regclass
    AND c.conname = 'stakeholder_accounts_origin_check';

  IF v_def IS NOT NULL AND position('''provider_recipient''' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF v_def IS NULL
     OR v_def <> 'CHECK ((origin = ANY (ARRAY[''tenant_owned''::text, ''partner_shared''::text, ''homeowner_link''::text, ''provider_connected''::text])))' THEN
    RAISE EXCEPTION 'sql113_origin_check_unexpected: stakeholder_accounts_origin_check is %', COALESCE(v_def, 'absent')
      USING ERRCODE = '55000';
  END IF;

  ALTER TABLE public.stakeholder_accounts DROP CONSTRAINT stakeholder_accounts_origin_check;
  ALTER TABLE public.stakeholder_accounts
    ADD CONSTRAINT stakeholder_accounts_origin_check
    CHECK (origin = ANY (ARRAY['tenant_owned'::text, 'partner_shared'::text, 'homeowner_link'::text,
                               'provider_connected'::text, 'provider_recipient'::text]));
END
$sql113_origin$;

-- c) Tenant members list their payees under the existing SELECT policy.
GRANT SELECT ON TABLE public.external_payment_recipients TO checksops;
DO $sql113_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON TABLE public.external_payment_recipients TO authenticated;
  ELSE
    RAISE NOTICE 'SQL 113: role authenticated absent; skipped its grant';
  END IF;
END
$sql113_grant$;

-- d) Writers.

-- Tenant member: create a payee and its stakeholder row.
CREATE OR REPLACE FUNCTION public.aws_payee_create(
  _recipient_id uuid,
  _tenant_id uuid,
  _display_name text,
  _email text,
  _recipient_type text,
  _relationship text,
  _environment text,
  _provider_account_id text,
  _token text,
  _token_expires_at timestamptz,
  _claim_id uuid,
  _check_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name text := left(trim(COALESCE(_display_name, '')), 200);
  v_email text := lower(trim(COALESCE(_email, '')));
  v_type text := lower(trim(COALESCE(_recipient_type, '')));
  v_rel text := lower(trim(COALESCE(_relationship, '')));
  v_env text := lower(trim(COALESCE(_environment, '')));
  v_acct text := trim(COALESCE(_provider_account_id, ''));
  v_token text := trim(COALESCE(_token, ''));
  existing public.external_payment_recipients%ROWTYPE;
  v_stakeholder uuid;
BEGIN
  IF v_actor IS NULL OR _tenant_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.aws_user_tenant_ids() t WHERE t = _tenant_id) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF _recipient_id IS NULL THEN RETURN jsonb_build_object('error', 'invalid_recipient_id'); END IF;
  IF v_name = '' THEN RETURN jsonb_build_object('error', 'invalid_name'); END IF;
  IF length(v_email) > 320 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('error', 'invalid_email');
  END IF;
  IF v_type NOT IN ('individual', 'business') THEN RETURN jsonb_build_object('error', 'invalid_type'); END IF;
  IF v_rel NOT IN ('operating', 'vendor', 'subcontractor', 'overhead', 'insured', 'contractor',
                   'supplier', 'sales_rep', 'homeowner', 'other') THEN
    v_rel := 'other';
  END IF;
  IF v_env NOT IN ('sandbox', 'production') THEN RETURN jsonb_build_object('error', 'invalid_environment'); END IF;
  IF v_acct !~ '^[A-Za-z0-9-]{8,64}$' THEN RETURN jsonb_build_object('error', 'invalid_provider_account'); END IF;
  IF length(v_token) < 32 OR v_token !~ '^[A-Za-z0-9_-]+$' THEN RETURN jsonb_build_object('error', 'invalid_token'); END IF;
  IF _token_expires_at IS NULL OR _token_expires_at <= now() OR _token_expires_at > now() + interval '30 days' THEN
    RETURN jsonb_build_object('error', 'invalid_expiry');
  END IF;

  SELECT * INTO existing FROM public.external_payment_recipients WHERE id = _recipient_id FOR UPDATE;
  IF FOUND THEN
    IF existing.tenant_id <> _tenant_id OR existing.provider_account_id IS DISTINCT FROM v_acct THEN
      RETURN jsonb_build_object('error', 'conflict');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'recipient_id', existing.id,
                              'stakeholder_account_id', existing.stakeholder_account_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.external_payment_recipients
              WHERE provider = 'moov' AND environment = v_env AND provider_account_id = v_acct) THEN
    RETURN jsonb_build_object('error', 'conflict');
  END IF;

  INSERT INTO public.stakeholder_accounts (
    tenant_id, created_by, nickname, custname, account_type, origin,
    is_active, is_primary, is_partner_payout,
    verification_status, verification_source, verification_recipient_email,
    homeowner_email, homeowner_name,
    provider, provider_environment, provider_account_id
  ) VALUES (
    _tenant_id, v_actor, v_name, v_name, v_rel, 'provider_recipient',
    true, false, false,
    'pending', 'moov', v_email,
    CASE WHEN v_rel = 'homeowner' THEN v_email END, CASE WHEN v_rel = 'homeowner' THEN v_name END,
    'moov', v_env, v_acct
  )
  RETURNING id INTO v_stakeholder;

  INSERT INTO public.external_payment_recipients (
    id, tenant_id, provider, environment, display_name, email, recipient_type, relationship,
    provider_account_id, onboarding_status, secure_token, token_expires_at, claim_id, check_id,
    created_by, stakeholder_account_id
  ) VALUES (
    _recipient_id, _tenant_id, 'moov', v_env, v_name, v_email, v_type, v_rel,
    v_acct, 'invited', v_token, _token_expires_at, _claim_id, _check_id,
    v_actor, v_stakeholder
  );

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'recipient_id', _recipient_id,
                            'stakeholder_account_id', v_stakeholder);
END
$$;

-- Tenant member: a new link for a payee still setting up.
CREATE OR REPLACE FUNCTION public.aws_payee_reissue_link(
  _recipient_id uuid,
  _token text,
  _token_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.external_payment_recipients%ROWTYPE;
  v_token text := trim(COALESCE(_token, ''));
BEGIN
  SELECT * INTO rec FROM public.external_payment_recipients WHERE id = _recipient_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.aws_user_tenant_ids() t WHERE t = rec.tenant_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF rec.disconnected_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'disconnected'); END IF;
  IF rec.verified_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_verified'); END IF;
  IF length(v_token) < 32 OR v_token !~ '^[A-Za-z0-9_-]+$' THEN RETURN jsonb_build_object('error', 'invalid_token'); END IF;
  IF _token_expires_at IS NULL OR _token_expires_at <= now() OR _token_expires_at > now() + interval '30 days' THEN
    RETURN jsonb_build_object('error', 'invalid_expiry');
  END IF;

  UPDATE public.external_payment_recipients
     SET secure_token = v_token, token_expires_at = _token_expires_at, setup_attempts = 0, updated_at = now()
   WHERE id = rec.id;
  RETURN jsonb_build_object('ok', true, 'recipient_id', rec.id, 'email', rec.email,
                            'display_name', rec.display_name, 'tenant_id', rec.tenant_id);
END
$$;

-- Tenant member: stop paying a payee.
CREATE OR REPLACE FUNCTION public.aws_payee_disconnect(_recipient_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.external_payment_recipients%ROWTYPE;
BEGIN
  SELECT * INTO rec FROM public.external_payment_recipients WHERE id = _recipient_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.aws_user_tenant_ids() t WHERE t = rec.tenant_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF rec.disconnected_at IS NULL THEN
    UPDATE public.external_payment_recipients
       SET disconnected_at = now(), onboarding_status = 'disconnected', secure_token = NULL,
           token_expires_at = now(), updated_at = now()
     WHERE id = rec.id;
    UPDATE public.stakeholder_accounts
       SET is_active = false, updated_at = now()
     WHERE id = rec.stakeholder_account_id AND tenant_id = rec.tenant_id;
    UPDATE public.payment_provider_methods
       SET connection_status = 'disconnected', disconnected_at = now(), updated_at = now()
     WHERE external_recipient_id = rec.id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'recipient_id', rec.id, 'stakeholder_account_id', rec.stakeholder_account_id,
                            'provider_account_id', rec.provider_account_id, 'environment', rec.environment);
END
$$;

-- Public (link token): the payee's own setup state. No identity data is stored anywhere.
CREATE OR REPLACE FUNCTION public.aws_public_payee_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.external_payment_recipients%ROWTYPE;
  v_token text := trim(COALESCE(_token, ''));
  v_tenant_name text;
BEGIN
  IF length(v_token) < 32 THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO rec FROM public.external_payment_recipients WHERE secure_token = v_token LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF rec.disconnected_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'disconnected'); END IF;
  IF rec.token_expires_at IS NULL OR rec.token_expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;
  SELECT name INTO v_tenant_name FROM public.tenants WHERE id = rec.tenant_id;
  RETURN jsonb_build_object(
    'ok', true,
    'recipient_id', rec.id,
    'tenant_id', rec.tenant_id,
    'tenant_name', v_tenant_name,
    'display_name', rec.display_name,
    'email', rec.email,
    'recipient_type', rec.recipient_type,
    'relationship', rec.relationship,
    'environment', rec.environment,
    'provider_account_id', rec.provider_account_id,
    'onboarding_status', rec.onboarding_status,
    'tos_accepted_at', rec.tos_accepted_at,
    'identity_submitted_at', rec.identity_submitted_at,
    'provider_bank_account_id', rec.provider_bank_account_id,
    'provider_bank_name', rec.provider_bank_name,
    'provider_last_four', rec.provider_last_four,
    'bank_linked_at', rec.bank_linked_at,
    'bank_verified_at', rec.bank_verified_at,
    'verified_at', rec.verified_at,
    'setup_attempts', rec.setup_attempts
  );
END
$$;

-- Public (link token): record one setup step the API has completed with Moov.
CREATE OR REPLACE FUNCTION public.aws_public_payee_record(_token text, _event text, _data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.external_payment_recipients%ROWTYPE;
  v_token text := trim(COALESCE(_token, ''));
  v_event text := lower(trim(COALESCE(_event, '')));
  v_data jsonb := COALESCE(_data, '{}'::jsonb);
  v_bank_id text;
  v_bank_name text;
  v_last_four text;
  v_account_type text;
  v_holder text;
  v_method uuid;
BEGIN
  IF length(v_token) < 32 THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO rec FROM public.external_payment_recipients WHERE secure_token = v_token LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF rec.disconnected_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'disconnected'); END IF;
  IF rec.token_expires_at IS NULL OR rec.token_expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;
  IF rec.setup_attempts >= 60 THEN RETURN jsonb_build_object('error', 'rate_limited'); END IF;

  UPDATE public.external_payment_recipients
     SET setup_attempts = setup_attempts + 1, updated_at = now()
   WHERE id = rec.id;

  IF v_event = 'tos_accepted' THEN
    UPDATE public.external_payment_recipients
       SET tos_accepted_at = COALESCE(tos_accepted_at, now()),
           onboarding_status = CASE WHEN onboarding_status IN ('invited', 'not_started') THEN 'tos_accepted' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSIF v_event = 'identity_submitted' THEN
    UPDATE public.external_payment_recipients
       SET identity_submitted_at = now(),
           onboarding_status = CASE WHEN onboarding_status IN ('invited', 'not_started', 'tos_accepted', 'failed')
                                    THEN 'identity_submitted' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSIF v_event = 'bank_linked' THEN
    v_bank_id := trim(COALESCE(v_data->>'provider_bank_account_id', ''));
    v_bank_name := NULLIF(left(trim(COALESCE(v_data->>'bank_name', '')), 120), '');
    v_last_four := trim(COALESCE(v_data->>'last_four', ''));
    v_account_type := lower(trim(COALESCE(v_data->>'account_type', '')));
    v_holder := NULLIF(left(trim(COALESCE(v_data->>'holder_name', '')), 200), '');
    IF v_bank_id !~ '^[A-Za-z0-9-]{8,64}$' THEN RETURN jsonb_build_object('error', 'invalid_bank_account'); END IF;
    IF v_last_four !~ '^[0-9]{4}$' THEN RETURN jsonb_build_object('error', 'invalid_last_four'); END IF;
    IF v_account_type NOT IN ('checking', 'savings') THEN RETURN jsonb_build_object('error', 'invalid_account_type'); END IF;

    -- One active bank per payee: a new bank replaces the earlier one.
    UPDATE public.payment_provider_methods
       SET connection_status = 'disconnected', disconnected_at = now(), updated_at = now()
     WHERE external_recipient_id = rec.id AND provider_bank_account_id <> v_bank_id
       AND connection_status <> 'disconnected';

    SELECT id INTO v_method FROM public.payment_provider_methods
     WHERE provider = 'moov' AND environment = rec.environment AND provider_bank_account_id = v_bank_id
     LIMIT 1;
    IF v_method IS NULL THEN
      INSERT INTO public.payment_provider_methods (
        tenant_id, external_recipient_id, provider, environment, provider_account_id,
        provider_bank_account_id, bank_name, account_type, last_four, holder_name,
        verification_status, connection_status, can_receive, can_send, connected_at
      ) VALUES (
        rec.tenant_id, rec.id, 'moov', rec.environment, rec.provider_account_id,
        v_bank_id, v_bank_name, v_account_type, v_last_four, v_holder,
        'pending', 'connected', true, false, now()
      );
    ELSIF EXISTS (SELECT 1 FROM public.payment_provider_methods
                   WHERE id = v_method AND external_recipient_id IS DISTINCT FROM rec.id) THEN
      RETURN jsonb_build_object('error', 'conflict');
    ELSE
      UPDATE public.payment_provider_methods
         SET bank_name = v_bank_name, account_type = v_account_type, last_four = v_last_four,
             holder_name = v_holder, connection_status = 'connected', disconnected_at = NULL,
             updated_at = now()
       WHERE id = v_method;
    END IF;

    UPDATE public.external_payment_recipients
       SET provider_bank_account_id = v_bank_id, provider_bank_name = v_bank_name,
           provider_last_four = v_last_four, bank_linked_at = now(), bank_verified_at = NULL,
           onboarding_status = CASE WHEN verified_at IS NULL THEN 'bank_linked' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSIF v_event = 'bank_verified' THEN
    v_bank_id := trim(COALESCE(v_data->>'provider_bank_account_id', ''));
    IF rec.provider_bank_account_id IS NULL OR v_bank_id <> rec.provider_bank_account_id THEN
      RETURN jsonb_build_object('error', 'bank_mismatch');
    END IF;
    UPDATE public.payment_provider_methods
       SET verification_status = 'verified', updated_at = now()
     WHERE external_recipient_id = rec.id AND provider_bank_account_id = v_bank_id;
    UPDATE public.external_payment_recipients
       SET bank_verified_at = COALESCE(bank_verified_at, now()),
           onboarding_status = CASE WHEN verified_at IS NULL THEN 'bank_verified' ELSE onboarding_status END
     WHERE id = rec.id;

  ELSE
    RETURN jsonb_build_object('error', 'invalid_event');
  END IF;

  RETURN public.aws_public_payee_by_token(v_token);
END
$$;

-- API, after reading the payee's account from Moov (setup link or webhook): Moov's verdict.
CREATE OR REPLACE FUNCTION public.aws_payee_apply_status(
  _environment text,
  _provider_account_id text,
  _status text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.external_payment_recipients%ROWTYPE;
  v_status text := lower(trim(COALESCE(_status, '')));
BEGIN
  IF v_status NOT IN ('verified', 'pending_review', 'failed') THEN
    RETURN jsonb_build_object('error', 'invalid_status');
  END IF;
  SELECT * INTO rec FROM public.external_payment_recipients
   WHERE provider = 'moov' AND environment = lower(trim(COALESCE(_environment, '')))
     AND provider_account_id = trim(COALESCE(_provider_account_id, ''))
   LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF rec.disconnected_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'disconnected'); END IF;

  IF v_status = 'verified' THEN
    IF rec.tos_accepted_at IS NULL OR rec.identity_submitted_at IS NULL
       OR rec.provider_bank_account_id IS NULL OR rec.bank_verified_at IS NULL THEN
      RETURN jsonb_build_object('error', 'setup_incomplete');
    END IF;
    UPDATE public.external_payment_recipients
       SET verified_at = COALESCE(verified_at, now()), onboarding_status = 'verified',
           token_used_at = COALESCE(token_used_at, now()), updated_at = now()
     WHERE id = rec.id;
    UPDATE public.stakeholder_accounts
       SET verification_status = 'verified', verification_source = 'moov',
           verified_at = COALESCE(verified_at, now()), verification_completed_at = now(),
           provider = 'moov', provider_environment = rec.environment,
           provider_account_id = rec.provider_account_id,
           provider_bank_account_id = rec.provider_bank_account_id,
           provider_bank_name = rec.provider_bank_name, provider_last_four = rec.provider_last_four,
           updated_at = now()
     WHERE id = rec.stakeholder_account_id AND tenant_id = rec.tenant_id AND origin = 'provider_recipient';
  ELSE
    UPDATE public.external_payment_recipients
       SET onboarding_status = v_status, updated_at = now()
     WHERE id = rec.id AND verified_at IS NULL;
    UPDATE public.stakeholder_accounts
       SET verification_status = CASE WHEN v_status = 'failed' THEN 'failed' ELSE 'pending' END,
           updated_at = now()
     WHERE id = rec.stakeholder_account_id AND tenant_id = rec.tenant_id AND origin = 'provider_recipient'
       AND verification_status NOT IN ('verified', 'admin_override');
  END IF;

  RETURN jsonb_build_object('ok', true, 'recipient_id', rec.id, 'tenant_id', rec.tenant_id,
                            'stakeholder_account_id', rec.stakeholder_account_id, 'status', v_status);
END
$$;

REVOKE ALL ON FUNCTION public.aws_payee_create(uuid, uuid, text, text, text, text, text, text, text, timestamptz, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_payee_reissue_link(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_payee_disconnect(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_payee_by_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_payee_record(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_payee_apply_status(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_payee_create(uuid, uuid, text, text, text, text, text, text, text, timestamptz, uuid, uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_payee_reissue_link(uuid, text, timestamptz) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_payee_disconnect(uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_public_payee_by_token(text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_public_payee_record(text, text, jsonb) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_payee_apply_status(text, text, text) TO checksops;

COMMENT ON FUNCTION public.aws_payee_create(uuid, uuid, text, text, text, text, text, text, text, timestamptz, uuid, uuid) IS
  'SQL 113: a tenant member creates a payee (external_payment_recipients) and its pending provider_recipient stakeholder row. checksops only.';
COMMENT ON FUNCTION public.aws_payee_reissue_link(uuid, text, timestamptz) IS
  'SQL 113: a tenant member issues a new setup link token for a payee that is not verified or disconnected. checksops only.';
COMMENT ON FUNCTION public.aws_payee_disconnect(uuid) IS
  'SQL 113: a tenant member disconnects a payee: stakeholder inactive, link closed, bank methods disconnected. checksops only.';
COMMENT ON FUNCTION public.aws_public_payee_by_token(text) IS
  'SQL 113: a payee''s own setup state through its link token; no identity data. checksops only.';
COMMENT ON FUNCTION public.aws_public_payee_record(text, text, jsonb) IS
  'SQL 113: records one payee setup step (tos_accepted, identity_submitted, bank_linked, bank_verified) through its link token. checksops only.';
COMMENT ON FUNCTION public.aws_payee_apply_status(text, text, text) IS
  'SQL 113: applies Moov''s verdict for a payee account; verified makes the stakeholder payable only after terms, identity and a verified bank. checksops only.';
