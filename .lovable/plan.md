# Plan - Enable External Disbursements

Allow users to record disbursements made outside the system (e.g., paper check, wire) for tracking and accounting purposes. This requires adding a new `check_stage` to represent the final state of an insurance check when funds have been moved outside the platform.

## Proposed Changes

### Database

- Add `disbursed_externally` to `public.check_stage` enum.
- Update `advance_check_stage_on_disbursement` trigger function to support this new stage if needed, though manual recording may bypass triggers.

### Frontend

#### 1. Disbursement UI
- Add an "External / Manual" payment option to `DisbursementConsole.tsx`.
- Implement `handleRecordExternalDisbursement` function to:
    - Create a `disbursement_batches` record with `status: 'settled'` and a new `delivery_speed: 'external'`.
    - Create `disbursement_splits` for each allocation.
    - Update the parent check (`check_intake_items` and `claim_checks`) stage to `disbursed_externally`.

#### 2. Workflow & Visibility
- Update `CheckCommandCenter.tsx` to include the `disbursed_externally` stage in relevant tabs (likely "Funds Released" or a new archive tab).
- Ensure cash flow calculations in `ClaimCashFlowCard.tsx` and `ClaimAccounting.tsx` include external disbursements.

## Technical Details

- **Enum Extension**: `ALTER TYPE public.check_stage ADD VALUE IF NOT EXISTS 'disbursed_externally';`
- **Batch Metadata**: Use `delivery_speed: 'external'` and `status: 'settled'` to distinguish from Moov/ACH transfers.
- **Permission**: Restriction to `admin` or `staff` roles for recording manual payments.

## Constraints
- External disbursements do not trigger Moov/ACH movements.
- Once marked as externally disbursed, the check should be considered "closed" for further automated disbursements unless manually reset.
