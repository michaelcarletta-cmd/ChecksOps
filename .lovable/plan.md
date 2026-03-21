

# Plan: Remove Make.com, Remove Increase, Remove Signature Field Templates

## Summary
Three removals: (1) Replace all Make.com references with Zapier webhook integration, (2) Remove Increase banking integration from the check command center, (3) Remove Signature Field Templates from workflow management settings.

---

## 1. Replace Make.com with Zapier

**Files to modify:**

- **`src/components/settings/MakeIntegrationSettings.tsx`** — Rename/rewrite to `ZapierIntegrationSettings.tsx`. Replace all Make.com references with Zapier webhook pattern. Change UI labels, placeholder URLs (`https://hooks.zapier.com/...`), and descriptions. Keep the same webhook-calling architecture but rebrand entirely.

- **`src/components/settings/CompanyBrandingSettings.tsx`** — Replace the "SignNow Integration (via Make.com)" card (lines 634-670+) with a Zapier webhook card. Update state variable names from `signnowWebhookUrl` / `signnow_make_webhook_url` to a Zapier-oriented name. Update the save logic to use the new column name.

- **`src/components/settings/AutomationsSettings.tsx`** — Change "Call Webhook (Make.com)" label to "Call Webhook (Zapier)" and update the webhook URL placeholder/description from Make.com to Zapier.

- **`src/pages/Settings.tsx`** — Replace `MakeIntegrationSettings` import with `ZapierIntegrationSettings`.

- **`supabase/functions/execute-automations/index.ts`** — Update comments referencing Make.com to Zapier.

- **`supabase/functions/signature-webhook/index.ts`** — Update comment referencing Make.com format.

- **Database migration** — Rename `signnow_make_webhook_url` column to `zapier_webhook_url` in `company_branding` table.

## 2. Remove Increase from Check Command Center

**Files to modify:**

- **`src/components/deposit-ops/DepositOperationsConsole.tsx`** — Remove all Increase imports (`IncreaseAccountSelector`, `DepositToIncreaseButton`, `IncreaseSyncAllButton`, `IncreaseStatusBadge`). Remove the `<IncreaseAccountSelector />` section, the Increase column in the deposit items table, and all Increase-related fields from the type definition. Replace with a placeholder "Banking provider not configured" message where appropriate.

- **`src/components/deposit-ops/IncreaseDeposit.tsx`** — Delete this file entirely.

- **Edge functions to delete:**
  - `supabase/functions/increase-health-check/` (including test)
  - `supabase/functions/increase-list-accounts/`
  - `supabase/functions/increase-create-check-deposit/`
  - `supabase/functions/increase-sync-check-deposit-status/`

- **`supabase/config.toml`** — No Increase entries exist there, so no change needed.

## 3. Remove Signature Field Templates from Settings

**Files to modify:**

- **`src/pages/Settings.tsx`** — Remove the entire "Signature Field Templates" collapsible section (lines ~480-505). Remove the `SignatureFieldTemplatesSettings` import. Remove the `signatureTemplatesOpen` state if it exists.

- **`src/components/settings/SignatureFieldTemplatesSettings.tsx`** — Delete this file.

- **`src/components/settings/TemplatesSettings.tsx`** — Remove the `signature_field_templates` query, delete mutation, and update mutation related to field templates (lines ~57-165). Remove any UI referencing field templates in this file.

---

## What stays untouched
- The core signature request system (edge functions, signing flow, database tables)
- The `FieldPlacementEditor` component (it queries field templates but won't break — it just returns empty results)
- Deposit operations console will keep working for non-Increase workflows
- All other integrations (Resend, Telnyx, QuickBooks, Outlook, Ramp)

