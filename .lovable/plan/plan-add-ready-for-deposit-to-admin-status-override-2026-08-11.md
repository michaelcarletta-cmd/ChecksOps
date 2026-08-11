# Plan: Add "Ready for Deposit" to Admin Status Override

The user needs to manually push checks to the "Ready for Deposit" stage using Admin tools, but this option is currently missing from the status override dropdown in `CheckCommandCenter.tsx`. I will add it and ensure it correctly updates both the status and the check stage.

## User Review Required

> [!IMPORTANT]
> This change only adds the **manual override** option to Admin tools. It does not change the automatic logic that moves checks when all endorsements are received.

## Proposed Changes

### Frontend: CheckCommandCenter.tsx

#### [Admin tools]
- Update `STATUS_OPTIONS` to include `approved_for_deposit` (labeled "Ready for Deposit").
- Verify `stageMap` in `StatusOverride` component already correctly maps `approved_for_deposit` to `ready_for_deposit`.
- Verify `recMap` in `StatusOverride` component already correctly maps `approved_for_deposit` to `ready_for_deposit`.

## Technical Details

- File: `src/pages/CheckCommandCenter.tsx`
- Modification:
    ```typescript
    const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
      // ... existing options
      { value: "approved_for_deposit", label: "Ready for Deposit" },
      // ...
    ];
    ```
- The `StatusOverride` component's `handleSave` function already handles this status by:
    1. Setting `status` to `approved_for_deposit`.
    2. Setting `check_stage` to `ready_for_deposit`.
    3. Setting `deposit_recommendation` to `ready_for_deposit`.
    4. Syncing these changes to `claim_checks`.

## Verification Plan

### Automated Tests
- No specific tests; visual confirmation is standard for UI dropdown additions.

### Manual Verification
1. Open a check in the Command Center.
2. Expand **Admin tools**.
3. Click **Override status**.
4. Verify "Ready for Deposit" appears in the dropdown.
5. Select it and save.
6. Verify the check moves to the "Ready for Deposit" tab.
