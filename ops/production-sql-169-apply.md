# Production SQL 169 (deleting a check keeps its ChecksOps charges)

| key | file | what it does |
|---|---|---|
| `sql169` | `aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql` (sha256 `df8f8e35b5a7df1ae30f7330d9b0665cc08036ef92895a771ca7d03929a8970f`, authored by `70af8044a`) | Refuses without its prerequisites (`55000 sql169_prerequisite_missing`), when `check_billing_events.check_intake_item_id` is NOT NULL (`55000 sql169_column_not_nullable`) or the key on that column is not exactly the Supabase CASCADE key (`55000 sql169_unexpected_foreign_key`); then replaces `check_billing_events_check_intake_item_id_fkey` with the same key `ON DELETE SET NULL`. |

**Why.** Owner 2026-11-16: two checks could not be deleted. One was refused with "This check cannot be deleted because
it has dependent financial/provider records (check_billing_events)" (the other names `deposit_items`, a deposited check,
which stays refused). Asked what a delete of a check that has a ChecksOps charge should do, the owner chose "Delete, keep
charge (Recommended)": the check is removed and its charge stays in billing history, unlinked from the deleted check.
Today the delete-check API (`aws/functions/api/workflow-delete-check.mjs` `FINANCIAL_DELETE_BLOCKERS`,
`aws/functions/api/workflow.mjs`) refuses any check with a `check_billing_events` row, and the database could not keep the
row anyway: `check_billing_events.check_intake_item_id` references `check_intake_items(id)` `ON DELETE CASCADE` (the
inline `REFERENCES` of `supabase/migrations/20260501204336_0cf22f8b-4276-451b-a50c-69a58bbdb5a1.sql`, so the key is named
`check_billing_events_check_intake_item_id_fkey`), and deleting the check would delete its charges.

**What it does.**
- Accepted predecessor: exactly one foreign key on `check_billing_events (check_intake_item_id)`, named
  `check_billing_events_check_intake_item_id_fkey`, `FOREIGN KEY (check_intake_item_id) REFERENCES
  public.check_intake_items(id) ON DELETE CASCADE`. The column must be nullable (Supabase dropped its NOT NULL in
  `20260605163443`); a NOT NULL column refuses rather than being changed here. The key is compared on `pg_constraint`
  (referenced table and column, `confdeltype` `c`, ON UPDATE NO ACTION, MATCH SIMPLE, not deferrable, validated), not on
  `pg_get_constraintdef`'s text, whose rendering of the referenced table depends on the session's `search_path`.
- Drops that key and adds it again under the same name `ON DELETE SET NULL`. Adding it validates the existing rows, which
  the old key already held to the same rule.
- Idempotent: an already `ON DELETE SET NULL` key is left as it is (`sql169_foreign_key_already_current`).

After it, deleting a check sets `check_intake_item_id` NULL on that check's `check_billing_events` rows; every other
column (`tenant_id`, `claim_id`, `event_type`, `status`, amounts, `payment_transfer_id`, `source_kind`/`source_id`)
stays. The key's action runs as the owner of `check_billing_events`, past its RLS (the table is not FORCE ROW LEVEL
SECURITY; SQL 136's restrictive write gates do not apply to it). No CHECK constraint requires the column; the unique
indexes on it (SQL 84 `one_mortgage_ops_per_check`, SQL 98 `check_event_uidx`, SQL 153
`one_second_mortgagee_per_check`) treat NULL as distinct or are partial on `IS NOT NULL`; SQL 154's
`aws_check_billing_event_starter_package` fires on INSERT or `UPDATE OF status` only. The billing engine
(`tenant-billing-engine.mjs`) reads charges with `LEFT JOIN check_intake_items`, so an unlinked charge still counts.

**Not changed:** no other constraint, column, index, trigger, function, policy, RLS setting, grant or row. The API keeps
refusing the delete of a charged check until its own later step (a Lambda overlay of the delete-check code that drops
`check_billing_events` from the blockers and records the check's charges in `check_deletion_log`), which ships only after
this pin is applied in production. No API, Lambda or SPA change is part of this pin. Deposits, CheckAlt deposits,
disbursements, payments and payment directions keep blocking a delete.

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read. Staging
wave 61 when approved (wave 60 is SQL 168, the highest on main).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql169` in
`release-sql-specs.mjs`). Intended `30fc8ed4927c599b9f320ec07a2e535eaa07f86b55b5180a937c1d405dc19969`:

```
release sql169 v1
constraint public.check_billing_events check_billing_events_check_intake_item_id_fkey: d6523e17cdce05714035bb7536a75e35c7d2956c5aaecda43e36da9aa69578ac validated=true
```

**Expected pre-state (both environments).** The Supabase CASCADE key, validated:

```
release sql169 v1
constraint public.check_billing_events check_billing_events_check_intake_item_id_fkey: 180134c8a31665696a73bbcb0955d0a2701769cd88c391c619a67cb501210add validated=true
```

That is `f7530ea5e4b9ff3d8dc74911ffeadfe9b38dd6fd867ca3edacbc9ec65c8c4a40` (`releaseStateHash('sql169', …)` of that
key). Each pin records its own environment's read; neither value is written into a pin before a run reads it. A
pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`check_billing_events`, `check_intake_items`, `check_billing_events.check_intake_item_id`,
`check_intake_items.id`); `altered_relations_owned_by_login` on `check_billing_events` (the table that holds the key).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 169 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql169-check-billing-events-keep-charge-on-check-delete`.
   Expected `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `f7530ea5…`.
   Otherwise stop. Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved
   `authorization`, `execute: true`, wave 61) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql169 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql169
   --approval-scope sql169 … --phase apply` with the owner's words (authorization phrase
   `KEEP_CHARGES_WHEN_CHECK_IS_DELETED`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API: the delete-check change (staging overlay, then production with the owner's words), its own PRs.

Rollback (not part of this pin; a reviewed step of its own if ever needed): replace the key with the CASCADE one again.
Charges already unlinked by deletes stay unlinked.
