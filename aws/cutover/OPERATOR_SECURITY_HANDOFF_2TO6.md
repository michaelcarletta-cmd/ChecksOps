# Security Hardening #2–#6 handoff — STOP: SNS pending cannot be replaced

**Date:** 2026-09-08 (AlertSubscription CFN repair)  
**STOP FOR REVIEW.** `#6` was **not deployed**. Temporary role **not**
deleted. Topic ARN/name unchanged.

Caller: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorSecurityHardeningTemp/checksops-sec-hard`

## What was executed

Two CloudFormation change sets on `checksops-production-security-sns`.
Each change set touched **only** `AlertSubscription`. `AlertTopic` was
not replaced.

| Step | Change set | Action | Result |
|---|---|---|---|
| 1 | `sns-drop-stale-alertsub-20260908` | **Remove** `AlertSubscription` | Stack `UPDATE_COMPLETE`. CFN did **not** delete the pending sub. Event: `Cannot delete a subscription which is pending confirmation. Detaching subscription from stack.` |
| — | CLI `sns unsubscribe` (only because CFN could not delete) | Unsubscribe stale ARN | **Denied:** `Cannot unsubscribe a subscription that is pending confirmation` |
| 2 | `sns-recreate-alertsub-20260908` | **Add** `AlertSubscription` | Stack `UPDATE_COMPLETE`. SNS `Subscribe` returned the **same** pending ARN |

## After state

| Check | Result |
|---|---|
| Topic | `arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts` (unchanged; original create `2026-09-07T17:49:15Z`) |
| Endpoint / protocol | exactly `security@checksops.com` / `email` |
| Subscriptions for that endpoint | **exactly one** |
| List API ARN | `PendingConfirmation` |
| Real ARN | `arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts:5365a46f-f2cd-4af0-b21e-00222be734b5` (**same as before**) |
| `PendingConfirmation` | `true` |
| Confirmed / Pending / Deleted | `0` / `1` / `1` |
| Stack parameter | `CreateEmailSubscription=true` |
| `#6` stack | does not exist |

CloudTrail `Subscribe` at `2026-09-08T09:54:25Z` returned that same ARN.
A new confirmation message is **not** expected from this recreate.

## Why a fresh confirmation cannot be forced

AWS will not delete an email subscription that is still
`PendingConfirmation`:

- CloudFormation detaches it from the stack instead of deleting it
- `sns unsubscribe` is rejected for the pending ARN
- `sns subscribe` / CFN create on the same topic+protocol+endpoint is
  idempotent and reattaches the existing pending ARN
- Console **Request confirmation** already produced no Exchange trace

[AWS SNS delete docs](https://docs.aws.amazon.com/sns/latest/dg/sns-delete-subscription-topic.html):
unconfirmed email subscriptions are removed automatically after **48
hours**. Original create was `2026-09-07T17:49:17Z` (about
**2026-09-09T17:49Z** if the timer is from first create). Console
Request confirmation may reset that timer.

Do **not** delete or recreate the topic. Do **not** deploy `#6`.

## Recommended next action

1. Check Exchange Message Trace around `2026-09-08T09:54:25Z` for
   `no-reply@sns.amazonaws.com` in case AWS sent mail anyway. Confirm
   only if a **new** message arrived.
2. If there is no new mail: wait until SNS auto-deletes the unconfirmed
   subscription (pending count `0`, list empty). Then
   `CreateEmailSubscription=true` (already true) needs a real create:
   set `false` then `true` again **after** the pending sub is gone, so
   Subscribe is no longer idempotent against a live pending ARN.
3. After `Confirmed`, reopen `#6`.

## Deployments

| # | Service | Result |
|---|---|---|
| 1–5 | CloudTrail / SNS / Config / GuardDuty+Hub / Flow | **PASS** (topic unchanged this turn) |
| 6 | CloudWatch alarms | **NOT DEPLOYED** — still waiting for Confirmed SNS |

## Holds

- No alarm create
- No new SNS topic
- Temp role kept
- Trail stack kept
- Flags still false; `64_` still `NOT_APPLIED`
