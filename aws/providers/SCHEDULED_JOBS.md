# Staging scheduled jobs (Class A safe)

## Inventory (Supabase → AWS)

| Job | Class | AWS status |
|---|---|---|
| `process-email-queue` | A | Ported — `POST /functions/v1/process-email-queue` + `/scheduled/class-a` |
| `tenant-domain-recheck-cron` | A | Ported stub (records/ops no-op until ACM DNS automation) |
| `check-ocr-backlog` | A | Staff Cognito invoke (RLS); schedule deferred |
| `deposit-daily-automation` | C/D | **Disabled** (`financial_job_disabled`) |
| `wallet-fund-on-clear` | C | **Disabled** |
| CheckAlt approve/poll crons | C | **Disabled** |

## Invocation

- Header: `x-scheduled-job-secret: $AWS_SCHEDULED_JOB_SECRET` (set on `checksops-staging-api`)
- `POST /scheduled/class-a` runs safe jobs only
- Idempotent: email queue drains `pending` rows; empty queue returns `processed:0`
- Tenant scoping: email/OCR/domain handlers use RLS or SECURITY DEFINER token paths

## EventBridge

Agent role lacks `events:CreateConnection`. Scheduled **HTTP endpoint is live and verified**.

Manual ops (optional): create EventBridge Scheduler/API Destination → `POST https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/scheduled/class-a` every 5 minutes with API key header `x-scheduled-job-secret`.
