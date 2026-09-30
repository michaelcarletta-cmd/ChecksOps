# Classification (this recovery)

Read-only compiled compare of historical `index-QDJiUFF1.js` vs live `index-DSbVZXu8.js`.
**No production deploy. No Lambda write. Unknown checks not mutated.**

| Lost QDJi capability | Verdict | Candidate action |
|---|---|---|
| WalletOps `environmentReady` / wallet-first funding | **Regression** | Restore `9afb57fe` WalletOps files |
| Moov `Bank verified` / `Provider linked` / `Bank pending` | **Regression** | Restore `84ba11f4` StakeholderAccountSettings |
| `save-tenant-billing-account` + no-collection guard | **Regression** | Restore `84ba11f4` TenantBillingAccountPanel |
| ChecksOps billing / monthly_subscription / receivables | **Regression** | Restore WalletOps + admin billing panels from `84ba11f4`/`9afb57fe` |
| `groupDepositsBySubmissionDate` | **Regression** of accepted #581/#584 grouping | Restore `b97a8dc6` BankDepositReconciliation (Insured Name + submitted_at) |
| `tenant-logos` / branding save-without-subdomain | **Regression** of accepted #581 branding | Restore `b97a8dc6` branding files |

| DSb-only vs QDJi | Verdict | Candidate action |
|---|---|---|
| `save_claim_settlement_breakdown` | **Intentional later** (#582) | **Keep** from `82460c8c2` |
| `checksops-production-host` in index.html | **Intentional later** / already on QDJi HTML | **Keep** from `82460c8c2` |
| WalletOps payout-speed / Payment Account Setup | Pre-settings **main** WalletOps that reappeared | **Do not keep**; activity-recovery replaces it |
| DKIM / sending-subdomain / invoice letterhead upload | Pre-settings branding that #581 removed | **Do not keep**; restore #581/#584 branding |
| Deposit cleared_at fallback + bank-credit copy | Pre-settings grouping that #581 replaced | **Do not keep**; submitted_at grouping is intended |
| `tenantLogoUrl` / Insured Name | **Never in QDJi or DSb**; accepted #584 staging compose | **Add** from `b97a8dc6` |

Unchanged (must preserve): Delete Check, Signature Requests, OCR/MICR/payee/issue date, `new_stage` endorsing markers.

---

# QDJiUFF1 vs DSbVZXu8 — ChecksOps SPA Capability Comparison

Generated: 2026-09-30T22:52:16.106Z

Read-only comparison of historical production SPA `index-QDJiUFF1.js` vs live `index-DSbVZXu8.js`, including all Vite `__vite__mapDeps` chunks plus nested lazy chunks discovered in `WhiteLabelApp` and `CheckCommandCenter`.

## Artifacts

| Build | Entry | mapDeps chunks | JS files analyzed |
|-------|-------|----------------|-------------------|
| QDJi (historical) | `index-QDJiUFF1.js` | 72 | 75 |
| DSb (live) | `index-DSbVZXu8.js` | 71 | 74 |

### Nested lazy chunks (fetched from checksops.com)

| Feature | QDJi chunk | DSb chunk |
|---------|------------|----------|
| WalletOps page | `WalletOps-D5mOeN7Q.js` (65 KB) | `WalletOps-Dhje5XLB.js` (56 KB) |
| Bank deposit reconciliation | `BankDepositReconciliation-CNd9vt9D.js` | `BankDepositReconciliation-5yI_j5mi.js` |

> Note: Vite content-hashes differ on nearly every chunk between builds (68 QDJi-only, 67 DSb-only). Only **4** chunk basenames share the same prefix across builds; capability diff is by **marker/string presence**, not hash equality.

## Capabilities LOST (present in QDJi, absent in DSb)

| Family | Marker | QDJi hits | Files |
|--------|--------|-----------|-------|
| WalletOps | `environmentReady` | 3 | `WalletOps-D5mOeN7Q.js`(2), `index-QDJiUFF1.js`(1) |
| WalletOps | `Payment wallet environment is required` | 1 | `WalletOps-D5mOeN7Q.js`(1) |
| Moov/status | `Bank verified` | 1 | `index-QDJiUFF1.js`(1) |
| Moov/status | `Provider linked` | 1 | `index-QDJiUFF1.js`(1) |
| Moov/status | `Bank pending` | 1 | `index-QDJiUFF1.js`(1) |
| Branding | `save-tenant-billing-account` | 3 | `index-QDJiUFF1.js`(3) |
| Billing | `monthly_subscription` | 3 | `WalletOps-D5mOeN7Q.js`(3) |
| Billing | `ChecksOps billing` | 4 | `AdminTenants-DgEceeis.js`(2), `WalletOps-D5mOeN7Q.js`(2) |
| Billing | `Billing save unexpectedly` | 1 | `index-QDJiUFF1.js`(1) |
| Deposits | `groupDepositsBySubmissionDate` | 1 | `BankDepositReconciliation-CNd9vt9D.js`(1) |

### Interpretation (lost user-visible capabilities)

- **WalletOps environment readiness gate (production vs staging wallet selection)** (`environmentReady`)
- **WalletOps environment-required error UX** (`Payment wallet environment is required`)
- **Moov bank verification status badge ("Bank verified")** (`Bank verified`)
- **Moov provider linked status badge** (`Provider linked`)
- **Bank pending verification status** (`Bank pending`)
- **Save tenant billing account API (monthly billing persist)** (`save-tenant-billing-account`)
- **Monthly subscription billing type** (`monthly_subscription`)
- **ChecksOps billing UI section** (`ChecksOps billing`)
- **Billing persist guard (no collection on save)** (`Billing save unexpectedly`)
- **Group bank deposits by submission date (submitted_at)** (`groupDepositsBySubmissionDate`)

## Capabilities ADDED (present in DSb, absent in QDJi)

| Family | Marker | DSb hits | Files |
|--------|--------|----------|-------|
| Settlement | `save_claim_settlement_breakdown` | 1 | `live_entry.js`(1) |

### Interpretation (added user-visible capabilities)

- **Claim settlement breakdown save API intercept** (`save_claim_settlement_breakdown`)

## Marker count changes (both builds, different totals)

| Family | Marker | QDJi | DSb | Δ |
|--------|--------|------|-----|---|
| Moov/status | `Not verified` | 2 | 3 | +1 |
| Moov/status | `provider_account_id` | 15 | 13 | -2 |
| Moov/status | `Admin override` | 5 | 4 | -1 |
| Branding | `tenant-logos` | 12 | 3 | -9 |
| Branding | `company-branding` | 3 | 7 | +4 |
| Branding | `tenant-branding-for-email` | 3 | 1 | -2 |
| Deposits | `cleared_at` | 2 | 4 | +2 |
| Deposits | `submitted_at` | 22 | 21 | -1 |

## Full marker matrix

### WalletOps

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `environmentReady` | 3 | 0 | **LOST** |
| `selectPaymentWallet` | 0 | 0 | same |
| `readWallet` | 0 | 0 | same |
| `payment-wallet` | 2 | 2 | same |
| `Payment wallet environment is required` | 1 | 0 | **LOST** |

### Moov/status

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `Bank verified` | 1 | 0 | **LOST** |
| `Provider linked` | 1 | 0 | **LOST** |
| `Not verified` | 2 | 3 | changed |
| `Bank pending` | 1 | 0 | **LOST** |
| `provider_account_id` | 15 | 13 | changed |
| `Admin override` | 5 | 4 | changed |

### Branding

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `tenantLogoUrl` | 0 | 0 | same |
| `persistableLogoField` | 0 | 0 | same |
| `/prep/branding/logo` | 0 | 0 | same |
| `tenant-logos` | 12 | 3 | changed |
| `company-branding` | 3 | 7 | changed |
| `tenant-branding-for-email` | 3 | 1 | changed |
| `save-tenant-billing-account` | 3 | 0 | **LOST** |

### Billing

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `TenantBilling` | 0 | 0 | same |
| `TenantBillingAccountPanel` | 0 | 0 | same |
| `monthly billing` | 0 | 0 | same |
| `monthly_subscription` | 3 | 0 | **LOST** |
| `ChecksOps billing` | 4 | 0 | **LOST** |
| `Billing account linked` | 1 | 1 | same |
| `Billing save unexpectedly` | 1 | 0 | **LOST** |

### Deposits

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `Date unknown` | 1 | 1 | same |
| `groupDepositsBySubmissionDate` | 1 | 0 | **LOST** |
| `Insured Name` | 0 | 0 | same |
| `payee_line` | 44 | 44 | same |
| `bankDepositDayKey` | 1 | 1 | same |
| `cleared_at` | 2 | 4 | changed |
| `submitted_at` | 22 | 21 | changed |

### Settlement

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `save_claim_settlement_breakdown` | 0 | 1 | **ADDED** |

### Hostname

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `checksops-production-host` | 0 | 0 | same |

### Check ops

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `Delete check` | 0 | 0 | same |
| `delete check` | 3 | 3 | same |
| `Delete Check` | 1 | 1 | same |
| `delete_check` | 2 | 2 | same |
| `signature` | 159 | 159 | same |
| `OCR` | 10 | 10 | same |
| `MICR` | 1 | 1 | same |
| `payee` | 301 | 301 | same |
| `issue date` | 3 | 3 | same |

### Endorsing

| Marker | QDJi | DSb | Status |
|--------|------|-----|--------|
| `new_stage` | 3 | 3 | same |

## Markers absent in BOTH builds (never shipped in either artifact)

- `tenantLogoUrl`, `persistableLogoField`, `/prep/branding/logo` — branding logo helper from PR #584 not present in either compiled bundle (logo may still be served at CDN; UI uses `tenant-logos` / `company-branding` storage paths instead).
- `selectPaymentWallet`, `readWallet` — symbol names minified away; behavior inferred from WalletOps chunk strings.
- `TenantBilling`, `TenantBillingAccountPanel`, `monthly billing`, `Insured Name` — exact identifiers not in bundles; related UI strings differ (see string diff).
- `checksops-production-host` — injected in `index.html` shell (present in live HTML), not in JS entry.
- `Delete check` exact casing — 0 hits; `delete check` / `delete_check` present in **both** CheckCommandCenter chunks (unchanged).

## WalletOps chunk diff (major UX swap)

| Capability | QDJi (`WalletOps-D5mOeN7Q.js`) | DSb (`WalletOps-Dhje5XLB.js`) |
|------------|--------------------------------|--------------------------------|
| Environment readiness | `environmentReady` ×2 | **absent** |
| Wallet-first funding copy | "Wallet first, then connected bank for the remainder" | **absent** |
| Payment wallet env error | "Payment wallet environment is required." | **absent** |
| Payout speed UI | **absent** | "Default payout speed", "Save payout preference", "Open Payment Account" |
| Account setup modal | **absent** | "Payment Account Setup", "Checking your account status…" |

## Bank deposit chunk diff

| Capability | QDJi (`CNd9vt9D`) | DSb (`5yI_j5mi`) |
|------------|-------------------|-------------------|
| `groupDepositsBySubmissionDate` | **present** | **absent** |
| `Date unknown` label | present | present |
| `payee_line` / Payee column | present (×4) | present (×4) |
| `cleared_at` references | ×1 | ×3 (live groups by cleared date fallback) |
| Insured Name column | **absent in both** | **absent in both** |

## Entry-level Moov status labels (PaymentReadinessPanel area)

QDJi entry renders user-visible badges **"Bank verified"**, **"Provider linked"**, and **"Bank pending"** that DSb entry no longer contains. DSb retains **"Not verified"** (+1 occurrence).

## Branding / billing string diff highlights

### QDJi-only user-facing strings (capability-filtered, up to 200)

- " Admin override"
- " Bank pending"
- " Bank verified"
- ",deposit_account_number:n.deposit_account_number??"
- ". All bank accounts are added through the secure bank login in the Bank Account section — no manual entry. Saving authorization does not charge your account."
- ". Other tenants are never included."
- "A Moov account exists. This is not bank verification."
- "Automatic payouts"
- "Available wallet funds are used first. Any remainder is collected from "
- "Bank Withdrawal"
- "Bank not verified"
- "Bank provider transfer"
- "Billing account linked — auto-debit is on"
- "Billing save unexpectedly started a collection"
- "ChecksOps Billing"
- "ChecksOps billing"
- "ChecksOps billing history"
- "Connected bank for this organization"
- "Email brand color"
- "Funding & Billing"
- "Funding: Wallet "
- "Invoices use the same logo configured in Branding & Appearance. There is no separate invoice logo."
- "Last successful payment"
- "Monthly fees owed, attempted, and received for "
- "No logo configured. Add one above or in Branding & Appearance."
- "No logo configured. Add one in Branding & Appearance."
- "No tenant-fee receivables for this filter."
- "PARTIALLY PAID / BANK FAILED"
- "Payment wallet environment is required."
- "Primary funding account"
- "Provider linked"
- "Tenant attribution comes from the ChecksOps billing operation that created the transfer — not bank name or last4. Pending or originated ACH is not treated as received."
- "Tenant payments / receivables"
- "This is the tenant logo from Branding & Appearance."
- "Wallet first, then connected bank for the remainder"
- "Wallet provider transfer"
- "You can view branding. Only tenant administrators or platform administrators can save changes."
- "ambiguous_wallet"
- "id, tenant_id, amount_cents, status, notes, created_at, period_start, period_end, submitted_at"
- "id, tenant_id, provider_payment_method_id, last_four, bank_name, rail_payment_method_ids, is_default, connection_status"
- "id, tenant_id, wallet_type, environment"
- "id, tenant_id, wallet_type, environment, provider_payment_method_id, provider_wallet_id, provider_metadata"
- "monthly_subscription"
- "moov-transfer-status"
- "name, business_address, business_phone, email_reply_to, logo_url, invoice_letterhead_url, invoice_footer_note, invoice_default_terms, invoice_accent_color, invoice_theme, primary_color"
- "payment-wallet"
- "payment_provider_methods"
- "save-tenant-billing-account"
- "tenant-billing-account"
- "tenant-branding-for-email"
- "tenant_maintenance_payments"

### DSb-only user-facing strings (capability-filtered, up to 200)

- " Settled into your bank"
- ",deposit_account_number:r.deposit_account_number??"
- ". All bank accounts are added through the secure bank login in the Bank Account section — no manual entry."
- "Checking your account status…"
- "Choose a speed"
- "Click to upload invoice letterhead"
- "Customize the visual presentation and default terms of your customer-facing invoices."
- "DKIM DNS records"
- "Default payout speed"
- "Each row below is one bank credit. Expand a day to see exactly which checks make up that amount. Daily total equals the sum of the checks shown."
- "No deposits found yet."
- "Only administrators can change payout preferences."
- "Open Payment Account"
- "Payment Account Setup"
- "Save payout preference"
- "Settlement bank "
- "Still pending. DNS changes may take minutes to 48 hours."
- "Verify a subdomain such as notify.yourcompany.com. Do not use your inbound MX hostname."
- "You can view branding. Only tenant administrators or platform administrators can change the sending domain."
- "id, amount_cents, status, speed, selected_rail, description, created_at, completed_at, leg_role, is_facilitator_fee"
- "invoice-letterhead-upload"
- "invoice_letterhead_url, invoice_footer_note, invoice_default_terms, invoice_accent_color, invoice_theme, primary_color"
- "noreply@checksops.com"
- "walletops-rail"

## Executive summary

### Top capabilities LOST (QDJi → DSb)

1. WalletOps environment readiness gate (`environmentReady` in entry + WalletOps chunk)
2. Moov status badges: "Bank verified", "Provider linked", "Bank pending" (entry bundle)
3. Wallet-first funding UX ("Wallet first, then connected bank for the remainder", payment-wallet env guard)
4. Monthly billing persist API (`save-tenant-billing-account`) and billing guard strings
5. Deposit grouping by submission date (`groupDepositsBySubmissionDate` in BankDeposit chunk)
6. Legacy tenant-logos branding upload path dominance (10 vs 1 refs in entry)

### Top capabilities ADDED (DSb vs QDJi)

1. Claim settlement breakdown save (`save_claim_settlement_breakdown` in entry — settlement workstream)
2. WalletOps payout-speed / Payment Account Setup UI (replaces activity-recovery wallet chunk)
3. Expanded company-branding storage usage (7 vs 3 refs) + invoice letterhead upload UI
4. DKIM / sending-subdomain DNS guidance ("DKIM DNS records", "Verify a subdomain…")
5. Deposit reconciliation copy ("Each row below is one bank credit…", "No deposits found yet.")
6. Settlement status copy ("Settled into your bank")

### Unchanged between builds

- Delete check (`delete check` / `delete_check`), signature, OCR, MICR, payee, issue date, `new_stage` endorsing markers — counts match across CheckCommandCenter chunks.
- Both builds still show **Payee** (not Insured Name) in bank deposit reconciliation.
- Neither build contains `tenantLogoUrl` / PR #584 persistable-logo helper symbols.
