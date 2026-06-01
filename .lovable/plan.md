# Send Endorsements from ChecksOps on Shared Checks

## Problem

Check `1717358927` was uploaded in Freedom CRM and shared into ChecksOps as a `check_intake_items` row (id `369d5d7f…`). It has no `claim_id` in this project, so the existing endorsement flow — which is keyed off `signature_requests.claim_id → claims.id` — cannot run here. Today, signatures can only be sent from Freedom CRM (where the originating claim lives).

You want **both** apps to be able to send endorsement emails on the same check.

## Approach

Make endorsements work in ChecksOps directly against a `check_intake_items` row, with results mirrored back to Freedom via the existing cross-project sync.

### Database changes (this project)

1. `signature_requests`
   - Make `claim_id` nullable.
   - Add `check_intake_item_id uuid REFERENCES check_intake_items(id) ON DELETE CASCADE`.
   - Add CHECK constraint: at least one of `claim_id` or `check_intake_item_id` must be set.
   - Index on `check_intake_item_id`.
2. RLS: extend existing policies so admins/staff in the tenant that owns the intake item can read/write signature_requests + signature_signers + esign_event_logs scoped to that intake item.

### Edge function: `send-signature-request`

- When `signature_requests.claim_id` is null, load metadata from `check_intake_items` instead (carrier_name → "claim number" surrogate, payee_line → policyholder name, etc.) so the email merge fields still render.
- Email subject/body merge fields fall back gracefully when no claim is present.
- Push the resulting `signature_signers` rows back to Freedom CRM via a new outbound webhook call so the original `claim_checks` row in Freedom stays in sync.

### UI in ChecksOps (`CheckCommandCenter`)

- In the check detail panel for any check (claim-backed OR shared intake), surface an **Endorsements** section that:
  - Lists existing signers + statuses (read existing rows by `check_intake_item_id` OR `claim_id`).
  - Lets admins add signers (name, email, role) and click **Send for signature**.
  - Invokes `send-signature-request` with the new payload shape.
  - Shows the same resend / generate-link-only actions already in `SignatureDiagnostics`.

### Freedom CRM unblock (separate project — not edited here)

The Freedom CRM "Send for signature" button is currently disabled on shared checks. To let Freedom also send, that condition needs to be relaxed in the Freedom codebase. I'll flag this clearly in the final message — it needs a separate task spawned against the Freedom repo.

## Out of scope (for this round)

- Building the Freedom-side UI change (separate project).
- Restructuring how endorsement images get composited into the check PDF for non-claim checks — current `composite-endorsement-signatures` already works off check_id, should be reusable.
- Sales-rep / contractor signer auto-suggest (we'll start with manual add).

## Technical details

```text
check_intake_items (ChecksOps)
        │ id = 369d…
        ▼
signature_requests (claim_id NULL, check_intake_item_id = 369d…)
        │
        ├── signature_signers (name, email, token_hash)
        └── esign_event_logs
        
        send-signature-request edge function
        ├── if claim_id → existing claims-based merge
        └── if check_intake_item_id → intake-based merge
```

Files touched:
- New migration: nullable claim_id + new column + RLS update on `signature_requests` / `signature_signers` / `esign_event_logs`.
- `supabase/functions/send-signature-request/index.ts` — branch on null claim_id.
- `src/pages/CheckCommandCenter.tsx` — surface endorsement controls for shared checks.
- New `src/components/check-review/SharedCheckEndorsements.tsx` — composer + signer list.

## Confirm before I build

1. OK to make `signature_requests.claim_id` nullable? (Yes is the only path that works without forging fake claims.)
2. OK to ship only the ChecksOps half now and open a separate task for the Freedom-side button? Or do you want me to stop until both projects can be coordinated?
