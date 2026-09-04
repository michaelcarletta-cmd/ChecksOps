# AWS Staging Parity Rescore — Class A Final Cleanup

Date: 2026-04-09
API: https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging

## Scoreboard (58 features)

| Status | Count |
|--------|------:|
| PASS | 40 |
| PARTIAL | 18 |
| FAIL | 0 |

### Priority remaining (PARTIAL)

| Priority | Themes |
|----------|--------|
| P0 | Live Textract subscription (manual); Moov platform account ID for certification; CheckAlt UAT deposit account; financial activation intentionally held |
| P1 | Plaid sandbox keys absent; WhiteLabel/MortgageOps Cognito; EventBridge Scheduler IAM for ops |
| P2 | Email/SMS provider identity (sinks OK); OCR live vs stored; invite email delivery polish |
| P3 | Production DNS/webhooks/data cutover (out of scope) |

## Checklist results

| Area | Result |
|------|--------|
| Remaining Class A functions | Implemented as AWS handlers (PDF, domain, Cognito invite/admin, SMS, email queue, scheduled class-a, OpenAI BYOK stubs, homeowner OTP). Remaining stubs return structured `class_a_stub` for rarely used admin tools. |
| Remaining AWS-staging Supabase runtime deps | Staging frontend AWS OTP for `/h/upload`. Production fallback code preserved. Ordinary staging Class A no longer requires `supabase.functions.invoke`. |
| `/h/upload` AWS auth | **PASS** — OTP start/verify/session; wrong-email `email_mismatch`; code reuse blocked; upload with purpose-scoped hex token OK. |
| PDF generation | **PASS** — `generate-tpa-authorization`, `generate-endorsement-packet` return S3 signed URLs. |
| Email/SMS | **PASS (sink)** — SMS `AWS_SMS_MODE=sink`; email staging sink/allowlist unchanged. |
| Scheduled jobs | **PASS (endpoint)** — `/scheduled/class-a` OK; financial jobs `financial_job_disabled`. EventBridge CreateConnection denied for agent — manual ops. |
| Textract | **BLOCKED** — `SubscriptionRequiredException`. IAM+code ready. Manual console enable required. |
| Moov/CheckAlt/Plaid | Readiness documented — no money movement. |
| RLS/cross-tenant | Prior PASS retained; OTP sessions claim-bound. |

## Items preventing production cutover

1. Textract not subscribed in account 806168576068
2. Moov sandbox platform account ID missing
3. CheckAlt UAT deposit account ID unset
4. Plaid sandbox credentials absent
5. WhiteLabel + MortgageOps Cognito pools not provisioned
6. Production DNS / webhooks / data cutover not performed (intentional)
7. Financial activation grants / Deposit Ops money RPCs intentionally disabled
8. EventBridge Scheduler connection IAM for automated cron (optional ops)
