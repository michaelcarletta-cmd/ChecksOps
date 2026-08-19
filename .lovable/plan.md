# Plan - Visual Consistency for ChecksOps Settings

Finish the visual styling pass for the **Profile**, **Users**, and **Partners** tabs in the ChecksOps settings (`/freedom/settings`) to ensure they match the design system used in **Company Settings** and **Compliance & Identity** (SettingsHero + SectionCard with semantic tokens).

## User Review Required

> [!IMPORTANT]
> This is a styling-only update. No functionality, permissions, or database logic will be changed.

## Proposed Changes

### Styling & Layout Consistency

#### Profile Tab
- Refactor the profile tab in `WhiteLabelSettings.tsx` to use `SettingsHero` and `SectionCard`.
- Group Personal Info into a sky-accented card.
- Group Signature and Security (Change Password) into their own themed cards.
- Ensure the logo display uses themed borders instead of hardcoded white backgrounds.

#### Users Tab (`TenantUserManager.tsx`)
- Update the layout to match the unified vertical rhythm.
- Use `SectionCard` for "Add Team Member" (Orange accent) and "Active Team Members" (Sky accent).
- Replace any remaining hardcoded colors (like `bg-sky-500/20`) with semantic theme tokens if applicable, while maintaining the intended visual distinction.

#### Partners Tab (`TenantPartnerManager.tsx`)
- Standardize the "Your Partner Code" section with a themed `SectionCard` (Amber accent).
- Standardize "Connect with a Partner" (Sky accent) and "Active Partners" (Violet accent) cards.
- Ensure consistent spacing and hover effects on partner list items.

### Technical Implementation
- Standardize the `main` container in `WhiteLabelSettings.tsx` to align with the generic `SettingsPageShell` properties (max-width, padding).
- Audit all three components for hardcoded `bg-white`, `text-black`, or specific hex codes, replacing them with `bg-card`, `text-foreground`, `border-border`, etc.
- Verify production build to ensure no JSX tags are left orphaned.

## Verification Plan

### Automated Tests
- Run `npx tsgo --noEmit` to verify TypeScript integrity and JSX structure.

### Manual Verification
- Capture screenshots of the updated Profile, Users, and Partners tabs in the preview.
- Compare them side-by-side with the Company Settings tab to confirm identical vertical rhythm, card styling, and typography.
