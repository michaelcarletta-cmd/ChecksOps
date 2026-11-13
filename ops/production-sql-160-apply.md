# Production SQL 160 (no additional-check Mortgage Ops charge or agent pay, no $4 for an outside deposit)

| key | file | what it does |
|---|---|---|
| `sql160` | `aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql` (sha256 `8133121f731f3ff11c9877747685af666efb91a06c0cbae20612cb6ba690c334`, authored by `1835d34a3`) | Refuses without its prerequisites (`55000 sql160_prerequisite_missing`) or when a function's live body is neither the inspected one nor SQL 160's own (`55000 sql160_live_body_drift`); then CREATE OR REPLACE of four existing live functions. No GRANT, REVOKE or other DDL. |

**Why.** Owner 2026-11-12: "we are removing the mortgage handling for an additional check if an additional check is on
the same request. There will be no more $5 charge"; agent pay for an additional check: "Stop paying it"; "if a user
deposits a check outside of checksops they should NOT be charged $4"; a check set to deposited with no deposit record:
"yes make that free too"; "start SQL 160 yes"; "merge 1832 when green and yes make that free too". The migration merged
in #1832 (main `355d57e`).

**What it does.** Each body is the one the read-only production billing trigger inspect read on 2026-11-12
(`ops/production-billing-trigger-inspect.md`; SSM `ff854910`, `20bbce56`, `e8a9bc4e`; verbatim in
`aws/tests/fixtures/sql160-live-billing-functions-2026-11-12.sql`) with only the lines marked SQL 160 changed:
- `public.record_check_billing_event()` (SQL 98; trigger `trg_record_check_billing_event` on `check_intake_items`): a
  `check_processing` event only when the check has a `deposit_items` row whose provider is not `manual_branch`. Mark as
  Deposited / Deposit Ops (`manual_branch`) and a check set to deposited with no deposit item are not charged.
- `public.accrue_mortgage_ops_billing(uuid)` (live-only; run through `tg_accrue_mortgage_ops_billing` by
  `tr_accrue_mortgage_ops_billing` on `mortgage_handling_requests`): when the claim already has a Mortgage Ops charge,
  nothing is recorded (it recorded `mortgage_ops_additional_check`, 500 by default); a lost race for the first charge no
  longer records an additional-check charge.
- `public.earn_mortgage_agent_compensation(uuid)` (SQL 47; `tr_earn_mortgage_agent_compensation` on
  `mortgage_handling_requests`): an additional check earns no compensation entry.
- `public.tg_record_mortgage_handling_billing()` (`tr_record_mortgage_handling_billing` on `check_intake_items`): no $5
  `mortgage_handling` event for an additional check on the claim; the first stays 1000.

Kept: the $10 for a claim's first check and SQL 153's $5 for a 2nd mortgage company. Not changed: charges already
recorded; owner, EXECUTE grants, SECURITY DEFINER and SET options of the four functions (CREATE OR REPLACE keeps them); no
table, trigger, policy or grant. The db-readonly-validate trigger count is not affected. No API, Lambda or SPA change is
part of this pin.

**Status:** staging pin execute-authorized (wave 51); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-12).** The first read-live, run 43307779123 (main `83a508fb`), read `7fd99249…`: staging's
`tg_record_mortgage_handling_billing()` lacked the `checksops EXECUTE` production holds, so SQL 160's post-state could not reach
its intended hash there. SQL 161 grants it (owner: "A new SQL 161 that gives staging that one permission, then SQL 160"),
applied in staging by run 43349438014 (`72031400…` -> `b916bcb5…`, read-live run 43349855104 `already_applied` true).

**Staging read-live (2026-11-13).** Run 43350223533 (main `4cd25dac`, executor current, CodeSha256 `OrCHvYX9…`), under the owner's
words "apply SQL 160 in staging": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the four
functions' ACLs as production's. Live `3a8bb0b11d59688642c98ace91bb15c562c362eea00b2ae9c73a166fee365229`, equal to the production pre-state (the inspected bodies,
ACLs and SET options); intended `fae1623b…`. Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`,
wave 51). The staging apply is a separate run after this pin is merged and the executor is redeployed carrying it, on the
owner's words for that run. The production pin stays pending.

## Grants and attributes (observed, kept)

The file has no GRANT or REVOKE, so each spec `acl` is the live EXECUTE ACL the 2026-11-12 inspect observed
(`ops/deployment-guard/billing-trigger-inspect.json` `production_inspect.observed_functions`; owner `checksops_admin`,
read as `owner`), and `revokes` is empty: a live grant outside it refuses (`function_acl_replaceable`) rather than being
assumed revoked.

| function | EXECUTE | SET |
|---|---|---|
| `record_check_billing_event()` | `checksops`, owner | `row_security=off`, `search_path=public` |
| `accrue_mortgage_ops_billing(uuid)` | `PUBLIC`, `authenticated`, `checksops`, owner | `search_path=public` |
| `earn_mortgage_agent_compensation(uuid)` | owner | `row_security=off`, `search_path=public` |
| `tg_record_mortgage_handling_billing()` | `PUBLIC`, `checksops`, owner | `search_path=public` |

The definitions use `pg_get_functiondef`'s `SET name TO 'value'` form; the engine reads it as `SET name = value`
(`releaseFunctionDefinitions`, added with this tooling; no other key's fingerprint changes).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql160` in
`release-sql-specs.mjs`). Intended `fae1623bb898f879f738bcd639be0238f5e111ebe25a985534a51be2b2903a40`
(`releaseIntendedHash('sql160', file bytes)`):

```
release sql160 v1
function public.record_check_billing_event(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=d08e05fbb554891d9357435fda6adf424126ac8e29f90600684a8f49b8b31dc6 acl=checksops EXECUTE;owner EXECUTE
function public.accrue_mortgage_ops_billing(uuid): lang=plpgsql vol=v parallel=u secdef=true result=public.check_billing_events config=search_path=public prosrc=4d34f049db708a2973dfc64bbe3ee9ac8fd3d2c888f5a3330412c31880b9a4cc acl=PUBLIC EXECUTE;authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.earn_mortgage_agent_compensation(uuid): lang=plpgsql vol=v parallel=u secdef=true result=public.mortgage_agent_compensation_entries config=row_security=off;search_path=public prosrc=9317a2ce9da03028de50fcc9aaabbc17d03f1eaaec7538dcc95bd501ed8c1bcc acl=owner EXECUTE
function public.tg_record_mortgage_handling_billing(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=search_path=public prosrc=12a9cceb1ccdee7a33a294d6d29d5d29af40c75f2334b17fd57447beaa289075 acl=PUBLIC EXECUTE;checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (production).** The four functions with the inspected bodies, everything else as above:

```
release sql160 v1
function public.record_check_billing_event(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=8319ec76fd6e2704e119429e7b481054dfa9f92b6a9ee52a1a2dda61e710a8a9 acl=checksops EXECUTE;owner EXECUTE
function public.accrue_mortgage_ops_billing(uuid): lang=plpgsql vol=v parallel=u secdef=true result=public.check_billing_events config=search_path=public prosrc=fc03a9ea7d2a0783f0398309a4500412cbf8fba49801f1eeffc690ca2f727524 acl=PUBLIC EXECUTE;authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.earn_mortgage_agent_compensation(uuid): lang=plpgsql vol=v parallel=u secdef=true result=public.mortgage_agent_compensation_entries config=row_security=off;search_path=public prosrc=6d72d6df8c41c51a2f9cfbd6145dc5cf4f25427ed2af781a925d72c660b31e8b acl=owner EXECUTE
function public.tg_record_mortgage_handling_billing(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=search_path=public prosrc=f022f75ac73f23fdec4a92205466a0b05febdf197642ce7af85110519f2fbe1e acl=PUBLIC EXECUTE;checksops EXECUTE;owner EXECUTE
```

That is `3a8bb0b11d59688642c98ace91bb15c562c362eea00b2ae9c73a166fee365229` (`releaseIntendedHash('sql160', fixture text)`:
the fixture's bodies with the spec's observed attributes). Staging's pre-state is whatever its own read-live reads:
`accrue_mortgage_ops_billing` and `tg_record_mortgage_handling_billing` have no repository CREATE, so staging may differ
(a body neither inspected nor SQL 160's is refused by the file and is a stop). Each pin records its own environment's
read; neither value is written into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the four functions, `deposit_items.check_id` and `.provider`, `check_billing_events.event_type`
and `.check_intake_item_id`, `mortgage_handling_requests.claim_id`, `mortgage_agent_compensation_rates.additional_cents`,
`aws_check_billing_charges_when_per_check_off()`, `aws_check_billing_default_price_cents()`, roles `checksops` and
`authenticated`); `functions_owned_by_login`; `function_results_match`; `function_acl_replaceable` (no live grant outside
the observed ACL). The spec format has no trigger prerequisite: `trg_record_check_billing_event`,
`tr_record_mortgage_handling_billing`, `tr_accrue_mortgage_ops_billing` and `tr_earn_mortgage_agent_compensation` are not
changed and not checked by the file either.

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 160 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql160-no-additional-check-or-manual-deposit-fee`. Expected
   `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`. Otherwise stop. Record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`, wave 51) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql160 … --phase inspect`); expected live
   `3a8bb0b1…`. Record `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record
   the staging runs in `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed
   change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql160
   --approval-scope sql160 … --phase apply` with the owner's words (authorization phrase
   `STOP_ADDITIONAL_CHECK_AND_OUTSIDE_DEPOSIT_CHARGES`).
4. Record the apply and retire the pin (`execute: false`).

Rollback (not part of this pin; a reviewed step of its own if ever needed): re-create the four inspected bodies from the
fixture through the guarded path as a new numbered migration.
