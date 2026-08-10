# Plan - Modernize Funds Released and Funds Received Tabs

The user wants to modernize the "Funds Released" and "Funds Received" tabs in `CheckCommandCenter.tsx`, specifically applying the rounded container style that was recently implemented for the main check files.

## Proposed Changes

### Frontend: `src/pages/CheckCommandCenter.tsx`

1.  **Update `Table` usage in both tabs**:
    *   Add `border-separate border-spacing-y-0 border-spacing-x-0` to the `Table` components in the `fundsreleased` and `fundsreceived` tab content.
2.  **Modernize Claim File Headers**:
    *   Update the `TableRow` for claim groups (the dark/green header bands) to include:
        *   `rounded-t-xl overflow-hidden`
        *   `[&>td:first-child]:rounded-tl-xl`
        *   `[&>td:last-child]:rounded-tr-xl`
    *   This ensures the header of each claim group has rounded top corners.
3.  **Round the Last Row of each Group**:
    *   For the last disbursement/receipt row in each claim group, apply rounded bottom corners:
        *   `[&>td:first-child]:rounded-bl-xl`
        *   `[&>td:last-child]:rounded-br-xl`
4.  **Add Visual Separation**:
    *   Insert a transparent spacer row (`<TableRow className="h-2 bg-transparent border-none pointer-events-none"><TableCell colSpan={7} /></TableRow>`) between claim groups to make the rounded containers stand out.
5.  **Refine "Modern" look**:
    *   Ensure the `Badge` and text colors match the "modern" aesthetic (using `text-sky-400` or `text-emerald-400` where appropriate).

## Verification Plan

### Manual Verification
*   Navigate to the "Funds Released" tab.
*   Verify that each claim's disbursements are grouped in a rounded container.
*   Verify that there is spacing between the groups.
*   Repeat for the "Funds Received" tab.
*   Ensure the mobile view still functions correctly with the new layout.

### Automated Verification
*   Use Playwright to capture screenshots of the updated tabs and confirm the rounded styling is applied.
