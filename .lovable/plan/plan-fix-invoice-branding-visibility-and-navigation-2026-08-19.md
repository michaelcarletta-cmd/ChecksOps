# Plan - Fix Invoice Branding Visibility and Navigation

The user is reporting that they "still do not see invoice branding" despite recent attempts to fix it. My investigation shows that the `Invoice Branding` button in `InvoicesTab.tsx` points to `?tab=branding`, but in the main `Settings.tsx` (Freedom CRM), the branding section is actually inside the `organization` tab under a collapsible named "Company Branding". 

In the `WhiteLabelSettings.tsx` (routed/white-label view), there is a `branding` tab, but it renders a component called `BrandingSettings` which only handles logos and colors, omitting the "Invoice Branding" section found in `CompanyBrandingSettings.tsx`.

## Proposed Changes

### 1. Fix Navigation and Visibility in Freedom CRM (Settings.tsx)
- Ensure the `Invoice Branding` button in `InvoicesTab.tsx` correctly navigates to `?tab=organization&section=branding`.
- Update `Settings.tsx` to handle the `section` parameter, automatically expanding the "Company Branding" collapsible when present.

### 2. Fix Visibility in White-Label CRM (WhiteLabelSettings.tsx)
- Update the `branding` tab in `WhiteLabelSettings.tsx` to include `CompanyBrandingSettings`.
- Currently, `WhiteLabelSettings.tsx` uses a local `BrandingSettings` function that is limited. I will replace or augment this to include the invoice-specific branding fields (letterhead, footer, terms).

### 3. Synchronize branding components
- Ensure `CompanyBrandingSettings.tsx` is robust enough to be used in both contexts or extract the "Invoice Branding" section into a shared component if needed.

## Technical Details

### src/pages/payments/InvoicesTab.tsx
- Update the navigation link from `?tab=branding` to `?tab=organization&section=branding` for the Freedom CRM path.

### src/pages/Settings.tsx
- Add logic to check for `searchParams.get("section") === "branding"`.
- If true, call `setCompanyBrandingOpen(true)`.

### src/components/white-label/WhiteLabelSettings.tsx
- Modify the `branding` tab content to render `CompanyBrandingSettings` instead of the limited local `BrandingSettings`.
- Verify RLS and tenant context within `CompanyBrandingSettings` work correctly for white-label users.

## Verification Plan

### Automated Tests
- I will use a Playwright script to:
  1. Navigate to the Invoices tab.
  2. Click "Invoice Branding".
  3. Verify the browser lands on the Settings page with the Branding section visible and expanded.
  4. Repeat for a white-labeled route (simulated via URL slug).

### Manual Verification
- Check the console for any RLS or 404 errors when loading branding settings as a non-admin tenant user.
