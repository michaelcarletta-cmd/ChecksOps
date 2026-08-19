# Plan - Unified Settings Theme Refactor

The goal is to apply the shared design system (using `SectionCard` and `SettingsHero`) to all remaining settings panels and the main `Settings.tsx` page, ensuring a consistent look and feel throughout the platform.

## Proposed Changes

### 1. Refactor Main Settings Page (`src/pages/Settings.tsx`)
- Update the workflow tab to use `SettingsHero` and wrap components (Claim Statuses, Loss Types, Custom Fields, Signature Presets) in `SectionCard`s.
- Update the organization tab to wrap components (Company Settings, Bank Account, Document Library, Email Sender, Compliance, Security Log) in `SectionCard`s.
- Ensure all other tabs (Usage, Import, Audit Logs, etc.) use `SettingsHero` and `SectionCard` where applicable.

### 2. Refactor Automation Components
- `AutomationsSettings.tsx`: Use `SettingsHero` and wrap automation lists and logs in `SectionCard`s.
- `TaskAutomationsSettings.tsx`: Refactor to use `SectionCard` (instead of standard `Card`).
- `RDAutomationSettings.tsx`: Refactor to use `SectionCard`.

### 3. Refactor Workflow Components
- `LossTypesSettings.tsx`: Refactor to use `SectionCard`.
- `CustomFieldsSettings.tsx`: Refactor to use `SectionCard`.
- `SignaturePresetsSettings.tsx`: Refactor to use `SectionCard`.

### 4. Refactor Integration & Utility Components
- `ImportSettings.tsx`: Use `SettingsHero` and wrap import flow in `SectionCard`s.
- `QuickBooksSettings.tsx`: Refactor to use `SectionCard`.
- `ZapierIntegrationSettings.tsx`: Refactor to use `SectionCard`.
- `CheckAltSettings.tsx`: Refactor to use `SectionCard`.
- `ComplianceSettings.tsx`: Refactor to use `SectionCard`.
- `ReferralSettings.tsx`: Refactor to use `SectionCard`.
- `TenantBankAccountSettings.tsx`: Refactor to use `SectionCard`.
- `TenantDocumentLibrary.tsx`: Refactor to use `SectionCard`.

### 5. Refactor Communication & Logs
- `EmailTemplatesSettings.tsx`: Use `SettingsHero` and wrap template lists in `SectionCard`s.
- `SMSTemplatesSettings.tsx`: Refactor to use `SectionCard`.
- `AuditLogSettings.tsx`: Refactor to use `SectionCard`.
- `NotificationPreferencesSettings.tsx`: Refactor to use `SectionCard`.
- `NotificationDeliveryLogView.tsx`: Refactor to use `SectionCard`.
- `StatusUrgencyNotificationsSettings.tsx`: Refactor to use `SectionCard`.
- `GLBASecurityEventsLog.tsx`: Refactor to use `SectionCard`.

### 6. Refactor Admin & Support Panels
- `TenantManagement.tsx`: Refactor tenant list items to use `SectionCard`.
- `MaintenancePaymentsTracker.tsx`: Refactor to use `SectionCard`.
- `BackupStatusSettings.tsx`: Refactor to use `SectionCard`.
- `JobNimbusSyncDiagnostics.tsx`: Refactor to use `SectionCard`.
- `TenantEmailHealthPanel.tsx`: Refactor to use `SectionCard`.
- `TenantProBadgeManagement.tsx`: Refactor to use `SectionCard`.

## Technical Details
- All components will use `SectionCard` with consistent `accent` gradients (e.g., `bg-gradient-to-r from-primary/60 to-primary/10`).
- `SettingsHero` will provide a unified header for each settings section.
- Layouts will be optimized for the `max-w-7xl` container in `Settings.tsx`.
- Standard `Card` components will be replaced with `SectionCard` to provide the requested theme.
