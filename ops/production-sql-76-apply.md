# Production SQL 76 (only the invitee side can make a partnership live)

| key | file | what it does |
|---|---|---|
| `sql76` | `aws/workflows/sql/76_tenant_partnership_invitee_consent.sql` (sha256 `47ef66fa3b66b07ad1c3fe6a3accc7dc1696efeb85a2d3ca3b3bb9a001f7f3c7`, authored by `efbd03b2d`) | `CREATE OR REPLACE FUNCTION public.aws_tenant_partnership_consent_guard()` (plpgsql, `RETURNS trigger`, `SET search_path = public`, not SECURITY DEFINER), its `COMMENT`, `REVOKE ALL ... FROM PUBLIC` (EXECUTE for the owner only), `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER aws_tenant_partnership_consent_guard BEFORE INSERT OR UPDATE ON public.tenant_partnerships FOR EACH ROW`, and `DROP POLICY IF EXISTS` of the five Supabase-era policies. No other statement. |

**Why.** SQL 76 was written and taken through staging in October (guarded staging SQL executor apply run
`38553052449`, 2026-10-14, through its own staging pin `AUTHORIZED_SQL76_PARTNERSHIP_CONSENT`) but never applied to
production. On 2026-11-11 a read-only run of the production DB validator (owner: "OK to run the read-only validator
on production"; SSM `615b437c-d87c-4d9f-863e-7db9bc09dce4`, `c3f2e951-c3dd-4308-9975-0552fec04950`) found
`tenant_partnerships.aws_tenant_partnership_consent_guard` missing, so production's `/db-readonly-validate` answers
503. Owner 2026-11-11: "apply SQL 76 to production through the guarded path", then "Option 1": SQL 76 itself through
the release engine, not a renumbered copy.

**What it changes.** A `tenant_partnerships` row is live when `status = 'active'` and `revoked_at IS NULL`, which is
what the partner payout options, adding a partner stakeholder, sharing a check with a partner and the Moov send
trust. With the guard, a row may become live only when the signed-in user is a member who can write the **invitee**
tenant (`42501 partnership_invitee_consent_required`), or when the write is one of
`aws_connect_partner_by_code`'s own three row writes run as its owner (the Partner Code redemption, matched by the
sha256 of the statement text Postgres prints in `PG_CONTEXT`). On update the tenant pair is fixed
(`42501 partnership_tenants_immutable`; the invitee may only go from null to a tenant). Pending, decline and revoke are
unchanged. The five Supabase-era policies (`Inviter can create partnerships`, `Partners can update partnerships`,
`Admins can create any partnership`, `Admins can view any partnership`, `Admins can update any partnership`) are
dropped; production already has none of them. `aws_select_tenant_partnerships` and `aws_write_tenant_partnerships`
stay.

Not changed: no table, column, index, grant, other policy or row; `aws_connect_partner_by_code` is not changed. No
API, Lambda or SPA change.

**Engine.** Production uses the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql76`
in `release-sql-specs.mjs`; release entry `AUTHORIZED_SQL76_RELEASE_TENANT_PARTNERSHIP_CONSENT`, execute false). The
staging executor keeps routing choice `sql76-tenant-partnership-consent` to its own SQL 76 handler and pin
(`resolveAuthorizedMigration` checks SQL 76 first), so nothing about staging changes.

Preconditions beyond the shared ones: `aws_connect_partner_by_code(text, uuid)` exactly as SQL 32 defines it (body
sha256 `1d8e36deefc46bf447b57f13d510a8a9184f61783c8e181fef4150384c327a08`, SECURITY DEFINER, `search_path=public`,
`row_security=off`: `partnership_connect_pinned`), owned by a role that is not `checksops` and that `checksops` is not
a member of (`partnership_connect_not_api_owned`), and no other trigger on the table
(`tenant_partnerships_no_other_trigger`). Each is a read-only catalog count that must be exactly 1.

## Fingerprints

Code-derived (`releaseIntendedHash` / `releaseStateHash`), read back on PostgreSQL 16 by
`aws/tests/release-sql76-production-pg.test.mjs`:

- expected pre-state (everything SQL 76 creates absent, the five policies absent):
  `e1f21bd49f76bf0f619cbfb37f77c01711075e3c030ce1e271ee26052fff92d6`
- intended: `a36222984953e0425dcf8fe2cfa9f261826ee3f1294ba00d56b680613c400645`

```
release sql76 v1
function public.aws_tenant_partnership_consent_guard(): lang=plpgsql vol=v parallel=u secdef=false result=trigger config=search_path=public prosrc=9b209db80fb029b07ee74365e1e7fea6fc76b70dc0058e39f15f5fa7ea3afb20 acl=owner EXECUTE
policy public.tenant_partnerships Inviter can create partnerships: absent
policy public.tenant_partnerships Partners can update partnerships: absent
policy public.tenant_partnerships Admins can create any partnership: absent
policy public.tenant_partnerships Admins can view any partnership: absent
policy public.tenant_partnerships Admins can update any partnership: absent
trigger public.tenant_partnerships aws_tenant_partnership_consent_guard: enabled=O def=a5f225a26cba4828756df87912cf9b69fd655202f1590854ff78dacfda1fad78
```

## Evidence so far

- Staging: apply run `38553052449` (2026-10-14): before `7c5276d8…`, after `2f195230…` (the SQL 76 staging pin's own
  state text), result applied. Read-live run `43024276076` (2026-11-11, main `4fef6ce17`): `already_applied true`, live
  `2f195230…`.
- Production pre-check (2026-11-11, read only; SSM `d04fa1e2-74d4-4795-854e-db5acf14b59b`, source `d3103952f`): the
  staging executor's own reader reports `7c5276d8…`, the same pre-state staging had: guard and trigger absent, the five
  policies absent, connect pinned and owned by `checksops_admin`, `checksops` not a member, no other trigger, only
  `aws_select_tenant_partnerships` and `aws_write_tenant_partnerships` on the table.

**Production apply (2026-11-11).** After the pin change (#1775, on the staging apply run 38553052449; merged to main as
`3f7d1cf43` on the owner's words "merge 1775 when green and apply SQL 76 in production"), transfer run 43067609844 staged
main `3f7d1cf43` (tarball sha256 `04bcc519300176ee01addac053d9a8b11515e4419d513bccbb9b60364d942cda`). Under the owner's
words "merge 1775 when green and apply SQL 76 in production" (passed verbatim), a one-shot `--phase inspect` (SSM
`d3ceb2b9-0fec-43fc-b1d3-0a44fbcaf9d4`, run `900c3d88-ef73-4a66-b8b6-41268443ed48`, EXIT=0, nothing written) read live
`e1f21bd4…` (the pinned pre-state, `live_matches_expected` true, `precondition_failures` `[]`, the three SQL 76 counts 1);
then one-shot `--phase apply` run `7eb98231-35af-4ef3-a705-912f9208ed80` through SSM
`11317599-23d1-41cc-a773-0e53aace237f`, workstream `prod-sql76-tenant-partnership-consent-20261111`, one_use_id
`sql76-prod-9b8d5c5c-6058-4606-b733-0a46bbe7dd73`: contracts 4/4, 6/6 and 43/43; all 11 steps ok; manifest `0bb7c5cf…`;
receipt `e1f21bd4…` → `a36222984953e0425dcf8fe2cfa9f261826ee3f1294ba00d56b680613c400645` (intended), result `applied`,
unrelated catalog `6c86e774…`; post-apply inspect `already_applied` true, `precondition_failures` `[]`, the guard
function `intended` (EXECUTE for the owner only), the trigger `intended`, the five policies absent. The run's JSON did
not arrive whole: SSM keeps at most 24000 characters of output, so it stops inside the one-shot's own printed `applied`
object and the `EXIT=` line is missing; every field recorded in the pin's `applied` block arrived whole before that point
(the pin's `one_shot_note` lists what was and was not captured). The runner `i-0c35557c4e5385406` was started for this
work at 17:24:09Z and stopped at 17:25:24Z. No API, Lambda or SPA change goes with it. Production acceptance had not been
reported by the owner when this record was written; this record does not claim it.

After the apply production's `/db-readonly-validate` still answered 503. SQL 76's trigger is now there, so every
justified trigger is present, but production also has a trigger, `claims.trg_aws_stamp_claim_org_id`, that no file or
commit in this repository defines. It is not part of SQL 76; this record does not touch it and leaves it to the owner.

**Status:** applied to staging (2026-10-14) and to production (2026-11-11); the production pin is retired
(`execute: false`).

Before the apply, the pin `ops/deployment-guard/sql76-tenant-partnership-consent-production-apply.json` was
`execute: true` (owner-approved pin change of 2026-11-11, "record the SQL 76 production pin") with:

- `expected_live_definition_sha256` `e1f21bd4…`, from the read-only production inspect of 2026-11-11 (SSM
  `3ba99c60-cea5-4e71-807f-87122ec557ea`, main `94d48726`, transfer run 43063595712, tarball `ebe20edf…`):
  `prerequisites_missing []`, the three SQL 76 counts 1, `already_applied false`, `precondition_failures []`;
- `staging_acceptance` the staging apply run 38553052449 (2026-10-14), with read-live run 43024276076.


## Steps (one reviewed PR per step; each production step waits for the owner)

1. This tooling (no apply).
2. Read-only production inspect on the runner: `production-sql-one-shot.mjs --migration sql76 --approval-scope sql76
   ... --phase inspect` (`ops/production-sql-one-shot.md`). Expect `live_definition_sha256`
   `e1f21bd4…`, `prerequisites_missing []`, `precondition_failures []`, `apply_preconditions_met true`. Stop on
   anything else.
3. Pin PR: record `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record
   `staging_acceptance` (`ok: true`, reference run `38553052449`, with read-live `43024276076`), the owner-approved
   `authorization` and `execute: true`. The owner reviews and merges it.
4. Production apply through the one-shot `--phase apply` with the owner's exact words as `--approval-statement`.
   Expected after-state `a3622298…`. Afterwards production's `/db-readonly-validate` should answer 200.
5. Record PR: the `applied` block from the run, `execute: false`, `production_evidence`.

Rollback (not part of this pin; a reviewed step of its own if ever needed):
`aws/workflows/sql/76_tenant_partnership_invitee_consent_rollback.sql`.
