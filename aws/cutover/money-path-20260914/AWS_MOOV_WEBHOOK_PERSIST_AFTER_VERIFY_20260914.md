# AWS Moov webhook — persist_after_verify — 2026-09-14

## Verdict

**READY TO RETEST MOOV DASHBOARD EVENT**

Signature verification is proven and was not changed. The 13:22 Dashboard
test was a persistable Moov `event.test` ping. The handler did **not**
intentionally skip persistence. A production RLS gap aborted the
transaction after receipt INSERT; `COMMIT` rolled that receipt back and
the Lambda still returned HTTP 200.

SQL 67 + savepoints are the smallest fix. HMAC, the webhook secret, the
Lovable destination, and the SPA were not changed. No financial
transaction was initiated.

## What type arrived

Moov Dashboard **Send test webhook** / `POST /webhooks/{id}/ping` sends:

```json
{
  "eventID": "<uuid>",
  "type": "event.test",
  "data": { "ping": true },
  "createdOn": "<rfc3339>"
}
```

Source `34.133.111.85` (GCP) at `2026-09-14T13:22:04.062Z` returned
HTTP **200**, APIGW `DsM3dgnIIAMEMzw=`, Lambda
`58ff1ea3-bc6d-4d4a-9989-a54241996c57`, **443.28 ms**, body **704**
bytes. Live `providers/webhooks.mjs` matches the repo overlay
(`CodeSha256=7Jzn63Xc1TUfQhTtn7Vn+b2oSbvhd53vstqUiVkct7s=` before this
fix).

`event.test` has an `eventID`, no `accountID`, no `transferID`. The
handler is written to persist a receipt and a `payment_webhook_events`
row, then return `applied: true` with
`note: event_recorded_no_financial_mutation` (note is not copied into
the HTTP body). It is **not** an intentional ack-without-persist path.
A historical Supabase-path `event.test` already exists
(`2026-08-26T15:47:31.440Z`).

## Post-verify path and first stop

1. `parseJson` — ok (200, not 400 `malformed_webhook`).
2. `verifyMoovSignature` — **pass** (200, not 401).
3. `externalIdOf` — `payload.eventID` present (otherwise 400).
4. DB connect / `BEGIN` / `SET TRANSACTION READ WRITE` /
   `request.provider_webhook=1` — 443 ms is connect+query time.
5. `lookupMappedTenant` — `no_provider_id` (no account id). Continues.
6. `insertReceipt` — **succeeds in the transaction**. Live probe as
   `checksops` with the same GUC inserted a row (rolled back). No
   trigger. Table RLS insert policy is satisfied.
7. `productionWebhookApplyEnabled()` — true (`dry_run=false`, Moov +
   financial flags on).
8. `applyMoovWebhook` → `recordWebhookEvent` INSERT
   `payment_webhook_events` — **first exact stop**.

   Live probe as `checksops` with apply GUCs:

   `42501 new row violates row-level security policy for table "payment_webhook_events"`

   SQL 66 GRANTed INSERT/UPDATE to `checksops`. RLS is on, FORCE off.
   The only policy was `SELECT` to `authenticated`. No INSERT policy →
   default deny. `recordWebhookEvent` swallowed the error and returned
   `{ unavailable: true }`.

9. PostgreSQL marks the transaction **aborted**. Later apply queries
   are also swallowed. `COMMIT` on an aborted transaction is treated as
   `ROLLBACK`. JavaScript still returns HTTP 200 with the in-memory
   `receipt_id`.
10. Durable result: **no** new `aws_provider_webhook_receipts` row
    (still 7 historical dry-run `evt-t4-*` rows, latest 2026-09-03) and
    **no** `payment_webhook_events` since cutover.

Not the stop: missing event id, tenant map, dry-run, production apply
flag, idempotent `ON CONFLICT` against the seven `evt-t4-*` ids, or a
wrong database (`postgres` has no receipts table).

## Fix (smallest proven)

1. `aws/financial/sql/67_payment_webhook_events_apply_rls.sql` — SELECT /
   INSERT / UPDATE policies **TO checksops only**, gated on apply GUCs
   and `provider='moov' AND environment='production'`. Not granted to
   `authenticated` / `anon` / `PUBLIC`.
2. Savepoints around swallowed apply statements so a later 42501 cannot
   abort the receipt transaction and still return 200.

HMAC / secret / tenant isolation / idempotency keys were not weakened.

SQL 67 is applied on production RDS. A `checksops` rollback probe then
inserted both a receipt and an `event.test` `payment_webhook_events` row
and marked it processed. The same INSERT without apply GUCs is still
`42501`. Probe rows were rolled back (receipts remain 7).

`checksops-production-prep-api` overlay updated to
`CodeSha256=B8cQg1FnQzUSx7B/nANevkWrTCV/UPgX+e4GtXzlqvk=` (savepoints).
`providers/hmac.mjs` was not changed. Secret epoch
`20260914T123236Z` was not recycled. Unsigned POST still
`401 missing_signature_headers` (241 bytes). Rehearsal oneshot
`CodeSha256=Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=` unchanged.

Fingerprint aggregates and the 8 repaired Cognito mappings match
`POST_RECONCILIATION_AWS_FINGERPRINT.json`
(`ccb9a1144d46f607f542aa61e765098177eb8a15d318e0a081d6b762ccd021b3`).
$9,984.11 check still `approved_for_deposit`. C1C UAT intake still 37.

## Remaining validation

A new Dashboard **Send test webhook** to
`https://checksops.com/prep/webhooks/moov` should insert:

- `aws_provider_webhook_receipts` (`event_type='event.test'`, `dry_run=false`)
- `payment_webhook_events` (`event_type='event.test'`, `environment='production'`)

No funds move. A genuine subscribed production event is still required
after that to prove transfer apply. Do not remove the Lovable webhook.
Do not deploy the SPA.
