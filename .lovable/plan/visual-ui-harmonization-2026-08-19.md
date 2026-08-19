---
name: Visual UI Harmonization
description: Align Settings and Payments UI with the WalletOps design system (gradients, hero sections, card accents).
type: design
---

# Visual UI Harmonization

## Goal
Make the **Settings** (Company Branding) and **Payments** pages visually consistent with the **WalletOps** dashboard.

## Key Design Patterns (from WalletOps)
- **Hero Section**: A large, gradient-background container with a subtle blur effect (`bg-gradient-to-br from-primary/15 via-primary/5 to-background`), prominent title, and descriptive text.
- **Card Accents**: Cards with a colored top border (`h-1.5`) and consistent padding/spacing.
- **Iconography**: Use of Lucide icons with specific color tones (sky, violet, emerald) to differentiate sections.
- **Semantic Badges**: Using established `STATUS_TONE` and `READINESS_COPY` patterns for consistency.
- **Layout**: Clean grid layouts (usually `grid-cols-1` or `lg:grid-cols-2`) for settings and summary sections.

## Implementation Details

### 1. Payments Page (`src/pages/Payments.tsx`)
- Wrap the header in a WalletOps-style Hero section.
- Add summary tiles (similar to WalletOps "Pending in/out" or Readiness badges) at the top of the Payments page if relevant data is available.
- Ensure `Tabs` and their contents follow the card-based layout with accents.

### 2. Settings / Branding (`src/components/settings/CompanyBrandingSettings.tsx`)
- Add a Hero section at the top of the settings view.
- Upgrade existing `Card` components to `SectionCard` pattern (top accent border).
- Group related settings more clearly using the WalletOps grid layout.
