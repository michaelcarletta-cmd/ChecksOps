

# Fix: Deposit Route Dropdown Empty in Assign Dialog

## Problem
When clicking "Assign" on a pending deposit item, the "Deposit Route" dropdown appears empty. The data exists in the database (3 active providers) and RLS policies are correct for admin/staff roles.

The root cause is most likely a **z-index/portal stacking issue**: the Radix `SelectContent` portal renders behind the `DialogContent` overlay. Both use `z-50`, and on mobile viewports the dropdown can appear invisible or clipped.

## Solution

1. **Increase z-index on SelectContent inside the dialog** — pass a higher z-index class (e.g., `z-[200]`) to the `SelectContent` in the assign_provider dialog section.

2. **Add error handling and loading state** — add `isError` / `isLoading` checks on the provider config query so any silent failures become visible. Show a "Loading providers..." or "Failed to load" message in the dropdown area.

3. **Add `modal={false}` to the Select** inside the Dialog — this is a known Radix workaround to prevent the Dialog's modal trap from intercepting the Select portal.

## Files to Change

- `src/components/deposit-ops/DepositOperationsConsole.tsx`
  - Add `modal={false}` prop to the `<SelectContent>` for the deposit route selector (or wrap with appropriate portal container)
  - Add error/loading feedback for the provider configs query
  - Ensure the `SelectContent` renders with a higher z-index (`z-[200]`) to sit above the Dialog overlay

## No Changes To
- Database schema or RLS policies (confirmed working)
- Back-of-check sizing logic
- Any other components

