# Production SQL 120 (usage events at Check Alt approval and at send time)

| key | file | what it does |
|---|---|---|
| `sql120` | `aws/workflows/sql/120_usage_events_at_approval_and_send.sql` (sha256 `aa7d44c3b0de31cec012bc04ece0591553fafb1a9f97f46f0b4a9168b10d6fc2`) | Records the per-check usage event when a Check Alt deposit is approved or accepted, and the next-day / same-day fee when a send is posted, per recipient and linked to the check's claim; voids either, uninvoiced, when it did not go through. Adds the one-fee-per-leg unique index and backfills October 2026. |

**Why.** The owner, 2026-10-27: "I processed 1 check this month and it didn't register on freedom
usage", and "when a user chooses same day or next day that cost of $0.75 or $1.00 should
automatically show up on their usage and for what claim check". Owner rule: "we don't want users
being charged if the check didn't go thru".

- SQL 98's `record_check_billing_event` records `check_processing` only when a check becomes
  `deposited`. A check deposited through Check Alt never does (its `checkalt_deposits` row goes
  `submitted`, then `cleared`), so it was never counted.
- The next-day / same-day fee was only computed at month end (`tenant-billing-engine.mjs`
  `persistMoovUsageForPeriod`), so usage showed nothing during the month and never named the check.

**What it adds.**

- `aws_checkalt_deposit_billing_event` (AFTER INSERT OR UPDATE OF status ON `checkalt_deposits`):
  when a deposit becomes `submitted` or `cleared`, one `check_processing` event for the check at
  SQL 98's price (`aws_check_processing_price_cents`: the tenant's per-check rate when per-check
  billing is on, else the active default). One per check: an existing event is kept; a voided,
  uninvoiced one is recorded again. When the deposit then becomes `rejected`, `error` or
  `duplicate`, the uninvoiced event is voided unless another deposit of the check is approved or the
  check is `deposited`. Pending, pending-approval, rejected-before-approval and errored deposits
  record nothing. Returns keep the event (a return is its own fee, later work).
- `aws_payment_transfer_send_speed_fee` (AFTER INSERT OR UPDATE OF status ON `payment_transfers`):
  for send legs (`send_wallet`, `send_bank`) of a check, when the first leg of a recipient is
  posted (leaves `ready` for anything but failed or canceled), one `moov_next_day` (standard) or
  `moov_same_day` event at the tenant's `next_day_rate_cents` / `same_day_rate_cents`, else 75 /
  100 cents; `payment_transfer_id` = that leg, `claim_id` = the check's claim. A recipient's legs
  share `provider_metadata` `request_hash` and `recipient_index`, so a wallet leg plus a bank top-up
  is one fee. Voided, uninvoiced, when every leg of the recipient failed or was canceled. A held send
  (legs stay `ready`) records nothing; a returned transfer keeps the fee; instant has no fee here.
- `check_billing_events_transfer_event_uidx` (unique `(payment_transfer_id, event_type)` where
  `payment_transfer_id` is set), unless a unique index on those columns (and at most `tenant_id`)
  exists. The tools refuse (`unique_covered_or_no_duplicates`) while duplicates exist and none
  covers them (inspect count `check_billing_event_transfer_duplicates`).
- Backfill from 2026-10-01: approved or accepted Check Alt deposits whose check has no
  `check_processing` event, and posted, not failed or canceled send legs whose recipient has no
  fee, each billed when it happened (`submitted_at`, else `created_at`). Nothing earlier is touched.

Not changed: no policy, no grant to `checksops`, no table or column; SQL 98's
`record_check_billing_event` and its trigger. The functions are EXECUTE for their owner only.

**Month-end billing.** Until the later Lambda step (`tenant-billing-engine.mjs`: bill only these
send-time events, skip voided ones, send legs only) is deployed, the month-end engine finds the
event SQL 120 wrote for a leg and reuses it, so nothing is billed twice.

**Status:** not applied anywhere. The staging pin and the production pin are pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql120` in `release-sql-specs.mjs`): each function's attributes, body hash and EXECUTE ACL, the
two triggers' definitions and whether a unique index covers `(payment_transfer_id, event_type)`.
The backfill writes rows only and is not part of it. Intended
`fc9d0e340d0a469440a8bbfd3d546ededbe4f035c12c584334a2a610c55ffc56`:

```
release sql120 v1
function public.aws_check_processing_price_cents(uuid): lang=plpgsql vol=s parallel=u secdef=true result=integer config=row_security=off;search_path=public prosrc=b353e26fc5ecf8a659e1ca7d85e3fe42533eed437236484158f99488aa691c05 acl=owner EXECUTE
function public.aws_record_checkalt_billing_event(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=6fb97046ec24844a2802872b10abc5e62bdd50e1387536eb953b558b34735e41 acl=owner EXECUTE
function public.aws_send_speed_fee_type(text): lang=sql vol=i parallel=u secdef=false result=text config=search_path=public prosrc=7218a7baf0a6af67e9e664e3d515d12f937d8600f4522df91a2f2edcc51b0435 acl=owner EXECUTE
function public.aws_send_speed_fee_cents(uuid, text): lang=sql vol=s parallel=u secdef=true result=integer config=row_security=off;search_path=public prosrc=fec4b41771273667410340544368c826efea22da39b9f4a845551b4fa7b20d54 acl=owner EXECUTE
function public.aws_record_send_speed_fee(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=900e7548e7aa5a6d1103c585ce025fc3552ee63e5abc80690f9acbff7ddb57fb acl=owner EXECUTE
trigger public.checkalt_deposits aws_checkalt_deposit_billing_event: enabled=O def=686b6e8744bd605fffce8fac1171ce7edf04dd8cffc3160bf1bd21537f2a7109
trigger public.payment_transfers aws_payment_transfer_send_speed_fee: enabled=O def=b88a799ffd973b421a4fd151cefa1cacf4d7fc74795bf9e13b6e048db9009eb9
unique public.check_billing_events transfer_event (payment_transfer_id,event_type): covered=true
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the five tables, every column the triggers read or write, SQL 98's
`aws_check_billing_default_price_cents()` and `aws_check_billing_charges_when_per_check_off()`,
SQL 96's tenant rate columns); `altered_relations_owned_by_login` (`checkalt_deposits`,
`payment_transfers`, `check_billing_events`); `functions_owned_by_login`;
`function_acl_replaceable`; `definer_can_write_relations` (`check_billing_events`);
`unique_covered_or_no_duplicates`.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 120 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql120-usage-events-at-approval-and-send`. If it reports
   `prerequisites_missing` other than `[]`, stop: a column differs from the repository's record.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then
   `read-live` again. Test on staging: approve a Check Alt deposit and send next-day and same-day
   payments; each shows on the tenant's usage.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql120 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql120 --approval-scope sql120 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`).
