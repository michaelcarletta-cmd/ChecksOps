# Tranche 1 results

Live results are filled in after staging API deploy, GRANT oneshot, Cognito isolation tests, financial reconcile, and AWS-mode UI checks.

## Operations migrated

| Operation | Route | Table | Allowed columns | Identity |
| --- | --- | --- | --- | --- |
| Mark check message thread read | `POST /data/write` `op=upsert` (also insert/update/delete) | `check_message_reads` | `check_id`, `last_read_at` | `user_id` forced from mapped ChecksOps UUID |
| Load/save notification flags | `POST /data/write` `op=get_or_create` / `update` (also insert/delete) | `notification_preferences` | `in_app_enabled`, `email_enabled`, `sms_enabled` | `user_id` forced from mapped ChecksOps UUID |

## Authentication

Cognito ID token required. Unauthenticated → 401. Mapping: Cognito sub → `identity_accounts.application_user_id` → `request.app_user_id` → `auth.uid()`. Kill switch: `AWS_WRITES_ENABLED`.

## Placeholder until live validation

See the remainder of this file after the staging run. Production ChecksOps was not touched.
