# Plan: Harmonize Settings Design across Profile, Users, and Partners

Standardize the visual structure, color accents, and layout of Profile, Users, and Partners settings pages to match the "Company Settings" reference, using a unified `SettingsHero` and `SectionCard` ecosystem.

## Proposed Changes

### UI & UX Improvements

#### `src/components/settings/SettingsHero.tsx`
- Ensure the `SettingsHero` has a consistent layout and spacing. (Completed in previous turn).

#### `src/components/settings/ProfileSettings.tsx`
- Align icons and colors with the reference image.
- **Personal Information**: Change icon to `User` with `sky-500` accent.
- **Company Logo**: Ensure it uses `Building2` with `violet-500` accent.
- **Licenses**: Ensure `LicensesSettings` inside uses `Award` with `violet-500` accent.
- **Email Signature**: Use `Mail` with `emerald-500` accent.
- **Change Password**: Ensure `ChangePasswordCard` inside uses `KeyRound` with `emerald-500` accent.
- **Account Actions**: Use `Save` with `emerald-500` accent.

#### `src/components/settings/UserManagementSettings.tsx`
- **Pending Approvals**: Use `Clock` with `orange-500` accent (matches previous turn's progress).
- **Active System Users**: Use `Shield` with `sky-500` accent.
- Standardize the list item styling (backdrop blur, subtle borders).

#### `src/components/workspaces/WorkspaceList.tsx`
- **Pending Invitations**: Use `Plus` with `amber-500` accent.
- **Connected Workspaces**: Use `Users` with `violet-500` accent.
- Standardize the grid of workspace cards with consistent `Folder` icons and `violet-400` accents.

#### `src/pages/Settings.tsx`
- Verify that `TabsContent` for all tabs provides consistent padding (`pt-6 space-y-6 pb-12`).

## Technical Details

- Use standard Tailwind semantic colors: `sky-500`, `violet-500`, `emerald-500`, `orange-500`.
- Apply `bg-gradient-to-r` for card accents consistently.
- Ensure all sections use `SectionCard` to maintain the unified border and shadow style.

## Verification Plan

- **Visual Audit**: Compare Profile, Users, and Partners tabs against the reference image for Company Settings.
- **Alignment Check**: Ensure the spacing between the `SettingsHero` and the first `SectionCard` is identical across all tabs.
- **Color Consistency**: Verify that similar categories of settings (e.g., identity, team, collaborative spaces) share the same color accents.
