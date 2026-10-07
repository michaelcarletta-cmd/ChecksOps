# OCR/MICR + Claim Ledger regression repair

Reported production symptoms on 2026-10-07:
- OCR/MICR did not populate payees, routing number, account number, or issue date.
- Claim Ledger save returned `writes_disabled`.

Forward-compose only from current main; current/live state is authoritative.

## Claim Ledger
PR #622 previously proved the intended staging repair: route `claim_settlements` insert/update from the Claim Settlement editor through the dedicated `save_claim_settlement_breakdown` RPC before the generic AWS write allowlist gate. Do not add `claim_settlements` to generic write allowlists. Reconcile only the #622 behavior onto current main after proving current accepted implementation/composition.

## OCR/MICR
Trace current upload/save -> `check-ocr-intake` -> Textract/Azure/provider merge -> parse -> descriptive/MICR persistence. Compare against accepted OCR lineage/current main. For payees, routing number, account number and issue date, determine whether each is absent at extraction, lost during merge/parser normalization, rejected by persistence, or not invoked by the upload caller. Do not invent parsing rules before locating the regression. Preserve amount/carrier/claim-number behavior, deposited-field locks, raw OCR evidence, manual-review behavior and original images.

## Safety
No deployment, AWS mutation, SQL apply, provider execution, ACH/deposit/money movement. No weakening generic write allowlists. No changes to #737 financial/provider behavior. Preserve #742 and newer main work, Release Locks, Deployment Guard, Accepted Feature Registry and production SPA lock. No wildcard/blanket overlap exceptions.
