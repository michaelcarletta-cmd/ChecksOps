# Plan: Complete Design Overhaul for Settings Pages

Standardize all remaining settings components and the main Settings page to use the unified design system featuring `SettingsHero`, `SectionCard`, and consistent full-width layouts.

## User Review Required

> [!IMPORTANT]
> The overhaul involves restructuring several complex settings pages. While functionality is preserved, the visual layout will shift to a cleaner, full-width "hero + card" design.

## Proposed Changes

### Main Settings Page (`src/pages/Settings.tsx`)
- Standardize all `TabsContent` containers to use `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-12`.
- Update tab triggers to match the new high-contrast icon style.
- Ensure consistent spacing between hero headers and section cards.

### Automations Settings (`src/components/settings/AutomationsSettings.tsx`)
- Wrap the component in `max-w-7xl mx-auto`.
- Replace the simple header with `SettingsHero`.
- Transition workflow lists and configurations into `SectionCard` components.
- Standardize spacing and internal card styles.

### Referral Settings (`src/components/settings/ReferralSettings.tsx`)
- Wrap the component in `max-w-7xl mx-auto`.
- Standardize header with `SettingsHero`.
- Convert the "Share your code" and "Redeem a code" grid sections into themed `SectionCard` components.
- Ensure the "Referral History" table matches global table standards.

### Import Settings (`src/components/settings/ImportSettings.tsx`)
- Wrap in `max-w-7xl mx-auto`.
- Add `SettingsHero` for "Data Import".
- Move import configuration and tips into `SectionCard` components.

### Workflow Sub-components (Loss Types, Custom Fields, Signature Presets)
- Ensure these components render correctly both as standalone pages and when `embedded` in the Workflow tab.
- Apply `SectionCard` themes to their internal groupings.

### Admin/Audit Components (Audit Logs, Notifications, Diagnostics, Backup, White-label)
- Apply `SettingsHero` and `SectionCard` to all remaining admin-only panels.
- Ensure consistent "Admin" badge styling across these panels.

## Technical Details
- Use `SectionCard` props: `title`, `icon`, `accent` (gradient), and `description`.
- Use `SettingsHero` props: `title`, `description`, `badge`, and `icon`.
- Maintain all existing `useQuery` and `useMutation` logic to ensure no data regressions.
- Verify `max-w-7xl` containment to prevent "ultra-wide" layout issues on large monitors.
