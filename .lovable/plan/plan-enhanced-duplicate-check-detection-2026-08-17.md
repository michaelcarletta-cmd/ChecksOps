# Plan - Enhanced Duplicate Check Detection

The user wants to improve duplicate check detection. A check will be flagged as a potential duplicate if its **Claim Number**, **Amount**, and **Names (Carrier/Payee)** match an existing check in the system. Users should be able to confirm a duplicate or override it.

## User Review Required

> [!IMPORTANT]
> I will implement detection based on the following criteria:
> 1. **Claim Number**: Either the linked claim's number or the OCR-detected claim number.
> 2. **Check Amount**: The exact numeric amount.
> 3. **Payee/Carrier**: A combination of the carrier name and the payee line.
>
> Should I also include the **Check Number** as a required match for a "Duplicate" flag, or is it possible for duplicates to have different check numbers (e.g., if reissued but not voided)? I'll assume for now that if Claim, Amount, and Names match, it's a candidate regardless of the check number.

## Proposed Changes

### Database & Logic
- No schema changes required as we can compute this on the fly or in the view.
- Update `CheckReviewConsole.tsx` to expand the current basic duplicate detection.

### Frontend - Check Review Console (`src/components/check-review/CheckReviewConsole.tsx`)
- Enhance `duplicateInfo` useMemo to use the new criteria (Claim #, Amount, Names).
- Update the UI to show a prominent alert when a potential duplicate is detected.
- Add "Confirm Duplicate" button (moves to voided/void status).
- Add "Override" button (dismisses the warning for that session or via a new metadata flag).

### Workflow Integration
- When a duplicate is confirmed, the check status is updated to `voided`.
- When overridden, a flag `duplicate_override` is set in the check's metadata (or just local state for now).

## Technical Details
- The existing `duplicateInfo` logic in `CheckReviewConsole.tsx` currently only checks `check_number`, `amount`, and `carrier_name`. I will expand this to include `detected_claim_number` and linked claim numbers.
- I will use a composite key for grouping: `${claimNumber}|${amount}|${carrier}|${payeeLine}`.
- I'll add a new `ReviewDecisionPanel` or update the `CheckDetailPanel` inside `CheckReviewConsole.tsx` to handle the duplicate confirmation/override actions.
