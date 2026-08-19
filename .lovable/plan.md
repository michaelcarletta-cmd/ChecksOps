# Plan: Relocate Usage Log to Settings

Move the **Usage Log** tab from the **Payments** page to the **Settings** page under a new "Usage" tab.

## User Review Required

> [!IMPORTANT]
> The Usage Log is currently visible to all organization users on the Payments page. Moving it to Settings will keep the same visibility (all organization users can access the Workflow/Profile/etc tabs in Settings), but it will be consolidated with other configuration tools.

- Does the "Usage" tab in Settings need any specific restricted access (e.g., Admin only), or should it remain available to all organization users?

## Proposed Changes

### Frontend

#### `src/pages/Payments.tsx`
- Remove `UsageLogTab` import.
- Delete the "Usage Log" `TabsTrigger` (value="usage").
- Delete the "Usage Log" `TabsContent` (value="usage").
- Update the layout to fill the gap left by the removed tab.

#### `src/pages/Settings.tsx`
- Import `UsageLogTab` from `@/components/payments/UsageLogTab`.
- Add a new `TabsTrigger` for "Usage" using the `BarChart3` icon.
- Add a `TabsContent` for "Usage" that renders the `UsageLogTab` component.
- Position the new tab logically (e.g., after "Workflow" or "Users").

## Technical Details
- No backend changes are required as `UsageLogTab` already uses `useTenant` and existing RLS policies.
- UI consistency will be maintained using the existing `Tabs` and `Card` patterns in Settings.

## Verification Plan
- Navigate to **/freedom/payments** (or similar) and verify the Usage Log tab is gone.
- Navigate to **/freedom/settings** and verify the new "Usage" tab appears.
- Confirm the Usage Log correctly loads data and month filtering works in the new location.
