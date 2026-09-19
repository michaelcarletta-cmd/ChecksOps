# SQL 41 / 170010 claim-link semantics

Unapplied design. Do not apply from this note.

## Product rule

A claim number identifies the **claim**, not the check and not the payee.

The same insurance claim number is expected on many checks. That is required,
not a duplicate error.

| Situation | Result |
| --- | --- |
| One `claims` row in the check's tenant with that normalized number | Every matching check links to that same `claim_id` |
| Two+ `claims` rows in the same tenant with that normalized number | Ambiguous: persist the number, do not link |
| Same number only exists on another tenant's claim | Never link |
| Check already has a `claim_id` | Leave it |
| Payee / payee_line / check_payees differ | Ignored for linking |
| No matching `claims` row | Persist number, `claim_id` stays null |
| Totals | Sum every check that shares the `claim_id` |

Normalization is `lower(btrim(...))`. Punctuation stays significant.
Neither artifact inserts a `claims` row. Auto-link only attaches an existing
tenant-local claim.

Ambiguity is counted on `claims` rows, never on `check_intake_items`.

## Ownership

| Artifact | Owns |
| --- | --- |
| `41_ocr_detected_claim_number.sql` | OCR persist RPC; unique-tenant matcher; auto-link function bodies |
| `20260918170010_guard_check_claim_org.sql` | `evaluate_check_claim_link` / RLS / `trg_guard_check_claim_link`; same unique-tenant matcher so a later apply cannot regress to `LIMIT 1` or punctuation-stripping |

Apply order either way must converge on: unique same-tenant `claims` row, or no link.
`check_claim_link_allowed` remains a second deny for missing / unassigned / cross-org `claim_id`.
