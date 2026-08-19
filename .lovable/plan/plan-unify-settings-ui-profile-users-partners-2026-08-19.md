# Plan - Unify Settings UI (Profile, Users, Partners)

Update remaining settings components to match the modern "diagnostic" look used in Branding, Email, and Referrals.

## User Review Required

> [!IMPORTANT]
> - **Partners Tab**: I will ensure it uses the full-width layout with `SettingsHero` and `SectionCard`.
> - **User Management**: I will modernize the "Active Users" grid and "Pending Approvals" to use the glassmorphism/themed card style.
> - **Profile**: I will wrap the remaining account actions and signature fields into the standard `SectionCard` pattern.

## Proposed Changes

### UI & Components

#### Profile Settings (`src/components/settings/ProfileSettings.tsx`)
- Ensure all sections (Personal Info, Logo, Signature, Password, Notifications, Account Actions) consistently use `SectionCard` with appropriate icons and gradients.
- Standardize spacing and responsive behavior to match `ReferralSettings`.

#### User Management (`src/components/settings/UserManagementSettings.tsx`)
- Update "Pending Staff Approvals" card to use an orange gradient accent and backdrop-blur.
- Refactor the active users list to use `SectionCard` with a sky-blue accent.
- Standardize badges and buttons for a cleaner, unified appearance.

#### Partner Workspaces (`src/components/workspaces/WorkspaceList.tsx`)
- Update the layout to use `SettingsHero` and `SectionCard` (when not embedded).
- Refactor workspace cards to use `bg-muted/30`, backdrop filters, and consistent border tokens.
- Add themed accents (violet/indigo) to match the "Partners" icon.

### Technical Details
- Use `SettingsHero` for consistent headers.
- Wrap content in `SectionCard` with semantic color accents:
    - Profile: emerald/sky
    - Users: sky/orange
    - Partners: violet
- Apply `backdrop-blur-sm` and `bg-muted/20` or `bg-card` consistently.
- Ensure `max-w-7xl mx-auto` is applied for standard page layouts.

## Verification Plan

### Automated Tests
- Run `lovable-exec test` to ensure no regressions in auth or profile logic.
- Verify component rendering with basic snapshot tests if available.

### Manual Verification
- Navigate to each tab in the Settings page.
- Verify visual consistency in headers, card styles, and gradients across all tabs.
- Check responsive layout on mobile and desktop viewports.
