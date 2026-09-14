# AWS Moov webhook — Dashboard retest after SQL 67 — 2026-09-14

## Verdict

**MOOV DASHBOARD TEST PASS — WAITING FOR GENUINE PRODUCTION EVENT**

Newest request only. The AWS persistence bug is resolved. The only
remaining webhook proof is a real subscribed Moov production event.
The Lovable/Supabase webhook was not removed. SPA was not deployed.
No code, SQL, secrets, or destinations were changed during this
validation.

## Newest request

| Field | Value |
|---|---|
| Time | `2026-09-14T13:43:46.952Z` (APIGW) |
| Source | `34.133.111.85` (`85.111.133.34.bc.googleusercontent.com`) |
| Request | `POST /prep/webhooks/moov` |
| APIGW | `DsQDCiZUIAMEZ0w=` status **200**, `integrationStatus=200`, body **704** |
| Lambda | `752962c7-d0f6-41b3-935c-01998baa46d3` duration **243.94 ms**, no errors |
| CodeSha256 | `B8cQg1FnQzUSx7B/nANevkWrTCV/UPgX+e4GtXzlqvk=` (post-fix overlay) |

HTTP 200 is only returned after `verifyMoovSignature` succeeds.
Missing headers are `401 missing_signature_headers` (241 bytes).
Mismatch/window are `401 invalid_signature` (233 bytes). Signature
**PASS**.

## Persistence

New `aws_provider_webhook_receipts` row (8 total; was 7):

| Field | Value |
|---|---|
| id | `c26e0b73-3bb6-4d4b-8a23-40d8b5b516f6` |
| provider | `moov` |
| external_event_id | `ili6tybt6vhdzd2dzu7luxdjxq_evt` |
| event_type | `event.test` |
| dry_run | **false** |
| mapped_tenant_id | null (Dashboard ping has no account id) |
| received_at | `2026-09-14T13:43:47.439Z` |

New `payment_webhook_events` row:

| Field | Value |
|---|---|
| id | `368c2b99-d191-48ee-a172-c361c1a9d604` |
| provider / environment | `moov` / `production` |
| external_event_id | `ili6tybt6vhdzd2dzu7luxdjxq_evt` |
| event_type | `event.test` |
| provider_account_id / resource_id | null / null |
| received_at / processed_at | `2026-09-14T13:43:47.439Z` / `2026-09-14T13:43:47.439Z` |
| processing_error | null |

Idempotency: the same `external_event_id` is the unique key on both
tables. One receipt row, one event row, no duplicate groups. A replay
of this event id would `ON CONFLICT DO NOTHING`.

## Safety

Since `13:22:10Z`: `payment_transfers` 0, `payment_wallet_ledger` 0,
`payment_event_log` 0, `wallet_funding_requests` 0. Dashboard
`event.test` has no transfer/account ids, so apply records the event
and does not mutate money tables.

Fingerprint unchanged vs
`POST_RECONCILIATION_AWS_FINGERPRINT.json`
(`ccb9a1144d46f607f542aa61e765098177eb8a15d318e0a081d6b762ccd021b3`):

- intake `1428955.65`
- deposits `1037630.29`
- CheckAlt `453990.48`
- splits `880702.79`
- claim payments `114621.50`
- ledger `3169779.99`
- identity 11, C1C UAT intake 37
- $9,984.11 check still `approved_for_deposit`

Eight repaired Cognito pairs unchanged (`linked_at` still
`2026-09-14T10:07:27.787Z`).

Unsigned Lovable `.../functions/v1/moov-webhook` still
`401 Invalid signature`.
