# Plan: Unified Design System for Settings Pages

Refactor multiple settings components and pages to follow the new "ChecksOps Theme" (gradient heroes, accented cards, consistent spacing) as requested by the user.

## Proposed Changes

### 1. Promotions & Utility Components
- Ensure `src/components/settings/SectionCard.tsx` and `src/components/settings/SettingsHero.tsx` are robust for reuse across different contexts (tabbed vs standalone).

### 2. Refactor Components to new Theme
- **AI Knowledge Base (`AIKnowledgeBaseSettings.tsx`)**:
  - Wrap top-level sections in `SettingsHero` and `SectionCard`.
  - Apply the color accent (Brain icon color) to card gradients.
- **Tenant Bank Account (`TenantBankAccountSettings.tsx`)**:
  - Refactor to use `SettingsHero` for the title/description and `SectionCard` for the account list.
- **Compliance & Docs (`ComplianceSettings.tsx`)**:
  - Refactor to use `SettingsHero` and `SectionCard`.
- **Tenant Usage (`TenantUsageDashboard.tsx`)**:
  - Since this is a Dialog, I will apply the theme elements (gradients, consistent card styling) within the dialog content to match the visual language of the other pages.
- **RD Automations (`RDAutomationSettings.tsx`)**:
  - Apply `SectionCard` styling.
- **Team Caps (`TeamCapsSettings.tsx`)**:
  - Apply `SectionCard` styling.

### 3. Refactor Standalone Pages
- **Find a Pro Directory (`FindAPro.tsx`)**:
  - Overhaul the directory page to use the `SettingsHero` pattern for the header and `SectionCard` patterns for filters and results where appropriate, while maintaining its unique public-facing character.

### 4. Tab Integration in `Settings.tsx`
- Ensure all tabs in `Settings.tsx` (Workflow, Users, Usage, Automations, AI Knowledge, Company Settings, Import, etc.) are wrapped in consistent container widths (`max-w-7xl`) and use the unified component set.

## Technical Details
- Use `SectionCard` from `src/components/settings/SectionCard.tsx`.
- Use `SettingsHero` from `src/components/settings/SettingsHero.tsx`.
- Maintain consistent padding and margins using Tailwind utility classes.
- Ensure all components handle loading and empty states gracefully.
