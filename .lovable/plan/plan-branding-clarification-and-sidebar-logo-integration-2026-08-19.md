# Plan: Branding Clarification and Sidebar Logo Integration

The user asked if the "letterhead photo" also updates the company logo in the top-left border. Currently, the sidebar logo is a static image asset, while the letterhead is a dynamic setting used for documents. I will clarify this and offer to link them if desired.

## Proposed Changes

### Configuration & Logic
- Investigate the `AppSidebar.tsx` to confirm logo sourcing.
- Check `CompanyBrandingSettings.tsx` to see if a specific "Logo" upload field should be added to separate it from the letterhead.

### Components
- **AppSidebar.tsx**: Update to fetch the dynamic `logo_url` or `letterhead_url` from the database if a tenant-specific branding is available, falling back to the default Freedom logo.
- **CompanyBrandingSettings.tsx**: (Optional) Add a "Company Logo" upload field if the user wants a square/icon-style logo separate from the wide letterhead header.

## User Review Required

> [!IMPORTANT]
> Currently, the **Letterhead** photo and the **Sidebar Logo** are separate. The letterhead is used for documents (wide format), while the sidebar uses a fixed image.
> 
> Would you like me to:
> 1. Keep them separate and add a new "Company Logo" upload button in settings for the sidebar?
> 2. Automatically use the "Letterhead" photo for the sidebar as well (note: it might look very small or cut off if the letterhead is very wide)?
