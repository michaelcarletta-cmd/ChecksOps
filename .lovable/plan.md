# Plan - Restore External Payment Recording

The user is reporting that recording external payments (manual disbursements outside of Moov/Actum) is no longer working, even though it was previously implemented and functional.

## Proposed Changes

### 1. Fix External Payment Submission Logic
- Review `src/components/disbursement/DisbursementConsole.tsx` mutation logic.
- Ensure the `deliverySpeed === "external"` condition correctly handles the manual recording without attempting to call Moov.
- Verify that the `status` of `disbursement_batches` and `disbursement_splits` is correctly set to `settled` for external payments.
- Ensure the `check_stage` is correctly advanced to `disbursed_externally`.

### 2. Verify Database Enum and Constraints
- Re-confirm that the `disbursed_externally` value exists in the `check_stage` enum (already done, but check for any conflicting triggers).
- Check if any RLS policies or database triggers are blocking manual inserts/updates to `disbursement_batches` when not using an edge function.

### 3. Debugging and Validation
- Inspect console logs and network requests for specific error messages when "External / Manual" is selected.
- Add defensive error handling and better logging to the disbursement mutation to identify why it's failing.

## Technical Details

- **File:** `src/components/disbursement/DisbursementConsole.tsx`
- **Logic:** The `submitBatch` mutation handles the branching logic between Moov (`moov-disburse` edge function) and External (direct Supabase update).
- **Issue:** It's likely that a recent change (possibly related to the Moov primary rail transition) broke the bypass for manual payments or introduced a constraint that requires Moov for all disbursements.
