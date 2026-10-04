# Homeowner Ops — check + document signing integration (plan only)

Design only. This file does not authorize a deploy, SQL apply, Cognito change,
or production write. Existing Signature Requests and check-endorsement systems
stay frozen. SQL73 stays frozen.

The currently working Homeowner portal (SQL73 + endorse-link mint already in
staging) is the accepted baseline. Later work is a forward change from that
composition, not a rewrite.

## Scope freeze

Do not modify, refactor, replace, or repair:

- Signature Request creation
- Staff signer/token generation (`esign.mjs` / send-signature-request)
- `/sign`, `Sign.tsx`, `signature-submit.mjs`
- signature placement/stamping
- completed-document generation/storage
- signature emails
- existing signer completion/status logic
- check-endorsement submit, stamping, compositing, `allRequiredSatisfied`
- SQL73
- Cognito, Branding, Mortgage Ops, Moov/provider/money movement
- production

Do not resurrect `aws_public_homeowner_ledger_remint_signer` /
`handleHomeownerLedgerSignLink`. That handler is still in source but is not
token/claim/homeowner scoped and must stay unused.

Homeowner Ops is only an additional secure doorway into the two systems that
already work.

## Inspected current flow

### 1. Checks (already composed; button missing)

Working pieces:

- SQL73 `pending_endorsements` lists `insured` + `mortgage_company` rows on
  the exact token tenant + claim.
- Staging Homeowner Ops already shows checks **#271682** and **#237413** under
  Checks awaiting signature. That means SQL73 + sanitize kept the rows.
- `homeowner-ledger-endorse-link` already mints a purpose-specific
  `/endorse?token=…&return_to=/h/ledger/…` after tenant+claim+insured+status
  checks. Ledger JSON does not embed raw `check_endorsements.token`.
- Existing `/endorse` + `check-endorsement.mjs` complete the signature.

Why **Review & Sign Check** is missing:

`PendingEndorsementsPanel` renders the button only when `party.can_sign === true`.

```
can_sign = isHomeowner && payee_type === 'insured'
isHomeowner = email
  ? (identityMatch || SQL73.is_homeowner)
  : identityMatch
identityMatch = payee_type === 'insured'
  AND (contact_email === homeowner.email OR payee_name contains a name part)
```

SQL73 still *lists* an insured row when `request_sent_at` is set or status is
`sent` / `requested` / `awaiting_signature` / … even if identity does not
match. The API then strips `sign_url` and sets `can_sign=false` unless email
or name matches. Empty homeowner email also ignores SQL73 `is_homeowner`
(that was the required empty-email match-all removal).

Observed UX: the check card renders, the insured row shows the
**Awaiting signature** badge, and the mint is never offered.

That is an integration identity gate, not a broken endorsement system.

Likely live causes (confirm in the later implement workstream with a
read-only SELECT on those two checks — do not apply SQL):

- ledger `homeowner_email` ≠ endorsement `contact_email` (invite vs payee)
- ledger email empty, so SQL73 `is_homeowner=true` is ignored
- `payee_name` is joint / last-first / does not contain a ≥3-letter name part
- insured row is present for display because it was sent, not because identity matched

Secondary UX hole: if `can_sign` is false and a mortgage party remains, the
panel can show **Your signature completed…** even when the homeowner never
signed. Only show that banner when the insured homeowner row is actually
completed (`signed` / `signed_at`), not merely unmatched.

### 2. Documents (intentionally dark)

Working pieces (leave them alone):

- Staff claim-detail `SignatureRequests` creates `signature_requests` +
  `signature_signers` (`policyholder` | `contractor` | `staff` | `other`).
- `esign.mjs` mints `token_hash`, emails `/sign?token=<raw>`, then **clears
  `access_token`**. Only the hash remains. `/sign` + `signature-submit.mjs`
  look up `signature_signers.token_hash`.
- Completed-document generation and signer-order blocking already work.

Why Homeowner Ops shows nothing:

- SQL73 forces `pending_signatures: []`.
- `normalizeHomeownerLedgerView` also forces `pending_signatures: []`.
- `PendingSignaturesPanel` therefore never mounts.
- The old remint doorway is disabled on purpose.

A normally uploaded/shared document is not a signature request. Keep
`shared_documents` / ordinary files unchanged. Only `signature_requests` in
`pending` / `sent` / `partial` / `in_progress` are candidates.

`Sign.tsx` has no `return_to` and must not gain one in this workstream. After
sign it shows **Document Signed**. Browser Back (same-tab) plus ledger
`pageshow`/focus refresh is the return path that does not touch `Sign.tsx`.

## Authorization model (required)

```
homeowner_ledger_tokens.token
  → authorized (tenant_id, claim_id, homeowner identity)
  → only rows on that exact tenant + claim
  → only THIS homeowner’s actionable signer/endorsement
  → purpose-specific mint at click time
  → existing /endorse or existing /sign
```

The ledger token is context, not a general signing authority.

Never actionable:

- another tenant, claim, or homeowner
- mortgage company / contractor / public adjuster / staff / other
- completed / cancelled / revoked / expired items

Never in the general ledger payload:

- raw `check_endorsements.token`
- raw `/sign` tokens, `access_token`, `token_hash`

## Minimum forward repair (no SQL73 rewrite)

### A. Restore Review & Sign Check (Homeowner boundary only)

Keep the existing endorse-link mint and `/endorse` path.

Change `isHomeownerEndorsementParty` / `publicEndorsementParty` so an open
**insured** endorsement on this tenant+claim becomes `can_sign` when:

1. email matches `contact_email`, or
2. a ≥3-letter homeowner name part is in `payee_name`, or
3. **claim-scoped sole insured**: that check has exactly one open insured
   endorsement (the authorized claim homeowner is that party)

Do **not** restore empty-email match-all across multiple insured parties.
Do **not** put `sign_url` back on the ledger JSON.
Do **not** let mortgage/contractor/PA mint.

Also:

- Show **Review & Sign Check** when `can_sign`.
- Show **Awaiting signature** only for unmatched/non-homeowner open parties.
- Show **Your signature completed…** only after the homeowner insured row is
  actually done and another required party remains.
- Mint still re-checks tenant+claim+insured+open+identity/sole-insured.
- `return_to` stays allowlisted to `/h/ledger/:token` or `/ledger/:token`.

### B. Surface existing Signature Requests (Homeowner boundary only)

Do not change SQL73. After the SQL73 RPC, `runHomeownerLedgerView` loads
claim-scoped signature requests in `homeowner.mjs`:

```
signature_requests r
  JOIN signature_signers s
  LEFT JOIN claims c ON c.id = r.claim_id
WHERE (
    r.claim_id = token.claim_id
    OR r.check_intake_item_id IN (claim checks)
  )
  AND (c.org_id IS NULL OR c.org_id = token.tenant_id)
  AND r.status IN ('pending','sent','partial','in_progress')
```

Sanitize for the ledger (no tokens):

- `request_id`, `document_name`, requested date (`sent_at` / `created_at`),
  request status
- signers: `signer_id`, name, status, `is_homeowner`, `can_sign`
- `can_sign` only when the signer is this homeowner, unsigned, request open,
  and signer type is `policyholder` / `insured` / `homeowner` (not contractor /
  staff / other / mortgage)
- identity: email or name match, or **sole policyholder signer** on that
  request
- omit completed/cancelled/revoked/expired
- omit requests with no homeowner-actionable signer (do not show a contractor
  request as Awaiting your signature)

UI (`PendingSignaturesPanel` only):

- title **Awaiting your signature**
- document/request name, requested date/status
- **Review & Sign Document** on `can_sign` only
- other signers remain status-only

### C. Secure document doorway (do not call remint_signer)

New Homeowner-only handler, e.g. `homeowner-ledger-document-sign-link`.

Do **not** call `aws_public_homeowner_ledger_remint_signer`.
Do **not** reuse `handleHomeownerLedgerSignLink`.
Do **not** edit `esign.mjs` / `signature-submit.mjs` / `Sign.tsx`.

On click:

1. Resolve ledger token → tenant + claim + homeowner.
2. Load `signature_signers` ⋈ `signature_requests` ⋈ `claims` / check
   membership.
3. Fail closed on tenant/claim mismatch, wrong signer type, identity miss
   (unless sole policyholder), completed/cancelled/revoked, URL id swap.
4. Because `esign.mjs` clears `access_token` after email, mint a **new**
   raw token + `token_hash` + `expires_at` on **that one signer row only**.
   This is the same column the existing `/sign` lookup already uses. It may
   rotate the emailed link for that signer, same as a staff resend, but it
   does not change request creation, stamping, or submit logic.
5. Return `/sign?token=<raw>` only. No token in the ledger payload.
6. Same-tab navigation so browser Back returns to Homeowner Ops. Refresh the
   ledger on `pageshow`/focus. Do not add `return_to` to `Sign.tsx`.

If the signer is blocked by signing order, `/sign` already shows Waiting for
Prior Signer. Homeowner Ops should still hide **Review & Sign Document** when
a prior unsigned signer exists, or allow the click and let `/sign` fail
closed.

### D. Tests (source only until a later staging compose)

- Check: #271682 / #237413-shaped rows get `can_sign` via sole-insured when
  email/name miss; two insureds do not; mortgage never; `sign_url` stays null.
- Document: claim-scoped policyholder appears; contractor/staff/other do not;
  other claim/tenant/homeowner fail closed; completed/cancelled not
  actionable; ledger JSON has no `token` / `token_hash` / `access_token`.
- Old remint handler remains unused.
- SQL73 bytes unchanged; `pending_signatures` still `[]` in SQL73; API may
  attach a sanitized list after the RPC.
- Baseline/contract tests that currently pin `normalize… pending_signatures: []`
  must be updated to “SQL73 empty + API sanitize” without rewriting SQL73.

## Files a later implement workstream may touch

| File | Why |
| --- | --- |
| `aws/functions/api/homeowner.mjs` | Sole-insured `can_sign`; post-SQL73 signature-request attach; new document mint |
| `aws/functions/api/app-services.mjs` | Register `homeowner-ledger-document-sign-link` only |
| `src/pages/HomeownerLedger.tsx` | Check button gate + document panel copy + refresh-on-return |
| new Homeowner document-sign tests | Authorization |

Do not touch: SQL73, `Sign.tsx`, `signature-submit.mjs`, `esign.mjs`,
`check-endorsement.mjs` unless a later review finds a shared-path hole
that cannot be closed at the Homeowner mint.

## Stop

No staging overlay, SQL apply, or SPA promote is authorized by this plan.
Confirm the two-check identity miss with a read-only SELECT in the implement
workstream before composing. If live fingerprints have drifted from the
current Homeowner endorse-link composition, STOP rather than overwrite.
