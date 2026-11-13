# Production SQL 164 (transfer to bank: the wallet_withdrawal leg and the tenant's own limits)

| key | file | what it does |
|---|---|---|
| `sql164` | `aws/workflows/sql/164_wallet_withdrawal_leg_and_limits.sql` (sha256 `dcf259b4b91bf2ab133a7a433644aed56f7a389db88fa1042aba9875f6953897`, authored by `82a65d161`) | Refuses without its prerequisites (`55000 sql164_prerequisite_missing`) or unless the applying login owns `payment_transfers`, `payment_event_log` and `tenant_wallet_funding_settings` without FORCE ROW LEVEL SECURITY (`55000 sql164_definer_cannot_write`); then replaces SQL 109's Moov webhook writer with the `wallet_withdrawal` leg added, and adds two nullable limit columns with their CHECKs and column grants. |

**Why.** Owner 2026-11-13: "Build the transfer to bank" (design `docs/WALLET_TO_BANK_TRANSFER_DESIGN.md`, #1849, with the
owner's decisions: no fee; limits up to the tenant; any member; same-day ACH; any amount up to the balance; no admin
approval; the `wallet.fund` two-factor; no email; operating wallet only).

- The new API handler `providers/production/moov-wallet-withdraw.mjs` records each transfer to bank as a
  `payment_transfers` row with `leg_role = 'wallet_withdrawal'`.
- SQL 109's `aws_moov_webhook_apply_transfer_status` answers `not_owned` for every leg other than `wallet_funding`,
  `send_wallet` and `send_bank`, so a withdrawal's Moov status (completed, failed, returned, NOC) would never reach
  ChecksOps. The status catch-up job (`moov-status-catch-up.mjs`) routes the legs SQL 109 owns to the same writer.
- SQL 146's `aws_moov_apply_collection_leg_status` needs no change: it already answers `not_owned` for every leg that
  is not a tenant-collection-v2 or monthly-subscription leg, a withdrawal included.

**What it does.**
- `CREATE OR REPLACE public.aws_moov_webhook_apply_transfer_status(...)` with one change: the owned legs are
  `wallet_funding`, `send_wallet`, `send_bank` and `wallet_withdrawal`. Everything else is SQL 109's, unchanged (the
  webhook-apply gate, input checks, the one row locked by provider / environment / provider_transfer_id, idempotency
  per Moov event, never moving backwards, returns and NOCs, the `payment_event_log` row, SECURITY DEFINER,
  `search_path = public`, EXECUTE `checksops` and the owner). The function comment names SQL 164.
- `public.tenant_wallet_funding_settings.wallet_withdraw_max_per_transfer_cents` and
  `wallet_withdraw_max_per_day_cents`: `bigint`, nullable, no default (NULL = no limit), each with a NULL-or-positive
  CHECK (`tenant_wallet_funding_settings_withdraw_per_transfer_check`, `..._withdraw_per_day_check`); column INSERT and
  UPDATE on exactly these two for `checksops`, as SQL 140 granted the other settings columns. The table's RLS
  (`aws_write_tenant_wallet_funding_settings`, SQL 136's money-write gates) keeps each tenant to its own row.

Not changed: no other function (SQL 146 included), policy, RLS setting, table grant, index or trigger; no row is
written by the apply; no money moves. No API, Lambda or SPA change is part of this pin: the API handler and the
Wallet & Treasury button (hidden behind `SHOW_WALLET_WITHDRAW` until the API is live) ship afterwards through their own
guarded paths.

**Status:** staging pin execute-authorized (wave 55); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-13).** Run 43439497274 (main `6abf428bb`, after executor inspect run 43438326981 and executor deploy
run 43438851836 (executor CodeSha256 `ND9sboqs…` -> `p+7b7mGH…`)), under the owner's words "Start the SQL 164 staging refresh
and read-live": `already_applied` false, `precondition_failures` `[]`; SQL 109's function, the columns and checks absent. Live
`51e721c14833afe91c1236bd618735b2adb75e7acc2f01b03c109c98ab9c19d7`, equal to the derived pre-state; intended `0659d381…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 55) on the owner's words "Do the SQL 164 staging pin and apply". The
staging apply is a separate run after this pin is merged and the executor is redeployed carrying it.

Production authorization phrase (pin `authorization_phrase`): `ENABLE_WALLET_TRANSFER_TO_BANK_LEG_AND_LIMITS`.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql164` in
`release-sql-specs.mjs`). Intended `0659d3819ac167d8724bfc78d8e5dc7f6e86c82b48a07c0539891ac9714750ff`:

```
release sql164 v1
function public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=e45a63dfd8cfd84704b54249a63cec630a390754bc802bb3e4c738fb4ca1c2da acl=checksops EXECUTE;owner EXECUTE
column public.tenant_wallet_funding_settings.wallet_withdraw_max_per_transfer_cents: bigint notnull=false default=- acl=checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.wallet_withdraw_max_per_day_cents: bigint notnull=false default=- acl=checksops INSERT;checksops UPDATE
constraint public.tenant_wallet_funding_settings tenant_wallet_funding_settings_withdraw_per_transfer_check: c3ce22dece26b3f72aa724347a2a594acdc217060439401039aa2a91980e1012 validated=true
constraint public.tenant_wallet_funding_settings tenant_wallet_funding_settings_withdraw_per_day_check: cc252b0606ce614471726e13ed6ff348d87f1f30decc20cbbd4db5d31cf0ded0 validated=true
```

**Expected pre-state (both environments).** SQL 109 applied: its function exactly as SQL 109 defines it; the two
columns and checks absent:

```
release sql164 v1
function public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=9d428fd93b9128395f6a82ec30e8228e038e258fd6ec104d83cfa5036e769884 acl=checksops EXECUTE;owner EXECUTE
column public.tenant_wallet_funding_settings.wallet_withdraw_max_per_transfer_cents: absent
column public.tenant_wallet_funding_settings.wallet_withdraw_max_per_day_cents: absent
constraint public.tenant_wallet_funding_settings tenant_wallet_funding_settings_withdraw_per_transfer_check: absent
constraint public.tenant_wallet_funding_settings tenant_wallet_funding_settings_withdraw_per_day_check: absent
```

That is `51e721c14833afe91c1236bd618735b2adb75e7acc2f01b03c109c98ab9c19d7` (`releaseStateHash('sql164', { functions: SQL 109's function })`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `predecessors_applied` (SQL 109); `function_acl_replaceable`, `functions_owned_by_login` and
`function_results_match`; `added_columns_absent_or_intended` and the constraints absent or intended;
`definer_can_write_relations` on `payment_transfers` and `payment_event_log`.

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps (each its own reviewed PR or owner-approved run)

1. Staging read-live (`guarded-staging-sql-executor.yml`, choice `sql164-wallet-withdrawal-leg-and-limits`), then the staging pin PR and the staging apply.
2. Production read-only inspect: `production-sql-one-shot.mjs --migration sql164 --phase inspect` (`ops/production-sql-one-shot.md`).
3. Production pin PR: record `production_inspect` and `staging_acceptance`, set `execute: true`; the owner merges it.
4. Production apply: `--phase apply` with the owner's exact words.
5. Record PR: the `applied` block, `execute: false`.
