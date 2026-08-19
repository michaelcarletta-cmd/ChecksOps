# Plan: Unified Unified Settings Design

Standardize the visual structure and layout of Profile, Users, and Partners settings pages to follow the `SettingsHero` and `SectionCard` ecosystem with consistent color accents and spacing.

## User Review Required

> [!IMPORTANT]
> - Profile settings will use sky-blue and emerald accents.
> - User Management will use orange (pending) and sky-blue (active) accents.
> - Partner Ecosystem will use violet accents.
> - All tabs will be updated to include consistent top padding (`pt-6`) and vertical spacing (`space-y-6`).

## Proposed Changes

### UI & UX Improvements

#### `src/pages/Settings.tsx`
- Ensure all `TabsContent` wrappers for Profile, Users, and Partners use consistent spacing: `space-y-6 pt-6 pb-12`.

#### `src/components/settings/ProfileSettings.tsx`
- Ensure the top-level container has no redundant padding (`pt-0`).
- Verify all sections (Personal Info, Logo, Licenses, Signature, Password, Actions) use the `SectionCard` pattern with appropriate icons and semantic colors (Sky for personal, Violet for branding, Emerald for signature/actions).

#### `src/components/settings/UserManagementSettings.tsx`
- Ensure the top-level container has no redundant padding (`pt-0`).
- Verify `SettingsHero` and `SectionCard` usage for Pending (Orange) and Active (Sky) user lists.
- Standardize the user list item design with backdrop blur and hover effects.

#### `src/components/workspaces/WorkspaceList.tsx`
- Ensure the top-level container has no redundant padding (`pt-0`).
- Verify `SettingsHero` and `SectionCard` usage for Invitations (Amber) and Connected Workspaces (Violet).
- Standardize the workspace card design with consistent grouping and icons.

## Technical Details

- **Layout Consistency**: Parent `TabsContent` in `Settings.tsx` will provide the primary vertical spacing. Child components will be "padding-neutral" (`pt-0`) at their root.
- **Design Tokens**: Use `bg-gradient-to-r` with semantic color ramps (sky, emerald, violet, orange) for `SectionCard` accents.
- **Component Harmony**: All cards will use `border-border/60` and `backdrop-blur-sm` where background transparency is applied.

## Verification Plan

- **Visual Audit**: Navigate between Profile, Users, and Partners tabs in the Settings page to ensure the `SettingsHero` and section groupings maintain exact alignment and spacing.
- **Responsiveness**: Check the unified grid layouts on mobile and desktop viewports.
