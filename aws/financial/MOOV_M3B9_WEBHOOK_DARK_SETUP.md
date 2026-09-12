# Moov M3b.9 — AWS production webhook dark setup (STOP BEFORE CREATION)

**Status:** STOP FOR REVIEW.  
**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-9-a508`

No webhook was registered, updated, or deleted. Lovable/Supabase webhook is unchanged. AWS secrets were not written. Money flags remain false. SQL 72 **NOT_APPLIED**. Zero money movement.

---

## AWS WEBHOOK ENDPOINT

`https://checksops.com/prep/webhooks/moov`

This is the existing production-prep handler (`POST /webhooks/moov` after the HTTP API stage prefix is stripped). **Do not create a second handler.**

| Probe | Result |
| --- | --- |
| `GET https://checksops.com/prep/health` | **200**, CloudFront |
| `GET https://checksops.com/prep/webhooks/moov` | **404** (POST-only) |
| `POST https://checksops.com/prep/webhooks/moov` unsigned | **401** `invalid_signature`, `productionWebhooksRedirected=false` |
| `POST https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/webhooks/moov` | **403** Forbidden (origin-verify **require**) |

Moov must use the **CloudFront HTTPS URL**. Direct execute-api is denied. `/prep` and `/prep/*` allow POST. HTTP API `$default` uses the origin-verify REQUEST authorizer only (no Cognito JWT). `AWS_MOOV_WEBHOOK_SECRET` is **not** set on the prep Lambda.

Equivalent alias `https://www.checksops.com/prep/webhooks/moov` is also on this distribution. Register the **apex** URL so it matches the production Origin `https://checksops.com`.

---

## HANDLER READINESS: PASS

Existing `handleProviderWebhook` on `checksops-production-prep-api` is the correct production-prep receiver.

| Requirement | Evidence |
| --- | --- |
| Signature required | `verifyMoovSignature` before any persist |
| Raw body preserved | `rawEventBody` uses API Gateway raw/base64 body, not re-serialized JSON |
| Invalid signature rejected | Live unsigned POST **401**; unit test invalid signature **401** |
| Valid events persisted | Idempotent insert into `aws_provider_webhook_receipts` after verify |
| Production `applied=false` | `PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED = false`; production events overwrite apply to `applied: false` |
| No transfer/status/account/payment mutation | Production apply never updates `payment_transfers` / accounts / methods; `createdTransfer: false`; `liveProviderCalled: false` |
| Replay / idempotency | 5-minute timestamp window + unique `(provider, external_event_id)` `ON CONFLICT DO NOTHING` |
| Safe logging | `sanitizeWebhookPayload` redacts secret/bank/token keys; payload `tenant_id` ignored |
| Cannot enable money flags | Webhook does not write Lambda env or Secrets Manager |
| Sandbox apply cannot run now | `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false` so `sandboxWebhookApplyEnabled()` is false |
| Dry-run | `AWS_PROVIDER_WEBHOOK_DRY_RUN=true` |

`MOOV_WEBHOOK_SECRET` is **not** in `checksops/production/provider` yet. Until it is stored, every live POST fails closed at signature check. That is expected. Do **not** register Moov until the secret is stored and the Lambda secret cache is recycled.

Lovable `moov-webhook` (`verify_jwt = false`) remains the live apply path. AWS is dark.

---

## SIGNATURE VERIFICATION: PASS

Matches current Moov docs and Lovable:

- HMAC-SHA512 hex over `X-Timestamp|X-Nonce|X-Webhook-ID`
- Compared to `X-Signature` (timing-safe)
- Headers: `X-Timestamp`, `X-Nonce`, `X-Webhook-ID`, `X-Signature`
- 5-minute skew window
- Legacy Svix-style body HMAC is accepted as fallback (same as Lovable)

Each Moov webhook destination has **its own** signing secret. The AWS secret must be the secret for the **new** AWS destination, not the Lovable webhook secret.

---

## DARK `applied=false` ENFORCEMENT: PASS

Hard-coded `PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED = false`. If the payload maps to a production `payment_transfers` or `payment_provider_accounts` row, apply is forced `applied: false` and `financialTablesMutated: false`. Webhook cannot POST to Moov, create a transfer, or flip money flags.

---

## REPLAY PROTECTION: PASS

1. Timestamp outside 5 minutes → reject (no receipt).
2. Duplicate `eventID` → HTTP 200, `duplicate: true`, `applied: false`, no second apply.
3. Out-of-order status is recorded on the reconciliation candidate only; production row status is not written.

---

## MULTIPLE WEBHOOKS SUPPORTED: YES

Moov Dashboard **Developers → Webhooks → New webhook**. Docs: set up multiple webhooks subscribed to specific event types. SDK `webhooks.create` creates a **new** destination; `update`/`disable` would be required to change an existing one.

Creating a **new** AWS destination does **not** replace, disable, or change the Lovable URL **if the operator does not edit the existing row**.

Each destination has its own signing secret (`getSecret` / Dashboard Reveal).

---

## REGISTRATION METHOD: BOTH

Official setup guide is **Dashboard**. SDK/API `webhooks.create` also exists (can be created `status: disabled`).

**Do not register via API in this phase.** The create/getSecret response includes the signing secret. That value must not enter chat or agent logs. Dashboard + AWS Secrets Manager console keeps the secret off this transcript.

`MOOV_PLATFORM_ACCOUNT_ID` is still absent and must **not** be added to call the API.

---

## Minimum event subscriptions

Moov has **no** `transfer.completed` / `transfer.failed` event ids. Completed / failed / reversed / canceled arrive as `transfer.updated` with `data.status`.

Select **only**:

| Event | Why |
| --- | --- |
| `transfer.created` | Transfer created |
| `transfer.updated` | pending / completed / failed / reversed / canceled + rail updates |
| `account.updated` | Verification / profile changes |
| `capability.updated` | Capability status changes |
| `bankAccount.created` | Bank connected |
| `bankAccount.updated` | Bank verification |
| `paymentMethod.enabled` | ACH send/collect methods |
| `paymentMethod.disabled` | ACH send/collect methods |

Do **not** subscribe to card, invoice, refund, billing, networkID, representative, sweep, or “all events”.

Optional later (not this dark receiver): `dispute.created`, `walletTransaction.updated`, `balance.updated`.

---

## HUMAN ACTION REQUIRED (STOP BEFORE CREATION)

Do **not** edit, disable, or change the URL/secret of the existing Lovable webhook.

1. Open Moov Dashboard for the **same production application** that owns Freedom (`caid` `41cb5d67…2208` from M3b.7).
2. **Developers → Webhooks**. Confirm the current Lovable URL is listed. Leave it untouched.
3. Click **New webhook** (do not open the Lovable row and change its URL).
4. Endpoint URL: `https://checksops.com/prep/webhooks/moov`
5. Description: `ChecksOps AWS production-prep dark receiver`
6. Subscribe to the eight events in the table above.
7. If the UI allows **disabled** at create time, leave it disabled until step 9 succeeds. If it enables immediately, store the secret **before** Moov retries exhaust (401 until secret is loaded).
8. **Reveal** the new destination’s signing secret.
9. In AWS Secrets Manager, secret `checksops/production/provider`, add field **`MOOV_WEBHOOK_SECRET`**. Do **not** paste it into chat, tickets, or PR text. Do not copy the Lovable webhook secret into this field. Do not write `AWS_MOOV_WEBHOOK_SECRET`. Do not add `MOOV_PLATFORM_ACCOUNT_ID`.
10. After the secret is stored, tell the agent the field is present (no value). Lambda in-process secret cache must be recycled **without** sending the Environment blob (description-only `UpdateFunctionConfiguration` or code overlay). Then run the dark validation plan.

---

## Proposed API (DO NOT EXECUTE)

```http
POST https://api.moov.io/webhooks
Content-Type: application/json

{
  "url": "https://checksops.com/prep/webhooks/moov",
  "status": "disabled",
  "description": "ChecksOps AWS production-prep dark receiver",
  "eventTypes": [
    "transfer.created",
    "transfer.updated",
    "account.updated",
    "capability.updated",
    "bankAccount.created",
    "bankAccount.updated",
    "paymentMethod.enabled",
    "paymentMethod.disabled"
  ]
}
```

SDK equivalent: `moov.webhooks.create({ ... })` then `webhooks.getSecret({ webhookID })`. Exact account-scoped path may be `/accounts/{platformAccountID}/webhooks`. **Do not call this.** Do not add `MOOV_PLATFORM_ACCOUNT_ID` to make it callable.

---

## NEXT VALIDATION PLAN (do not execute yet)

After the new destination exists **and** `MOOV_WEBHOOK_SECRET` is loaded:

1. **Invalid signature:** unsigned `POST` to the AWS URL → **401**, no `aws_provider_webhook_receipts` row, `applied` absent/false.
2. **Valid signature:** Dashboard **Send test webhook** (`event.test`) or Moov `webhooks.ping` → AWS **200**, receipt inserted, `applied=false`, `financialTablesMutated=false`, `liveProviderCalled=false`.
3. **Replay:** POST the same `eventID` twice → second `duplicate=true`, `applied=false`.
4. **Lovable still live:** existing Dashboard webhook row still has the Supabase URL; a real/test event still appears in Lovable `payment_webhook_events`. Do not disable that row to prove this.
5. **AWS dark:** receipt `dry_run=true`; production `payment_transfers` / `payment_provider_accounts` / `payment_provider_methods` / `external_payment_recipients` unchanged; Freedom transfer count still 0.
6. **Safety recheck:** money flags false, SQL 72 NOT_APPLIED, Lovable unchanged, no `MOOV_PLATFORM_ACCOUNT_ID`.

---

## Safety recheck (this phase)

| Check | Result |
| --- | --- |
| Webhook registered/updated/deleted | **no** |
| Lovable webhook | **unchanged** (`productionWebhooksRedirected=false`) |
| AWS secrets written | **no** |
| `MOOV_WEBHOOK_SECRET` present | **false** |
| `MOOV_PLATFORM_ACCOUNT_ID` | **not added** |
| Money flags | execution **false**; live-reads **true**; webhook dry-run **true** |
| `moov-transfer-create` | **403** `production_execution_blocked` |
| SQL 72 | **NOT_APPLIED** |
| Money moved | **$0.00** |

**STOP FOR REVIEW.** Do not register the AWS webhook yet. Do not enable money execution. Do not apply SQL 72. Do not move money.
