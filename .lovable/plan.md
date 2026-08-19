---
name: Simplify Company Settings
description: Restrict Company Settings to Company Info, Letterhead, Invoice Branding, Email Sender, and Custom Domain, utilizing full page width.
type: feature
---

# Plan: Simplify Company Settings

The user wants to streamline the "Company Settings" (Branding) section to only include specific sections: Company Info, Letterhead, Invoice Branding, Email Sender, and Custom sending domain. All other settings (like E-signature email, Endorsement email, Team caps, etc.) should be removed from this view. The layout should utilize the entire page.

## Proposed Changes

### 1. `src/components/settings/CompanyBrandingSettings.tsx`
- Remove all sections except:
  - **Company Information** (Company Name, Address, Phone, Email)
  - **Letterhead** (Primary letterhead upload)
  - **Invoice Branding** (Invoice letterhead, Footer note, Default terms)
- Remove:
  - **Team Caps** (already moved to Settings > Users according to memory, but still present in this component)
  - **E-signature Email Branding**
  - **Endorsement Email Branding**
  - **Signature Coordinates**
  - **Deposit Settings** (OCW Bank Account ID)
- Update layout to use full width (removing the 2-column grid or adjusting it to better fit the remaining sections).

### 2. `src/pages/Settings.tsx`
- Ensure the "Organization" tab (or whichever tab contains Branding) is renamed or structured to focus on these company settings.
- The user mentioned "Company Settings" in the prompt, but the current UI uses "Organization" for branding. I will check if a rename is needed to match user mental model ("Company Settings").
- The "Email Sender" and "Custom sending domain" are currently in a separate "Email" tab. I will consolidate them into the "Organization" (or new "Company Settings") tab as requested.

### 3. Consolidation Strategy
- Move `EmailSenderSettings` component into the `Organization` tab content.
- Update the `Tabs` list to remove redundant tabs if they are now merged.

## Technical Details
- Modify `CompanyBrandingSettings.tsx` to remove unwanted sections and state variables.
- Update `Settings.tsx` to merge the "Email" tab content into the "Organization" tab.
- Adjust Tailwind classes for full-width layout (e.g., removing `lg:grid-cols-2` from the grid wrapper).

## Verification Plan
- Verify that only requested sections are visible in the Branding/Company section.
- Verify that Email Sender and Custom Domain settings are present in the same view.
- Verify that the layout uses the full width of the container.
- Ensure all saving functionality still works for the remaining fields.
