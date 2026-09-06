# Post-parity RDS overlay and final cutover readiness

**STOP FOR REVIEW.** This is an audit after PR **#135** and the targeted live `checksops` trigger overlay. It is **not** authorization to select T0 or cut over.

Leave **PR #125** open/unmerged.

## Scope

1. Apply **only** `aws/write-path/sql/39_parity_payee_mirror_trigger_only.sql` to AWS production-target RDS `checksops`.
2. Re-run targeted schema / trigger / RLS / stage-status reconciliation.
3. Verify a read-only historical check-image sample on AWS S3.
4. Reconfirm the full readiness matrix from current `main` after #135.

## Explicitly not done

- T0 / production write freeze
- DNS / auth switch
- Cognito user import
- Webhook redirect
- Moov / CheckAlt / Stripe enablement
- `64_financial_activation_grants.sql`
- Lovable/Supabase production writes
- Bridge teardown
- Recreate `checksops_rehearsal_20260906`
- Apply `38_parity_payee_mirror_and_returns.sql` to live `checksops` (columns + GRANTs)

## Pre-apply gates

- Confirm current `tg_mirror_payee_to_endorsement` body (artifact `pre_apply_function_body.sql`)
- Confirm 39 is function-only (no `ALTER TABLE`, no `GRANT`, no orphan-row `DELETE`)
- Confirm required `returned_*` / `return_*` columns already exist
- Confirm oneshot `apply_parity_ddl` still refuses live `checksops`

## Live apply

Oneshot step `apply_trigger_parity` with `confirmChecksopsTriggerParity=true` and `ddlOnly=true`.

Transactional probe `validate_trigger_rename_txn` inserts a synthetic payee, renames it, asserts one unsigned endorsement with the new name, then **ROLLBACK**. Leftover probe rows must be 0.

## Verdict

Filled after the live driver run. See `post_parity_readiness.json` in the walkthrough artifacts.

| Check | Result |
|---|---|
| LOVABLE → AWS APPLICATION PARITY | pending live audit |
| DATABASE PARITY | pending live audit |
| HISTORICAL STORAGE / CHECK IMAGE PARITY | pending live audit |
| FINAL CUTOVER READINESS | pending live audit |
