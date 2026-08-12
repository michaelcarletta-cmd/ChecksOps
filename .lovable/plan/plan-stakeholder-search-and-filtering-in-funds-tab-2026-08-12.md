# Plan - Stakeholder Search and Filtering in Funds Tab

Implement a search bar in the "Add Stakeholder" popover within the Funds tab. The search results will be restricted to stakeholders saved in the tenant's settings and the homeowner specifically associated with the current claim file.

## User Review Required

> [!IMPORTANT]
> - The search will automatically exclude all other homeowners in the system to ensure privacy and focus.
> - "Stakeholder settings" refers to the `stakeholder_accounts` table filtered by the current tenant.

## Proposed Changes

### Frontend Components

#### `src/components/disbursement/CheckStakeholdersManager.tsx`
- Add a search input field at the top of the "Add Stakeholder" popover.
- Implement client-side filtering logic for the `availableToAdd` list.
- Enhance the stakeholder retrieval to explicitly include the homeowner(s) linked to the claim, even if they aren't globally saved as stakeholders yet.

### Data Fetching

#### `CheckStakeholdersManager.tsx` Query Updates
- Update the `allAccounts` query to ensure it fetches necessary metadata for filtering.
- Ensure the `checkMeta` query brings in homeowner information (name, etc.) to allow identifying them in the search list.

## Technical Details

- **Filtering Logic**:
  ```typescript
  const filtered = availableToAdd.filter(acct => {
    const matchesSearch = acct.nickname.toLowerCase().includes(search.toLowerCase()) || 
                         acct.custname?.toLowerCase().includes(search.toLowerCase());
    const isOwner = acct.homeowner_name && acct.homeowner_name === currentClaimHomeowner;
    const isGlobalStakeholder = acct.is_active && !acct.homeowner_name; // Saved in settings
    
    return matchesSearch && (isOwner || isGlobalStakeholder);
  });
  ```
- **UI**: Use a standard `shadcn/ui` `Input` with a `Search` icon for the search bar.

## Verification Plan

### Manual Verification
1. Open a check in the Command Center.
2. Go to the **Funds** tab.
3. Click **Add** in the Stakeholders section.
4. Verify the new search bar appears.
5. Type a name:
   - Confirm the homeowner for the current claim appears.
   - Confirm stakeholders from the settings tab appear.
   - Confirm homeowners from *other* claims do NOT appear.
6. Select a stakeholder to verify they are successfully added to the check.