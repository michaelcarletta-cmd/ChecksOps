# Plan - Unify Settings Design System

Standardize the remaining settings modules (Profile, Usage, AI Key, Users, Partners) using the `SettingsHero` and `SectionCard` design pattern.

## User Review Required

> [!IMPORTANT]
> I will be applying the `max-w-7xl` container and gradient-accented cards to the remaining settings tabs. This will change the layout from standard cards to the new "Hero + Sectioned" style used in Branding and AI Knowledge settings.

## Proposed Changes

### 1. Profile Settings
- Replace standard card with `SettingsHero` (User icon, "Account Management" badge).
- Wrap profile info and security/password settings in `SectionCard` with primary blue accent.

### 2. Usage Log
- Update `UsageLogTab.tsx` to use `SettingsHero` (BarChart icon, "Billing & Usage" badge).
- Wrap usage summaries and the detailed history table in `SectionCard`.
- Standardize the "Monthly Total" stats grid to match the platform's new diagnostic look.

### 3. AI Key Settings
- Relocate or ensure consistency for `TenantAIKeySettings.tsx` (found in `src/components/white-label/`).
- Wrap the API key status and "How it works" guide in `SectionCard` with amber accents (standard for security/keys).

### 4. User Management
- Update `UserManagementSettings.tsx` to use `SettingsHero` (Users icon, "Team Administration" badge).
- Wrap user list and "Add User" forms in `SectionCard` with violet accents.

### 5. Partner Workspaces
- Update `WorkspaceList.tsx` (when embedded in Settings) to match the `SectionCard` pattern.
- Ensure the "Shared Workspaces" view uses the standardized layout widths.

## Technical Details

- Use `SettingsHero` for page-level headers.
- Use `SectionCard` for grouping functional areas.
- Maintain `max-w-7xl mx-auto` for consistent alignment across all tabs in `src/pages/Settings.tsx`.
- Apply specific semantic gradients:
    - **Primary Blue**: Profile, Workflow.
    - **Violet**: Users, Security.
    - **Amber**: AI Keys, Alerts.
    - **Sky/Emerald**: Usage, Deposits.
