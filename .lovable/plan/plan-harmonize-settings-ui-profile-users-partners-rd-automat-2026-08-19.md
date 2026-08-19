# Plan - Harmonize Settings UI (Profile, Users, Partners, RD Automation)

Update remaining settings components to match the modern "diagnostic" look used in Branding, Email, and Referrals.

## Proposed Changes

### UI & Components

#### Profile Settings (`src/components/settings/ProfileSettings.tsx`)
- Refactor the component to use the full-width `SettingsHero` and `SectionCard` pattern.
- Wrap Personal Information, Company Logo, Email Signature, Password, and Notification Preferences in `SectionCard` components with semantic color accents (sky, violet, emerald, orange).
- Standardize the "Account Actions" save button at the bottom.

#### User Management (`src/components/settings/UserManagementSettings.tsx`)
- Refactor to use `SettingsHero` and `SectionCard`.
- Modernize the "Pending Staff Approvals" list with an orange accent and backdrop-blur effects.
- Modernize the "Active System Users" grid with a sky-blue accent and glassmorphism cards.
- Standardize badges and action buttons.

#### Partner Workspaces (`src/components/workspaces/WorkspaceList.tsx`)
- Update the layout to use `SettingsHero` and `SectionCard` when not in embedded mode.
- Refactor workspace cards to use `bg-muted/30`, backdrop filters, and consistent border tokens with violet accents.

#### RD Automation (`src/components/settings/RDAutomationSettings.tsx`)
- Ensure consistent use of `SettingsHero` and `SectionCard`.
- Standardize the layout to match the rest of the settings ecosystem.

### Technical Details
- Use `SettingsHero` for consistent headers.
- Wrap content in `SectionCard` with semantic color accents:
    - Profile: emerald/sky/violet
    - Users: sky/orange
    - Partners: violet
    - RD Automation: amber
- Apply `backdrop-blur-sm` and `bg-muted/20` or `bg-card` consistently.
- Ensure `max-w-7xl mx-auto` is applied for standard page layouts.
- Remove redundant containers or borders in `src/pages/Settings.tsx` for these tabs to allow the components to take full width.

## Verification Plan

### Automated Tests
- Run `lovable-exec test` to ensure no regressions in auth or profile logic.

### Manual Verification
- Navigate to Profile, Users, Partners, and RD Automation tabs in the Settings page.
- Verify visual consistency in headers, card styles, and gradients.
- Check responsive layout on mobile and desktop viewports.
