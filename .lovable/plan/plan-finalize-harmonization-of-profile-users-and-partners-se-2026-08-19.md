# Plan: Finalize Harmonization of Profile, Users, and Partners Settings

The user reports that the settings pages for Profile, Users, and Partners have not been updated despite previous attempts. I will verify the current state of these components, ensure they correctly use the `SettingsHero` and `SectionCard` design system, and remove any restrictive wrappers in the parent `Settings.tsx` that might be causing layout issues or preventing the new design from being visible.

## User Review Required

> [!IMPORTANT]
> I will be forcing the layout of these tabs to be full-width and ensuring the themed cards (sky, violet, emerald, orange) are properly applied. If you have a specific color preference for a section, let me know.

## Proposed Changes

### Settings Page Layout
#### [src/pages/Settings.tsx](src/pages/Settings.tsx)
- Ensure all `TabsContent` wrappers for `profile`, `users`, and `workspaces` (Partners) use the `max-w-7xl mx-auto` container.
- Verify that no duplicate containers or legacy `Card` wrappers are around these components.

### Profile Settings
#### [src/components/settings/ProfileSettings.tsx](src/components/settings/ProfileSettings.tsx)
- Confirm `SettingsHero` is at the top with the `User` icon and "Personal Settings" badge.
- Ensure "Personal Information", "Company Logo", "Licenses", "Email Signature", "Security" (Password), and "Notifications" are all inside `SectionCard` components with their respective theme colors (sky, violet, emerald, orange).
- Standardize the "Account Actions" card at the bottom.

### User Management
#### [src/components/settings/UserManagementSettings.tsx](src/components/settings/UserManagementSettings.tsx)
- Confirm `SettingsHero` is present with the `Users` icon and "Team Access" badge.
- Ensure "Pending Staff Approvals" uses an orange-themed `SectionCard`.
- Ensure "Active System Users" uses a sky-blue themed `SectionCard`.
- Apply backdrop filters and modern border styles to the user list items.

### Partner Workspaces
#### [src/components/workspaces/WorkspaceList.tsx](src/components/workspaces/WorkspaceList.tsx)
- Ensure the `SettingsHero` shows the `Share2` icon and "Shared Workspaces" badge when not embedded.
- Harmonize "Pending Invitations" (amber) and "Connected Workspaces" (violet) using `SectionCard`.
- Update the grid of workspaces to use the modern design with `backdrop-blur` and themed borders.

## Verification Plan

### Automated Tests
- Check for build errors to ensure all component imports and props are correct.
- Verify that `SettingsHero` and `SectionCard` are used in all three files.

### Manual Verification
- I will use Playwright to navigate to each of the three tabs (Profile, Users, Partners) and take screenshots to confirm the design matches the expected "WalletOps" style (gradients, full-width containers, and SectionCards).
