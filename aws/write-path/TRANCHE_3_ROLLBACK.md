# Tranche 3 write rollback

Disable Tranche 3 operational writes without affecting AWS reads, Tranche 1 prefs/read-receipts, or production ChecksOps.

## Storage-only flag

On Lambda `checksops-staging-api`:

Set `AWS_STORAGE_WRITES_ENABLED=false`.

`POST /storage/upload-url`, `/storage/delete`, and `/storage/move` then return `403 uploads_disabled`. Sign/list/download continue.

## Check-workflow flag

Set `AWS_CHECK_WORKFLOW_WRITES_ENABLED=false` to disable T2+T3 table DML (`check_messages` INSERT, `check_files`, `claim_checks`, image paths, plus T2 tables). Tranche 1 continues if `AWS_WRITES_ENABLED=true`.

## Global kill switch

`AWS_WRITES_ENABLED=false` disables all AWS writes including storage writes (storage flag inherits). Reads continue.

## Optional GRANT revoke

`aws/write-path/sql/36_tranche3_revoke_write_grants.sql` as `checksops_admin` from a temporary in-VPC oneshot (`step=revoke`). Leaves T1/T2 grants. Delete the oneshot afterward.

## Do not

- Disable `trg_mirror_check_message_to_homeowner_ledger` or `trg_mirror_check_file_to_homeowner_ledger`
- Point production DNS at staging
- Disable production Supabase
- Call Moov, CheckAlt, Plaid, Actum, QuickBooks
