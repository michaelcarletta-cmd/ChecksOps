# Plan: Add Revenue/Profit Visibility to Payments Tab

Implement a "Revenue & Profit" view in the Payments section to track incoming funds (checks) alongside outbound payments, providing a clear picture of tenant profit.

## User Review Required

> [!IMPORTANT]
> - Should "Profit" be calculated as `Total Check Amount - Total Disbursements`?
> - Do you want a new dedicated tab for this, or should we add these summary metrics (Inbound, Outbound, Profit) to the existing Payment History view?
> - Are "Revenue" items solely insurance checks deposited through the platform, or should we include other sources?

## Proposed Changes

### Database & Backend
- No schema changes expected; we will use existing `check_intake_items` and `disbursement_splits` tables.

### Frontend
#### `src/pages/Payments.tsx`
- Add a new "Profit & Loss" or "Revenue" tab (pending user feedback).
- Alternatively, enhance the header of the Payments page with global summary cards:
  - **Total Revenue**: Sum of all deposited checks.
  - **Total Disbursements**: Sum of all settled payouts.
  - **Net Profit**: Revenue minus Disbursements.

#### `src/components/ledger/RevenueSummary.tsx` (New Component)
- Create a new component to visualize incoming vs. outgoing funds.
- Include a list or chart showing revenue sources (Checks) and profit margins per claim.

#### `src/components/ledger/PaymentLedger.tsx`
- Add a "Revenue Tracking" mode or simply include the check amount reference in the ledger for context.

## Technical Details
- Use `useQuery` to fetch `check_intake_items` (where `status` is `deposited` or `funds_released`) to calculate revenue.
- Join `disbursement_splits` with `disbursement_batches` to link payouts back to specific revenue-generating checks for "per-check" profit analysis.
- Ensure all calculations follow the 2-decimal rounding rule established in the platform.
