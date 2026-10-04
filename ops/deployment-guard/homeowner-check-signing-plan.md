# Homeowner check signing — implementation plan (stop before staging changes)

Design only. This file does not authorize a deploy, SQL apply, Cognito change,
or production write. SQL73 and the accepted Homeowner Ops staging baseline
remain frozen until a later reviewed forward change.

## Inspected current flow

Homeowner Ops already has two different "sign" surfaces:

1. **Check endorsement (the required feature)**
   - SQL73 `pending_endorsements` (insured + mortgage_company, same tenant+claim)
   - `src/pages/HomeownerLedger.tsx` `PendingEndorsementsPanel` ("Checks awaiting signature")
   - Live chunk `HomeownerLedger-cDMDKYsn.js` already shows **Sign now**
   - Insured homeowner `sign_url` is `/endorse?token=<check_endorsements.token>`
   - `src/pages/Endorse.tsx` → `publicWorkflowRequest("check-endorsement")`
   - `aws/functions/api/check-endorsement.mjs` (`get_endorsement_data`, `runSubmitEndorsement`)
   - Lookup: `aws_public_endorsement_by_token` then `check_endorsements.token` then `check_payees.endorsement_token`
   - Completion: `finalizeEndorsementState` + `evaluateEndorsementMath` in `endorsement-completion.mjs`
   - Mortgage remaining ⇒ `allRequiredSatisfied` stays false; check is not fully endorsed

2. **Document Signature Requests (do not turn back on)**
   - `pending_signatures` is forced `[]` in SQL73 and `normalizeHomeownerLedgerView`
   - `PendingSignaturesPanel` calls `homeowner-ledger-sign-link`
   - `handleHomeownerLedgerSignLink` remints via `aws_public_homeowner_ledger_remint_signer` and returns `/sign?token=`
   - That remint function is not in this repo; the AWS handler is not sufficiently token/claim scoped
   - Document path uses `signature_requests` / `signature_signers` / `signature-submit.mjs` / `esign.mjs` / `Sign.tsx`

`pending_signatures` is empty on purpose. Do not re-enable the remint handler.

## Authorization model (required)

```
homeowner_ledger_tokens.token
  → authorized (tenant_id, claim_id, homeowner identity)
  → only check_endorsements on that exact tenant + claim
  → only payee_type = insured that matches the authorized homeowner
  → purpose-specific check_endorsements.token or a short-lived mint of that row
  → existing /endorse + check-endorsement submit
```

The ledger token identifies context. It must not become a general `/sign` or
cross-check endorsement authority.

## Minimum forward repair (no SQL73 rewrite)

### Keep

- SQL73 bytes and `claim_ok`
- `pending_signatures: []`
- `handleHomeownerLedgerSignLink` disabled
- Existing `check-endorsement` stamping, rear composite, and `evaluateEndorsementMath`
- Live `/h/ledger/:token` and `/ledger/:token`
- Staff/email endorsement links that already use `check_endorsements.token`

### Change (later staging-only PR)

| Area | File / function | Why |
| --- | --- | --- |
| New mint | `aws/functions/api/homeowner.mjs` new `handleHomeownerLedgerEndorseLink` | Ledger token + `endorsement_id` → verify tenant/claim/insured/status → return existing or rotated endorsement token. Do not call remint_signer. |
| Route | `aws/functions/api/app-services.mjs` | Register `homeowner-ledger-endorse-link` only. |
| Filter | `normalizeHomeownerLedgerView` / `pendingEndorsementsForHomeowner` | Drop non-insured sign URLs; stop treating empty homeowner email as match-all (`\|\| !email`). SQL73 may still emit those rows; filter in the API without rewriting SQL73. |
| UI | `src/pages/HomeownerLedger.tsx` | Label **Review & Sign Check**. Call the new mint. Open existing Endorse experience. Return to `/h/ledger/:token` (or `/ledger/:token`) and refresh. Show **Your signature completed** when mortgage/other required payee remains. |
| Return | `src/pages/Endorse.tsx` | Optional `return_to` / post-submit redirect back to Homeowner Ops. Do not rebuild a second signer. |
| Endorse gate | `check-endorsement.mjs` only if a shared-path hole remains | Prefer a Homeowner-only mint. Do not change staff/mortgage/email endorse behavior. Refuse signed/cancelled/revoked reuse (already mostly true). |
| Routes | `src/App.tsx` | Add `/h/ledger/:token` in source so it matches the accepted live SPA. Forward change, not a baseline rewrite. |
| Tests | new Homeowner endorse-link tests | Cross-tenant, cross-claim, mortgage/contractor/PA, completed token, URL id swap, no bank/wallet leakage. |

### Do not change

- `aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql`
- `signature-submit.mjs`, `esign.mjs`, `Sign.tsx`, `send-signature-request`
- Branding, Mortgage Ops, Cognito, Moov/CheckAlt/money movement
- Production
- Broad SPA/Lambda replacement

## Tables

| Table | Role |
| --- | --- |
| `homeowner_ledger_tokens` | Authorized homeowner/claim context |
| `check_intake_items` | Tenant+claim check membership |
| `check_endorsements` | Purpose-specific check signature rows/tokens |
| `check_payees` | Payee status mirror used by endorse finalize |
| `claims` | `org_id` / claim identity (SQL73 `claim_ok`) |
| `signature_requests` / `signature_signers` | Collision surface only — leave unused for this feature |

## Collision risk with Signature Requests

- Claim-detail Signature Requests already use `/sign?token=` and `signature_signers.token_hash`.
- Re-enabling remint would collide with that workflow and can remint a signer the ledger token does not own.
- Check endorsement is a separate public token (`check_endorsements.token`) already used by email and staff.
- Homeowner signing must reuse endorsement, not document-sign remint.
- `finalizeEndorsementState` must keep requiring every non-contractor row (`mortgage_company` included unless `manual_required`/`signed`/`waived`) so one homeowner signature cannot mark the check fully endorsed.

## Known holes to close in the later PR

- `isHomeownerEndorsementParty` / SQL73 `is_homeowner` treat empty homeowner email as matching every insured party.
- Ledger JSON currently embeds raw endorsement tokens in `sign_url`. The later mint should be the only Homeowner Ops opening path; do not treat the ledger token itself as the endorse token.
- `lookupPublicEndorsement` has unscoped fallbacks. Do not broaden them. Homeowner mint must re-check tenant+claim+payee_type before returning a token.
- `aws_public_homeowner_ledger_remint_signer` is missing from source and must stay unused.

## Stop

No staging overlay, SQL apply, or SPA promote is authorized by this plan.
The accepted baseline is `homeowner-ops-staging` `STAGING_LOCKED_NOT_PRODUCTION`.
