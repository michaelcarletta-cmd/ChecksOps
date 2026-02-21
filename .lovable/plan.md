

# Fix: Darwin Using Wrong Estimate Amount

## Root Cause Analysis

Two distinct issues are causing Darwin to show incorrect estimate figures:

**Issue 1: Wrong data source for "PA Estimate"**
The `claim_settlements` table stores the **carrier's** numbers (`estimate_amount: $5,124.86`, `replacement_cost_value: $5,124.86`). The edge function (`darwin-strategic-intelligence`) uses this as "the estimate":
```
estimateAmount = settlement?.estimate_amount || claim.claim_amount || 0
```
This means Darwin thinks the claim is worth ~$5,000, not $25,616.

**Issue 2: Bad AI extraction from PA's Xactimate file**
The uploaded PA estimate file (`SEAN_SMITH9_FINAL_DRAFT_W_USAGE_72.pdf`) was classified as an "estimate" but the AI extracted `Total RCV: $10,000` from `classification_metadata`. The actual value is $25,616. This is a document processing extraction error.

---

## Proposed Fix

### 1. Separate Carrier Estimate from PA/Freedom Estimate in the Edge Function

Update `darwin-strategic-intelligence` to distinguish between:
- **Carrier estimate**: from `claim_settlements.estimate_amount` (what the carrier offered)
- **PA/Freedom estimate**: from uploaded estimate files classified as estimates in `claim_files`

The function should:
- Pull all files classified as `estimate` from `claim_files`
- Extract amounts from `classification_metadata.amounts`
- Identify which is the carrier's and which is the PA's (using folder location, filename patterns, or the "Freedom Documents"/"Supporting Evidence" folder logic already documented in memory)
- Present BOTH amounts to the AI prompt as separate line items:
  ```
  FINANCIAL SNAPSHOT:
  - Carrier Estimate: $5,124.86 (from claim_settlements)
  - PA/Freedom Estimate: $25,616 (from uploaded estimate file)
  - Difference: $20,491.14
  ```

### 2. Add a `pa_estimate_amount` field to `claim_settlements`

Add a column to store the PA's demand/estimate separately from the carrier's, so users can enter it directly in the accounting section and it doesn't depend solely on AI file extraction.

### 3. Improve estimate amount extraction fallback

When the edge function builds the financial snapshot, it should:
1. First check `claim_settlements.pa_estimate_amount` (new explicit field)
2. Fall back to scanning `claim_files` where `document_classification = 'estimate'` and the file is in a "Freedom Documents" or "Supporting Evidence" folder
3. Extract the highest RCV amount from `classification_metadata.amounts`

---

## Technical Details

### Database Migration
- Add `pa_estimate_amount DECIMAL(12,2)` to `claim_settlements`

### Edge Function Changes (`darwin-strategic-intelligence/index.ts`)
- Around line 432, replace the single `estimateAmount` variable with two: `carrierEstimate` and `paEstimate`
- Query `claim_files` for estimate-classified files and extract amounts from metadata
- Use folder-based logic to distinguish carrier vs PA estimates
- Update the FINANCIAL SNAPSHOT prompt (around line 704) to show both amounts and the difference

### Frontend (Accounting Section)
- Add a "PA Estimate" input field in `ClaimAccounting.tsx` so users can manually enter their estimate amount, which gets saved to `claim_settlements.pa_estimate_amount`

---

## Why This Matters

Without this fix, the War Room's WSI score, strategic memo, and scenario simulations are all based on a $5,000 claim value instead of a $25,616 claim value. This makes every strategic output unreliable -- the "difference" calculation, settlement range estimates, and leverage assessments are all wrong.
