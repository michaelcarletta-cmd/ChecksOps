# Production SQL 111 (tenant referral codes)

| key | file | what it does |
|---|---|---|
| `sql111` | `aws/workflows/sql/111_tenant_referral_codes.sql` (sha256 `c859ece70e5a09fee7fa79e5bc781f91756689ae686de2fc8469653ea2cc3edb`) | Five new SECURITY DEFINER functions, `search_path = public`, PUBLIC revoked, EXECUTE `checksops` only (the active-count helper: the owner only). No table, column, policy, trigger or table grant change. |

**Why.**

- *Entering a code fails.* Settings > Refer & Earn calls `apply_referral_code`. On AWS the API
  refuses it (`workflow-rpc.mjs` classified it `financial_sensitive`; `/data/rpc` answers
  `rpc_disabled`). It cannot be a generic write: the redeeming tenant's members may not change
  `tenants.referred_by_tenant_id` (`aws_tenants_member_column_guard`, SQL 102, 42501), and the
  code lives on another tenant's row, hidden by `aws_select_tenants`.
- *Neither side sees the referral.* The referrer cannot read the referred tenants' rows and the
  referred tenant cannot read the referrer's name.
- *No discount follows a code.* The billing engine subtracts only `tenants.referral_discount_cents`,
  which the platform owner types by hand (SQL 96).

**Owner decisions (2026-10-22).**

- When another company uses a tenant's referral code, that tenant (the referrer) gets $5.00 off
  its monthly maintenance plan for that referral, every month.
- At most $25.00 off a month, however many referrals (5 referrals reach the cap).
- A referral keeps counting whatever the referred company does later (cancelled or inactive).
- The referral credit is **added** to the discount the platform owner sets by hand in Tenant
  Management (`tenants.referral_discount_cents`).
- The total discount never exceeds the monthly maintenance rate: maintenance never goes below
  $0.00 and check fees are never reduced.
- Any member of the referred company can enter the code, once per company.
- The referrer sees the count and the amount; the referred company sees whose code it used.

**The calculation, per tenant per month.**

```
referrals      = distinct companies that used this tenant's code (status 'active')
referral_credit = min(2500, 500 * referrals)                                   -- cents
discount        = min(referral_credit + referral_discount_cents, monthly_rate_cents)
maintenance     = monthly_rate_cents - discount                                -- never below 0
```

| referrals | hand-set | rate | referral credit | discount | maintenance charged |
|---|---|---|---|---|---|
| 0 | $0 | $99 | $0 | $0 | $99 |
| 1 | $0 | $99 | $5 | $5 | $94 |
| 3 | $0 | $99 | $15 | $15 | $84 |
| 5 | $0 | $99 | $25 | $25 | $74 |
| 8 | $0 | $99 | $25 (cap) | $25 | $74 |
| 2 | $10 | $99 | $10 | $20 | $79 |
| 5 | $10 | $99 | $25 | $35 | $64 |
| 5 | $0 | $20 | $25 | $20 (rate) | $0 |

**What the functions do.**

- `aws_tenant_referral_active_count(uuid)` (owner only): distinct tenants that used the code:
  `referral_events` rows with `status = 'active'`, plus Supabase-era referrals recorded only in
  `tenants.referred_by_tenant_id` (a referred tenant with any `referral_events` row counts by that
  row alone, so setting the event to anything but `active` removes the credit).
- `aws_tenant_referral_credit_cents(uuid)`: `least(2500, 500 * count)`. An identity that cannot
  access the tenant is refused (42501); a session with no app identity (billing scheduler) may
  read it. The billing engine (`tenant-billing-engine.mjs`, a separate Lambda change) uses
  `least(tenants.referral_discount_cents + credit, tenants.monthly_rate_cents)` as the
  maintenance discount.
- `aws_apply_referral_code(uuid, text)`: the caller must be a member of the tenant (any
  `tenant_users` row; the role is not checked, as everywhere since SQL 90). Code trimmed and
  upper-cased, 3 to 40 of `A-Z 0-9 _ -`. Locks the redeeming tenant
  row `FOR UPDATE`; refuses `already_redeemed`, `invalid_code` (unknown, ambiguous or a system
  tenant), `own_code`, `mutual_referral`; inserts one `referral_events` row
  (`discount_applied_cents` 500, `status` `active`). Changes no `tenants` row. Returns
  `{success, error?, message, referrer_name, ...}`.
- `aws_tenant_referral_summary(uuid)`: for an identity that can access the tenant: its code, the
  referrals it made (names and dates), active count, earned credit, hand-set discount, applied
  discount (`least(credit + hand-set, rate)`) and who referred it.
- `aws_platform_owner_referral_overview()`: the platform owner only: the same figures for every
  non-system tenant (no Founding, removed from Tenant Management in #1171).

**Status:** pending. Both pins are `execute: false`, `authorization: "pending"`, with no recorded
pre-state; nothing is applied by this change. Neither staging nor production has been inspected.
Not verified: the live `referral_events` constraints (a `status` CHECK that refuses `active`, or a
NOT NULL column without a default that the insert does not set, would make the redeem fail; the
inspect does not read constraints of tables it does not change), and whether existing tenants
have a `referral_code`.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` in `release-sql-specs.mjs`). Intended
`e9699e1288554bf8161cf36654b163a387a507cb6645c3e597f90570b5bf16ba`:

```
release sql111 v1
function public.aws_tenant_referral_active_count(uuid): lang=sql vol=s parallel=u secdef=true result=integer config=search_path=public prosrc=eb8305eb74987caac00cb6000923e589e0d89f00cfa14bff25023a3d2a90bbc6 acl=owner EXECUTE
function public.aws_tenant_referral_credit_cents(uuid): lang=plpgsql vol=s parallel=u secdef=true result=integer config=search_path=public prosrc=52a157fe939b53e63c16f353cdda96ee508281f5829e1bbdb52ffff5cc322911 acl=checksops EXECUTE;owner EXECUTE
function public.aws_apply_referral_code(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=24f94cbab1fc5df7b769eb14456914a728069f252b2cb7b11f130b0a204f1ffe acl=checksops EXECUTE;owner EXECUTE
function public.aws_tenant_referral_summary(uuid): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=328dfd184252db1638935b587116e4317b0c9ebc0b7027f38a6fe1bce560d7a5 acl=checksops EXECUTE;owner EXECUTE
function public.aws_platform_owner_referral_overview(): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=026440128326575403fd95409a75c3da84db1e58928d026ed1bf9ac76281f9a7 acl=checksops EXECUTE;owner EXECUTE
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (tenants, referral_events, tenant_users, the columns the functions use,
`auth.uid()`, `aws_is_authenticated()`, `aws_can_access_tenant(uuid)`, `is_platform_owner()`,
role `checksops`); `definer_can_write_relations` (the login owns `referral_events` and `tenants`
without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS). The file itself refuses with
`55000 sql111_prerequisite_missing` / `sql111_definer_cannot_write`.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged. The tools roll back otherwise.

## Order

No predecessor. Apply before the Lambda members that call the functions (`workflow-rpc.mjs`,
`tenant-billing-engine.mjs`) go live, or with them: before SQL 111, the new RPC routes answer
with a database error and the billing engine keeps the hand-set discount only.

## Steps

1. Staging: the staging executor must carry SQL 111 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then `read-live` for `sql111-tenant-referral-codes`. Expected `already_applied` false and
   `precondition_failures` `[]`. Record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true).
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql111-tenant-referral-codes-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect` and copy
   `live_definition_sha256` into `expected_live_definition_sha256`; record the staging runs in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change. Expected: `already_applied` false, `precondition_failures` [].
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql111 --approval-scope sql111 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
