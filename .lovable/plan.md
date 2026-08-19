# Plan: Settings UI Harmonization

The user wants all setting pages to have the same theme as the "Branding" and "Email" sections. This means using the "Hero Section" with gradients, `SectionCard` components with accent bars, and a unified full-width layout.

## Proposed Changes

### 1. New Shared Components
- Create `src/components/settings/SettingsHero.tsx`: A reusable hero section with gradient background, icon, title, and description.
- Create `src/components/settings/SectionCard.tsx`: Move the `SectionCard` component from `CompanyBrandingSettings.tsx` to a shared file so it can be used across all settings.

### 2. Refactor Existing Settings Components
I will update the following components to use the new `SettingsHero` and `SectionCard` structure:

- **ProfileSettings.tsx**: Add Hero, wrap Personal Info, Company Logo, Signature in `SectionCard`s.
- **UserManagementSettings.tsx**: Add Hero, wrap User Management table and Pending Approvals in `SectionCard`s.
- **OrganizationSettings.tsx**: Add Hero, wrap Org details and Members in `SectionCard`s.
- **EmailSenderSettings.tsx**: Add Hero, wrap Email Sender and Custom Domain in `SectionCard`s.
- **UsageLogTab.tsx**: Add Hero and wrap in `SectionCard`.
- **LossTypesSettings.tsx**: Update to use `SectionCard`.
- **AutomationsSettings.tsx**: Update to use `SectionCard`.
- **CustomFieldsSettings.tsx**: Update to use `SectionCard`.
- **SignaturePresetsSettings.tsx**: Update to use `SectionCard`.

### 3. Layout Optimization
- Update `src/pages/Settings.tsx` to ensure the tab content areas are full-width and consistent.
- Apply the dark theme semantic tokens (background, border-border/60) consistently.

## User Review Required
> [!IMPORTANT]
> This change will significantly alter the layout of all settings pages to match the "Branding" section's modern, card-based look with colorful accent bars. 

Do you want specific accent colors for specific settings (e.g., Security = Red, Users = Blue), or should I choose logical defaults?
