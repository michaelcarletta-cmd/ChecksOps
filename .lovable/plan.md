# Plan: Final Visual Harmonization of Settings

Standardize the visual structure, color accents, and spacing of the **Profile**, **Users**, and **Partners** settings pages to ensure they perfectly match the platform's visual ecosystem (as seen in "Company Settings").

## User Review Required

> [!IMPORTANT]
> This plan focuses on fixing the "not showing up" issue by ensuring the parent layout in `src/pages/Settings.tsx` is correctly configured and that child components use the standardized design tokens without redundant margins.

- Do you have a specific color preference for the "Partners" tab other than Violet/Amber?
- Should any other settings tabs (e.g., Audit Logs) be included in this visual sweep?

## Proposed Changes

### 1. Parent Layout Standardization (`src/pages/Settings.tsx`)
- Standardize all `TabsContent` wrappers for Profile, Users, and Partners to use:
  - `pt-6` (top padding for alignment)
  - `space-y-6` (vertical rhythm between sections)
  - `pb-12` (bottom clearance)
  - `max-w-7xl mx-auto` (centering)

### 2. Profile Settings (`src/components/settings/ProfileSettings.tsx`)
- Ensure `SettingsHero` icon is `User` with `text-primary`.
- **Personal Information**: `User` icon, Sky-blue accent (`text-sky-500`).
- **Company Logo**: `Building2` icon, Violet accent (`text-violet-500`).
- **Licenses**: Handled via `LicensesSettings` (Violet accent).
- **Email Signature**: `Mail` icon, Emerald accent (`text-emerald-500`).
- **Account Actions**: `Save` icon, Emerald accent (`text-emerald-500`).

### 3. User Management (`src/components/settings/UserManagementSettings.tsx`)
- **Pending Approvals**: `Clock` icon, Orange accent (`text-orange-500`).
- **Active Users**: `Shield` icon, Sky-blue accent (`text-sky-500`).
- Remove any internal `max-w-7xl` or redundant top margins that cause layout shifts.

### 4. Partners / Workspaces (`src/components/workspaces/WorkspaceList.tsx`)
- **Invitations**: `Plus` icon, Amber accent (`text-amber-500`).
- **Connected Workspaces**: `Users` icon, Violet accent (`text-violet-500`).

## Technical Details
- Use `SectionCard` component for all major blocks.
- Accents will use standardized gradient patterns: `bg-gradient-to-r from-{color}-500/60 to-{color}-500/10`.
- Verify that `SettingsHero` no longer includes `mb-6` internally (already patched).
