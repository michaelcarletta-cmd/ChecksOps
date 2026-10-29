/**
 * SQL 126 (aws/workflows/sql/126_definer_reads_caller_gates.sql) test helpers: the thirteen
 * Supabase-era SECURITY DEFINER read functions it replaces, each with the supabase migration that
 * last defines it (the body restored onto the AWS databases), the header SQL 126 writes for it
 * (same arguments, defaults, result, language, volatility, SECURITY DEFINER and search_path) and
 * the exact edits SQL 126 makes to that body (the caller gate or the row scoping, nothing else).
 *
 *   - supabaseFunctionStatement(name) / supabaseFunctionBody(name): the CREATE statement and the
 *     body exactly as the supabase migration has them;
 *   - sql126Body(name): that body with SQL 126's edits applied (each edit must match exactly once);
 *   - definerReadsSchema(): the extra schema for the release fixture (run as the superuser before
 *     the fixture hands schema public to checksops_admin): the columns and tables the thirteen
 *     bodies read, the thirteen functions as the supabase migrations create them (so the fixture
 *     starts from the restored state: default EXECUTE ACL, owned by checksops_admin after the
 *     fixture's ownership step), get_total_unread_check_messages() as restored (SQL 126 leaves
 *     it: it sums get_check_unread_counts()), and the rows the behavior test reads.
 *
 * Rows: CHECK_A (TENANT_A, the release fixture's) shared with TENANT_B; CHECK_B of TENANT_B, not
 * shared. MEMBER_A (a viewer of TENANT_A) also holds the global user_roles admin and staff (a
 * tenant admin, aws/rls/FINAL_POLICY_SET.md); MEMBER_B is TENANT_B's owner and so the partner on
 * CHECK_A. Both checks are stale (stuck), carry a claim with a settlement, and have messages from
 * the other side; TENANT_B is enabled for Check Alt and has usage rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CHECK_A, CLAIM_A, MEMBER_A, MEMBER_B, REPO_ROOT, TENANT_A, TENANT_B } from './release-sql-pg.mjs';

export const CHECK_B = '55555555-5555-4555-8555-5555555555c2';
export const CLAIM_B = '66666666-6666-4666-8666-6666666666c2';

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');

const TENANT_GATE = `  IF NOT COALESCE(public.aws_can_access_tenant(_tenant_id), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;`;
const OWNER_GATE_LINE = "  IF NOT COALESCE(public.is_platform_owner(), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;";
const DEPOSIT_KPI_GATE = "  IF NOT has_role(auth.uid(), 'staff') AND NOT has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Not authorized'; END IF;";
const CHECKS_GATE = `  IF NOT (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;`;

/**
 * The thirteen functions in file order. `gate` names the rule SQL 126 adds (owner: the platform
 * owner only; tenant: aws_can_access_tenant(_tenant_id); check: the owner tenant, an active share
 * target or the platform owner; self: the caller's own user id or the platform owner; scoped: rows
 * limited to what the caller may read). `result` is pg_get_function_result for TABLE (...) results.
 */
export const SQL126_FUNCTIONS = Object.freeze([
  {
    identity: 'public.get_all_checks_safety_net()',
    name: 'get_all_checks_safety_net',
    file: '20260502114110_6e671531-7d7f-4c67-ab02-07fef5209508.sql',
    gate: 'owner',
    result: 'TABLE(id uuid, claim_id uuid, status text, amount numeric, check_number text, carrier_name text, payee_line text, front_image_path text, back_image_path text, created_at timestamp with time zone, updated_at timestamp with time zone, has_loss_draft boolean)',
    header: `CREATE OR REPLACE FUNCTION public.get_all_checks_safety_net()
RETURNS TABLE (
  id uuid, claim_id uuid, status text, amount numeric, check_number text,
  carrier_name text, payee_line text, front_image_path text, back_image_path text,
  created_at timestamptz, updated_at timestamptz, has_loss_draft boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public`,
    edits: [[CHECKS_GATE, `  -- SQL 126 (finding 4): the platform owner only; was any global user_roles admin or staff.
  IF NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;`]],
  },
  {
    identity: 'public.get_stuck_checks()',
    name: 'get_stuck_checks',
    file: '20260502114110_6e671531-7d7f-4c67-ab02-07fef5209508.sql',
    gate: 'scoped',
    result: 'TABLE(id uuid, claim_id uuid, status text, amount numeric, carrier_name text, payee_line text, created_at timestamp with time zone, updated_at timestamp with time zone, hours_in_status numeric, sla_hours integer, is_overdue boolean)',
    header: `CREATE OR REPLACE FUNCTION public.get_stuck_checks()
RETURNS TABLE (
  id uuid, claim_id uuid, status text, amount numeric,
  carrier_name text, payee_line text, created_at timestamptz, updated_at timestamptz,
  hours_in_status numeric, sla_hours int, is_overdue boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public`,
    edits: [
      ['\nBEGIN\n', '\nDECLARE\n  v_owner boolean;\nBEGIN\n'],
      [CHECKS_GATE, `  -- SQL 126 (finding 4): the platform owner reads every tenant's stuck checks; a user_roles
  -- admin or staff (a tenant admin holds user_roles admin) only those of their own tenants
  -- (check reconciliation, aws/functions/api/check-reconciliation.mjs, already keeps only those).
  v_owner := COALESCE(public.is_platform_owner(), false);
  IF NOT (v_owner OR public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role)) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;`],
      ['  JOIN sla ON sla.status = c.status\n', '  JOIN sla ON sla.status = c.status\n  WHERE v_owner OR c.tenant_id IN (SELECT public.aws_user_tenant_ids())\n'],
    ],
  },
  {
    identity: 'public.get_deposit_ops_kpis()',
    name: 'get_deposit_ops_kpis',
    file: '20260308181449_0a4c9354-18c2-48d2-8021-f944324ad69c.sql',
    gate: 'owner',
    header: `CREATE OR REPLACE FUNCTION public.get_deposit_ops_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[DEPOSIT_KPI_GATE, OWNER_GATE_LINE]],
  },
  {
    identity: 'public.get_deposit_exception_kpis()',
    name: 'get_deposit_exception_kpis',
    file: '20260308181449_0a4c9354-18c2-48d2-8021-f944324ad69c.sql',
    gate: 'owner',
    header: `CREATE OR REPLACE FUNCTION public.get_deposit_exception_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[DEPOSIT_KPI_GATE, OWNER_GATE_LINE]],
  },
  {
    identity: 'public.get_deposit_aging_summary()',
    name: 'get_deposit_aging_summary',
    file: '20260308173238_65274e91-0f07-4481-abd4-2dab4169c2ba.sql',
    gate: 'owner',
    header: `CREATE OR REPLACE FUNCTION public.get_deposit_aging_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[DEPOSIT_KPI_GATE, OWNER_GATE_LINE]],
  },
  {
    identity: 'public.get_check_dashboard_counts_for_tenant(uuid)',
    name: 'get_check_dashboard_counts_for_tenant',
    file: '20260422135931_94c5d296-1a43-4c69-a9cf-57055fb26e9e.sql',
    gate: 'tenant',
    header: `CREATE OR REPLACE FUNCTION public.get_check_dashboard_counts_for_tenant(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[`  -- Allow system admins or tenant members
  IF NOT public.has_role(auth.uid(), 'admin') 
     AND NOT public.has_role(auth.uid(), 'staff')
     AND NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;`, `  -- SQL 126 (finding 4): tenant members and the platform owner; was also any global
  -- user_roles admin or staff, for every tenant.
${TENANT_GATE}`]],
  },
  {
    identity: 'public.get_loss_draft_dashboard_counts_for_tenant(uuid)',
    name: 'get_loss_draft_dashboard_counts_for_tenant',
    file: '20260603174139_d3b0e6eb-f9ea-4bce-8aa9-add6019fa53b.sql',
    gate: 'tenant',
    header: `CREATE OR REPLACE FUNCTION public.get_loss_draft_dashboard_counts_for_tenant(_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[`  IF NOT public.has_role(auth.uid(), 'admin') 
     AND NOT public.has_role(auth.uid(), 'staff')
     AND NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;`, `  -- SQL 126 (finding 4): tenant members and the platform owner; was also any global
  -- user_roles admin or staff, for every tenant.
${TENANT_GATE}`]],
  },
  {
    identity: 'public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone)',
    name: 'get_tenant_check_usage',
    file: '20260820191520_34989965-6b59-4217-a5de-f9eb98968b54.sql',
    gate: 'tenant',
    header: `CREATE OR REPLACE FUNCTION public.get_tenant_check_usage(_tenant_id uuid, _month_start timestamp with time zone DEFAULT date_trunc('month'::text, now()), _month_end timestamp with time zone DEFAULT (date_trunc('month'::text, now()) + '1 mon'::interval))
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[`  IF NOT public.has_role(auth.uid(), 'admin'::app_role)
     AND NOT public.has_role(auth.uid(), 'staff'::app_role)
     AND NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;`, `  -- SQL 126 (finding 4): tenant members and the platform owner; was also any global
  -- user_roles admin or staff, for every tenant.
${TENANT_GATE}`]],
  },
  {
    identity: 'public.get_tenant_users_with_profiles(uuid)',
    name: 'get_tenant_users_with_profiles',
    file: '20260423231349_86efd769-6be3-42d9-919f-9fe890c5e8f9.sql',
    gate: 'tenant',
    result: 'TABLE(id uuid, user_id uuid, role text, created_at timestamp with time zone, full_name text, email text)',
    header: `CREATE OR REPLACE FUNCTION public.get_tenant_users_with_profiles(_tenant_id uuid)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  role text,
  created_at timestamptz,
  full_name text,
  email text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[`    AND (
      -- Caller must be a member of this tenant OR a system admin
      EXISTS (
        SELECT 1 FROM public.tenant_users x
        WHERE x.tenant_id = _tenant_id AND x.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    )`, `    -- SQL 126 (finding 4): a member of this tenant or the platform owner; was also any
    -- global user_roles admin, for every tenant. No rows otherwise.
    AND COALESCE(public.aws_can_access_tenant(_tenant_id), false)`]],
  },
  {
    identity: 'public.is_checkalt_enabled_for_tenant(uuid)',
    name: 'is_checkalt_enabled_for_tenant',
    file: '20260626191752_8072249d-6952-455d-aec0-0e4cd75342c9.sql',
    gate: 'tenant',
    header: `CREATE OR REPLACE FUNCTION public.is_checkalt_enabled_for_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [[`        AND registered_at IS NOT NULL
    );`, `        AND registered_at IS NOT NULL
    )
    -- SQL 126 (finding 4): false unless the caller is a member of the tenant or the platform owner.
    AND COALESCE(public.aws_can_access_tenant(_tenant_id), false);`]],
  },
  {
    identity: 'public.get_check_claim_settlement(uuid)',
    name: 'get_check_claim_settlement',
    file: '20260608105612_d4d7fc7c-ba22-4b2e-ba6b-e51319563743.sql',
    gate: 'check',
    header: `CREATE OR REPLACE FUNCTION public.get_check_claim_settlement(p_check_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [["  ELSIF has_role(v_user, 'admin'::app_role) OR has_role(v_user, 'staff'::app_role) THEN",
      `  -- SQL 126 (finding 4): the platform owner; was any global user_roles admin or staff.
  ELSIF COALESCE(public.is_platform_owner(), false) THEN`]],
  },
  {
    identity: 'public.has_permission(uuid, text)',
    name: 'has_permission',
    file: '20260106133153_835bb2b5-2a06-4e06-a7be-00993814b287.sql',
    gate: 'self',
    header: `CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [['\nBEGIN\n', `
BEGIN
  -- SQL 126 (finding 4): the caller's own permissions, or the platform owner's question.
  IF _user_id IS DISTINCT FROM auth.uid() AND NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
`]],
  },
  {
    identity: 'public.get_check_unread_counts()',
    name: 'get_check_unread_counts',
    file: '20260502121539_8daa93cc-aa74-4fa5-b9b2-d0efe2b050fc.sql',
    gate: 'scoped',
    result: 'TABLE(check_id uuid, unread_count bigint, last_message_at timestamp with time zone)',
    header: `CREATE OR REPLACE FUNCTION public.get_check_unread_counts()
RETURNS TABLE(check_id uuid, unread_count bigint, last_message_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public`,
    edits: [['  GROUP BY m.check_id;', `  GROUP BY m.check_id
  -- SQL 126 (finding 4): only the checks whose messages the caller may read (the
  -- check_messages read rule, aws_can_access_check); was every tenant's checks.
  HAVING COALESCE(public.aws_can_access_check(m.check_id), false);`]],
  },
].map((fn) => Object.freeze({ ...fn, edits: Object.freeze(fn.edits.map((e) => Object.freeze([...e]))) })));

export const SQL126_IDENTITIES = Object.freeze(SQL126_FUNCTIONS.map((fn) => fn.identity));
const BY_NAME = Object.fromEntries(SQL126_FUNCTIONS.map((fn) => [fn.name, fn]));
// Restored too, and not changed by SQL 126: it sums get_check_unread_counts().
const UNCHANGED = Object.freeze({
  get_total_unread_check_messages: Object.freeze({ file: '20260502121539_8daa93cc-aa74-4fa5-b9b2-d0efe2b050fc.sql' }),
});

function locate(name) {
  const fn = BY_NAME[name] || UNCHANGED[name];
  if (!fn) throw new Error(`not an SQL 126 function: ${name}`);
  const text = fs.readFileSync(path.join(MIGRATIONS_DIR, fn.file), 'utf8');
  const matches = [...text.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\(`, 'g'))];
  if (matches.length !== 1) throw new Error(`${name}: expected one definition in ${fn.file}, found ${matches.length}`);
  const rest = text.slice(matches[0].index);
  const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(rest);
  const bodyStart = as.index + as[0].length;
  const bodyEnd = rest.indexOf(as[1], bodyStart);
  if (bodyEnd < 0) throw new Error(`${name}: unterminated body in ${fn.file}`);
  return { statement: `${rest.slice(0, bodyEnd + as[1].length)};`, body: rest.slice(bodyStart, bodyEnd) };
}

/** The CREATE statement exactly as the supabase migration has it (the restored definition). */
export const supabaseFunctionStatement = (name) => locate(name).statement;
/** The body exactly as the supabase migration has it. */
export const supabaseFunctionBody = (name) => locate(name).body;

/** The supabase body with SQL 126's edits; each edit's old text must occur exactly once. */
export function sql126Body(name) {
  let body = supabaseFunctionBody(name);
  for (const [from, to] of BY_NAME[name].edits) {
    const at = body.indexOf(from);
    if (at < 0 || body.indexOf(from, at + 1) >= 0) throw new Error(`${name}: edit does not match exactly once: ${from.slice(0, 60)}`);
    body = body.slice(0, at) + to + body.slice(at + from.length);
  }
  return body;
}

/** One function's definition as SQL 126 writes it. */
export const sql126Statement = (name) => `${BY_NAME[name].header}\nAS $$${sql126Body(name)}$$;`;

/** Extra schema for releaseFixture (superuser, before ownership): tables, columns, the restored functions, rows. */
export function definerReadsSchema() {
  const stale = "now() - interval '30 days'";
  return [
    "ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'read_only'",
    `
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS is_system_tenant boolean NOT NULL DEFAULT false;
ALTER TABLE public.tenant_users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS amount numeric, ADD COLUMN IF NOT EXISTS ocr_status text, ADD COLUMN IF NOT EXISTS check_number text,
  ADD COLUMN IF NOT EXISTS carrier_name text, ADD COLUMN IF NOT EXISTS front_image_path text, ADD COLUMN IF NOT EXISTS back_image_path text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS uploaded_by uuid, ADD COLUMN IF NOT EXISTS detected_claim_number text, ADD COLUMN IF NOT EXISTS issue_date date,
  ADD COLUMN IF NOT EXISTS check_stage text;
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS claim_number text, ADD COLUMN IF NOT EXISTS policyholder_name text,
  ADD COLUMN IF NOT EXISTS policyholder_address text;
CREATE TABLE public.claim_settlements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, total_settlement numeric);
CREATE TABLE public.check_status_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid NOT NULL, from_status text, to_status text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.loss_draft_tracking ADD COLUMN IF NOT EXISTS check_intake_item_id uuid, ADD COLUMN IF NOT EXISTS escrow_status text,
  ADD COLUMN IF NOT EXISTS monitoring_type text, ADD COLUMN IF NOT EXISTS total_escrowed numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS draw_amount_released numeric NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS last_contact_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_date date;
CREATE TABLE public.loss_draft_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loss_draft_id uuid NOT NULL, is_required boolean NOT NULL DEFAULT true,
  is_submitted boolean NOT NULL DEFAULT false);
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid, billed_at timestamptz NOT NULL DEFAULT now(),
  unit_price_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd', status text NOT NULL DEFAULT 'recorded',
  event_type text NOT NULL DEFAULT 'check_processing');
ALTER TABLE public.mortgage_handling_requests ADD COLUMN IF NOT EXISTS billed_at timestamptz, ADD COLUMN IF NOT EXISTS flat_fee_cents integer,
  ADD COLUMN IF NOT EXISTS invoice_shipping_cents integer, ADD COLUMN IF NOT EXISTS billing_status text,
  ADD COLUMN IF NOT EXISTS mortgage_company text, ADD COLUMN IF NOT EXISTS loan_number text;
ALTER TABLE public.checkalt_tenant_accounts ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registered_at timestamptz;
CREATE TABLE public.check_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL, body text NOT NULL, is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_message_reads (
  user_id uuid NOT NULL, check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, check_id));
ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_message_reads ENABLE ROW LEVEL SECURITY;
-- Stand-ins for the three deposit KPI views the owner-only functions read (one row each).
CREATE VIEW public.deposit_ops_kpis AS SELECT 3::int AS open_items;
CREATE VIEW public.deposit_exception_kpis AS SELECT 2::int AS open_exceptions;
CREATE VIEW public.deposit_aging_summary AS SELECT 1::int AS awaiting_deposit;
CREATE FUNCTION public.is_tenant_member(_user_id uuid, _tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = _user_id AND tenant_id = _tenant_id); $$;
CREATE FUNCTION public.user_belongs_to_tenant(_user_id uuid, _tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = _user_id AND tenant_id = _tenant_id) $$;`,
    // The thirteen functions exactly as the supabase migrations define them (the restored state).
    ...SQL126_FUNCTIONS.map((fn) => supabaseFunctionStatement(fn.name)),
    supabaseFunctionStatement('get_total_unread_check_messages'),
    `
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_A}', 'admin'), ('${MEMBER_A}', 'staff');
UPDATE public.check_intake_items SET status = 'needs_review', amount = 100, check_number = 'A-1', created_at = ${stale}, uploaded_by = '${MEMBER_A}'
  WHERE id = '${CHECK_A}';
INSERT INTO public.claims (id, org_id, claim_number) VALUES ('${CLAIM_B}', '${TENANT_B}', 'CLM-B');
UPDATE public.claims SET claim_number = 'CLM-A' WHERE id = '${CLAIM_A}';
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, status, amount, check_number, created_at, uploaded_by)
  VALUES ('${CHECK_B}', '${TENANT_B}', '${CLAIM_B}', 'needs_review', 200, 'B-1', ${stale}, '${MEMBER_B}');
INSERT INTO public.claim_settlements (claim_id, total_settlement) VALUES ('${CLAIM_A}', 1000), ('${CLAIM_B}', 2000);
INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id) VALUES ('${CHECK_A}', '${TENANT_A}', '${TENANT_B}');
INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, unit_price_cents)
  VALUES ('${TENANT_A}', '${CHECK_A}', 300), ('${TENANT_B}', '${CHECK_B}', 300), ('${TENANT_B}', '${CHECK_B}', 300);
INSERT INTO public.checkalt_tenant_accounts (tenant_id, enabled, registered_at) VALUES ('${TENANT_B}', true, now());
UPDATE public.checkalt_tenant_accounts SET enabled = true, registered_at = now() WHERE tenant_id = '${TENANT_A}';
INSERT INTO public.checkalt_config (singleton, default_enabled) VALUES (true, true);
INSERT INTO public.check_messages (check_id, sender_id, body) VALUES
  ('${CHECK_A}', '${MEMBER_B}', 'from the partner'), ('${CHECK_A}', '${MEMBER_B}', 'again'),
  ('${CHECK_B}', '${MEMBER_B}', 'tenant B only'), ('${CHECK_B}', '${MEMBER_B}', 'tenant B again'), ('${CHECK_B}', '${MEMBER_B}', 'and again');
INSERT INTO public.check_messages (check_id, sender_id, body) VALUES ('${CHECK_A}', '${MEMBER_A}', 'from tenant A');`,
  ];
}
