# Tranche 2 write rollback

Disable check-workflow writes without affecting AWS reads, Tranche 1 prefs/read-receipts (unless the global switch is used), or production ChecksOps.

## T2-only flag (preferred for this tranche)

On Lambda `checksops-staging-api`:

Set `AWS_CHECK_WORKFLOW_WRITES_ENABLED=false`.

Authenticated `POST /data/write` for check-intake/payee/endorsement/audit/message-soft-delete then returns `403 check_workflow_writes_disabled`. `check_message_reads` and `notification_preferences` continue if `AWS_WRITES_ENABLED=true`.

## Global kill switch

`AWS_WRITES_ENABLED=false` disables **all** AWS writes including Tranche 1. Reads continue.

## Optional GRANT revoke

`aws/write-path/sql/34_tranche2_revoke_write_grants.sql` as `checksops_admin` from a temporary in-VPC oneshot (`step=revoke`). Does not revoke Tranche 1 grants. Delete the oneshot afterward.

## Do not

- Globally set `default_transaction_read_only=off`
- Point production DNS at staging
- Disable production Supabase
- Attach `checksops_admin` to API Policy4
