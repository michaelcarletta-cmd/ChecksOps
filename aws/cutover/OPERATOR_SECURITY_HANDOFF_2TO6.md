# Security Hardening #2–#6 handoff — STOP: confirm support@ SNS email

**Date:** 2026-09-08 (temporary `support@checksops.com` subscription)  
**STOP FOR REVIEW.** `#6` was **not deployed**. Temporary role **not**
deleted. Topic ARN/name unchanged. `security@checksops.com` untouched.

Caller: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorSecurityHardeningTemp/checksops-sec-hard`

## What was executed

Change set `sns-add-support-alertsub-20260908` on
`checksops-production-security-sns`:

| Logical ID | Action |
|---|---|
| `TemporaryAlertSubscription` | **Add** only |
| `AlertSubscription` | not in change set |
| `AlertTopic` | not in the change set |

Stack `UPDATE_COMPLETE`. `sns subscribe` created a **new** pending ARN
for `support@checksops.com`.

## After state

| Check | Result |
|---|---|
| Topic | `arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts` (unchanged; create `2026-09-07T17:49:15Z`) |
| `support@checksops.com` | exactly one, protocol `email`, `PendingConfirmation=true` |
| Support ARN | `arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts:f9200315-a38c-4b3d-ace0-074b7aa143ae` |
| `security@checksops.com` | still one, still pending, ARN **`…:5365a46f-f2cd-4af0-b21e-00222be734b5`** |
| List | two email subscriptions, both `PendingConfirmation` |
| `#6` stack | does not exist |

Topic attribute `SubscriptionsPending` still reports `1` while the list
shows two pending endpoints. Use the list/GetSubscriptionAttributes
results as source of truth.

## Operator next

Open the AWS SNS confirmation mail in the `support@checksops.com`
mailbox (`no-reply@sns.amazonaws.com`) and click Confirm. Then reopen
`#6`. Do not wait on `security@`.

## Deployments

| # | Service | Result |
|---|---|---|
| 1–5 | CloudTrail / SNS / Config / GuardDuty+Hub / Flow | **PASS** (topic unchanged; extra email sub added) |
| 6 | CloudWatch alarms | **NOT DEPLOYED** — waiting for Confirmed `support@` |

## Holds

- No alarm create
- No new SNS topic
- `security@` pending sub not removed
- Temp role kept
- Trail stack kept
- Flags still false; `64_` still `NOT_APPLIED`
