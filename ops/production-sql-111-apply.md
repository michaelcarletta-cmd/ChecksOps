# Production SQL 111 (tenant referral codes)

| key | file | what it does |
|---|---|---|
| `sql111` | `aws/workflows/sql/111_tenant_referral_codes.sql` (sha256 `49144697145cb6f6e2495041c22967cfd44263f8abb7fad5ef0953f1abb8e829`) | Five new SECURITY DEFINER functions, `search_path = public`, PUBLIC revoked, EXECUTE `checksops` only (the active-count helper: the owner only). No table, column, policy, trigger or table grant change. |

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

**Status:** applied to staging and to production (2026-10-23); the production pin is retired
(`execute: false` again; see "Production apply of SQL 111").
Not verified: the live `referral_events` constraints (a `status` CHECK that refuses `active`, or a
NOT NULL column without a default that the insert does not set, would make the redeem fail; the
inspect does not read constraints of tables it does not change), and whether existing tenants
have a `referral_code`.

## Status

- **Staging executor refreshed (2026-10-22).** Inspect run 39874145339 (main `323206af2`) found the
  live executor at CodeSha256 `SzEmktCl…` without SQL 111 (adds only
  `sql/111_tenant_referral_codes.sql`, supersedes the three engine files, nothing dropped, no
  collisions). Deploy run 39874360848 updated it to main's package.
- **Staging read-live (2026-10-22).** Run 39874593011 (main `323206af2`): the five functions
  `absent`, live `b78704b4d46b3ca88146d8368e09c630ead8930d3717e89287bf07bb46b86978`,
  `definer_writes` ok for `referral_events` and `tenants`, `already_applied` false,
  `precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
  `execute: true`, wave 12) under the owner's statement of 2026-10-22, "Owner approved the SQL 111
  staging apply on 2026-10-22".
- **Staging apply (2026-10-23).** After the staging pin change merged (#1176, main `1586c24df`),
  inspect run 39876957488 found the executor without the new pin (`xV6M66pR…`, supersedes
  `lib/sql-executor-auth.mjs`); deploy run 39877410445 updated it (executor
  `iqIKOKkHz1fCAl5yf/R1rhU/VDUH8ecUTa71/bJ0y3A=`). Read-live run 39877666133: live still `b78704b4…`.
  Apply run 39877945144: `applied`, `b78704b4…` ->
  `0ca629155cf58f4f4033aa792cc0a8d817cd8692a1337ba85eb33716cf1c98fb`, the five functions `intended`,
  ACL `owner EXECUTE` (active-count helper) and `checksops EXECUTE`, `owner EXECUTE` (the other
  four). Read-live run 39878217390: `already_applied` true, live = intended, `precondition_failures`
  `[]`. No code was redeemed on staging.
- **Production inspect recorded (2026-10-23).** Read-only `--inspect` through SSM
  `7e6fdcf5-a48e-4db9-870f-ba28655cba41` on `i-0c35557c4e5385406`, main `1586c24df` (tarball sha256
  `d14a91b5167bfcd4176dd5facfa61016952c55c8b607e8a4456761289b56ddbe`, transfer run 39881599527):
  the five functions `absent`, live `b78704b4d46b3ca88146d8368e09c630ead8930d3717e89287bf07bb46b86978`
  (the same pre-state as staging), `definer_writes` ok for `referral_events` and `tenants`,
  `already_applied` false, `precondition_failures` `[]`. Recorded in the pin as
  `expected_live_definition_sha256`, with the staging apply run 39877945144 as `staging_acceptance`.
- **Pin `execute: true`** once that change is merged (#1177), under the owner's statement of
  2026-10-23, "Run production". Nothing is applied by it; the apply (step 3) passes the owner's
  words for that run.
- **Applied to production (2026-10-23)** and the pin retired (`execute: false` again; see
  "Production apply of SQL 111" below).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` in `release-sql-specs.mjs`). Intended
`0ca629155cf58f4f4033aa792cc0a8d817cd8692a1337ba85eb33716cf1c98fb`:

```
release sql111 v1
function public.aws_tenant_referral_active_count(uuid): lang=sql vol=s parallel=u secdef=true result=integer config=search_path=public prosrc=eb8305eb74987caac00cb6000923e589e0d89f00cfa14bff25023a3d2a90bbc6 acl=owner EXECUTE
function public.aws_tenant_referral_credit_cents(uuid): lang=plpgsql vol=s parallel=u secdef=true result=integer config=search_path=public prosrc=52a157fe939b53e63c16f353cdda96ee508281f5829e1bbdb52ffff5cc322911 acl=checksops EXECUTE;owner EXECUTE
function public.aws_apply_referral_code(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=82fe7207bdb4ae0359d7652c4d684e3cf6671f16b239037c5280ec9c20f34e22 acl=checksops EXECUTE;owner EXECUTE
function public.aws_tenant_referral_summary(uuid): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=040cc1386234a82e3a82cee64e9f4a737f1e5d85006c7396b7bc8e243795c9b2 acl=checksops EXECUTE;owner EXECUTE
function public.aws_platform_owner_referral_overview(): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=3c8566ec53d9d58d80657c0ce82582ec18ab5ac7279229ac6c57bed35eaa28ec acl=checksops EXECUTE;owner EXECUTE
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

## Production apply of SQL 111 (2026-10-23)

The owner's statement of 2026-10-23 was "apply SQL 111 in production", passed verbatim (base64,
`--approval-statement-b64`). The one-shot cannot verify who said it, and the statement covered this
run only. `production-sql-one-shot.mjs --migration sql111 --approval-scope sql111` on
`i-0c35557c4e5385406`, operator `michaelcarletta-cmd`, workstream
`prod-sql111-tenant-referral-codes-20261023`, from main `8f534384e` (tarball
`source-8f534384e94090a5692ba38ccf97afea9dc148b3.tar.gz`, sha256 `d1292281…`, transfer run
`39883324057`, `sql53-temporary-transfer.yml` dispatched on main after the #1177 merge; its package
job printed `TARBALL_SHA256 d129228149dfba4e4959350c2c7e0e7bfd5c899559f7b94e3b6dfcb2395f1ec9`, equal
to the uploaded `.sha256` sidecar).

- **Inspect phase:** SSM `d1059d4a-741f-4f2d-b6f0-eff00e28d7f8`, run_id
  `73d97a4c-41d8-47b9-af96-85c9808f16c1`: pin, source, inspect and contracts ok, nothing written;
  live `b78704b4…` (live_matches_expected true), the five functions `absent`, precondition_failures [].
- **Apply phase:** SSM `c006d74b-7c52-4e6f-972f-b17afcc448cf` (2026-10-23T01:23:27Z to 01:23:43Z),
  run_id `4bf98369-6fd4-477a-8d04-30a7952f977c`, one_use_id
  `sql111-prod-761afdca-3fd7-4e7b-932a-bce2369faff6` (spent): every step ok (pin, source, inspect,
  contracts, manifest, source-recheck-before-preflight, preflight, evaluate,
  source-recheck-before-apply, apply (applied), post-apply-inspect); migration source `49144697…`
  (== pin); contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43;
  pre-apply inspect live `b78704b4…`, predecessors `{}`, precondition_failures []; manifest
  `27919ac3…`; receipt `b78704b4…` -> `0ca62915…`, result applied, unrelated catalog `73d60457…`
  (relations 890, columns 3535, constraints 2233, policies 404, functions 1315, indexes 654, triggers
  180, views 25, types 18, roles 29, role memberships 15); post-apply inspect live `0ca62915…`,
  already_applied true, precondition_failures [], the five functions `intended`, ACL `owner EXECUTE`
  (active-count helper) and `checksops EXECUTE`, `owner EXECUTE` (the other four). The SSM output
  was cut at its 24000-character inline limit inside the post-apply inspect's ACL list; the values
  above were read from the returned part (the receipt lists all five ACLs).

No later read-only inspect was run, and no referral code has been redeemed through production since
the apply. The live `referral_events` constraints are not covered by the fingerprint and were not
inspected. The pin is `execute: false` again; a re-apply needs a new reviewed pin change. The API
routes (`workflow-rpc.mjs`), the billing engine change (`tenant-billing-engine.mjs`) and the website
change that call these functions are not part of this record and go through their own guarded
Lambda and SPA paths.
