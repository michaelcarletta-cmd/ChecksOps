# Interactive UI Controls Inventory — ChecksOps

Columns: **ID | Screen | Control label/name | Element type | File | Approx line | Notes**

Labels taken from JSX text, `<Label>`, `aria-label`, `title`, or `placeholder`. Select options listed in Notes. `.map()` radio groups = one row with all option labels. No invented labels.

## 1. Admin Tenants + admin/* (platform finance, referrals, announcements, manage tenant)

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| A1-001 | AdminTenants | Back to Login | Button | `src/pages/admin/AdminTenants.tsx` | 141 |  |
| A1-002 | AdminTenants | Back | Button | `src/pages/admin/AdminTenants.tsx` | 163 |  |
| A1-003 | AdminTenants | Home | Button | `src/pages/admin/AdminTenants.tsx` | 166 |  |
| A1-004 | AdminTenants | Mortgage Ops | Button | `src/pages/admin/AdminTenants.tsx` | 171 |  |
| A1-005 | AdminTenants | Financial Model | Button | `src/pages/admin/AdminTenants.tsx` | 174 |  |
| A1-006 | AdminTenants | Refresh | Button | `src/pages/admin/AdminTenants.tsx` | 177 |  |
| A1-007 | AdminTenants | New Tenant | Button | `src/pages/admin/AdminTenants.tsx` | 182 |  |
| A1-008 | AdminTenants | Log Out | Button | `src/pages/admin/AdminTenants.tsx` | 186 |  |
| A1-009 | AdminTenants | Tenants | Tab | `src/pages/admin/AdminTenants.tsx` | 209 |  |
| A1-010 | AdminTenants | Platform Finance | Tab | `src/pages/admin/AdminTenants.tsx` | 210 |  |
| A1-011 | AdminTenants | Referral Dashboard | Tab | `src/pages/admin/AdminTenants.tsx` | 211 |  |
| A1-012 | AdminTenants | Announcements | Tab | `src/pages/admin/AdminTenants.tsx` | 212 |  |
| A1-013 | AdminTenants | Banking | Tab | `src/pages/admin/AdminTenants.tsx` | 231 |  |
| A1-014 | AdminTenants | Wallet & P&L | Tab | `src/pages/admin/AdminTenants.tsx` | 232 |  |
| A1-015 | AdminTenants | Company Name | Input | `src/pages/admin/AdminTenants.tsx` | 297 | placeholder: Acme Inspections |
| A1-016 | AdminTenants | Slug (URL identifier) | Input | `src/pages/admin/AdminTenants.tsx` | 301 | placeholder: acme-inspections |
| A1-017 | AdminTenants | Create Tenant | Button | `src/pages/admin/AdminTenants.tsx` | 306 |  |
| A1-018 | AdminTenants | All Tenants | Button | `src/pages/admin/AdminTenants.tsx` | 324 |  |
| A1-019 | AdminTenants | Company | Tab | `src/pages/admin/AdminTenants.tsx` | 344 |  |
| A1-020 | AdminTenants | Branding & Email | Tab | `src/pages/admin/AdminTenants.tsx` | 345 |  |
| A1-021 | AdminTenants | Compliance & Docs | Tab | `src/pages/admin/AdminTenants.tsx` | 346 |  |
| A1-022 | AdminTenants | Integrations | Tab | `src/pages/admin/AdminTenants.tsx` | 347 |  |
| A1-023 | AdminTenants | Billing & Usage | Tab | `src/pages/admin/AdminTenants.tsx` | 349 |  |
| A1-024 | AdminTenants | OPS Badge | Tab | `src/pages/admin/AdminTenants.tsx` | 350 |  |
| A1-025 | AdminTenants | Users | Tab | `src/pages/admin/AdminTenants.tsx` | 351 |  |
| A1-026 | AdminTenants | Manage OPS Badge | Button | `src/pages/admin/AdminTenants.tsx` | 380 |  |
| A1-027 | AdminTenants | Company Name | Input | `src/pages/admin/AdminTenants.tsx` | 446 |  |
| A1-028 | AdminTenants | Slug | Input | `src/pages/admin/AdminTenants.tsx` | 447 |  |
| A1-029 | AdminTenants | Custom Domain | Input | `src/pages/admin/AdminTenants.tsx` | 451 | placeholder: checks.acme.com |
| A1-030 | AdminTenants | Subscription Status | Select | `src/pages/admin/AdminTenants.tsx` | 458 | options: active, trialing, past_due, inactive, cancelled |
| A1-031 | AdminTenants | Max Checks / Month | Input(number) | `src/pages/admin/AdminTenants.tsx` | 468 |  |
| A1-032 | AdminTenants | Test Account | Switch | `src/pages/admin/AdminTenants.tsx` | 478 |  |
| A1-033 | AdminTenants | Partner Code | Input | `src/pages/admin/AdminTenants.tsx` | 484 |  |
| A1-034 | AdminTenants | Partner Code | Button | `src/pages/admin/AdminTenants.tsx` | 485 |  |
| A1-035 | AdminTenants | Save Changes | Button | `src/pages/admin/AdminTenants.tsx` | 491 |  |
| A1-036 | AdminTenants | Logo | Input(file) | `src/pages/admin/AdminTenants.tsx` | 543 |  |
| A1-037 | AdminTenants | Replace | Button | `src/pages/admin/AdminTenants.tsx` | 557 |  |
| A1-038 | AdminTenants | (icon/unlabeled Button) | Button | `src/pages/admin/AdminTenants.tsx` | 560 |  |
| A1-039 | AdminTenants | (icon/unlabeled Button) | Button | `src/pages/admin/AdminTenants.tsx` | 566 |  |
| A1-040 | AdminTenants | ...or paste a URL | Input | `src/pages/admin/AdminTenants.tsx` | 582 |  |
| A1-041 | AdminTenants | Primary Color | Input(color) | `src/pages/admin/AdminTenants.tsx` | 588 |  |
| A1-042 | AdminTenants | Primary Color | Input | `src/pages/admin/AdminTenants.tsx` | 589 |  |
| A1-043 | AdminTenants | Secondary Color | Input(color) | `src/pages/admin/AdminTenants.tsx` | 595 |  |
| A1-044 | AdminTenants | Secondary Color | Input | `src/pages/admin/AdminTenants.tsx` | 596 |  |
| A1-045 | AdminTenants | Save Branding | Button | `src/pages/admin/AdminTenants.tsx` | 600 |  |
| A1-046 | AdminTenants | Full name (optional) | Input | `src/pages/admin/AdminTenants.tsx` | 706 |  |
| A1-047 | AdminTenants | user@example.com | Input | `src/pages/admin/AdminTenants.tsx` | 709 |  |
| A1-048 | AdminTenants | (Select) | Select | `src/pages/admin/AdminTenants.tsx` | 711 |  |
| A1-049 | AdminTenants | Invite | Button | `src/pages/admin/AdminTenants.tsx` | 714 |  |
| A1-050 | AdminTenants | (Select) | Select | `src/pages/admin/AdminTenants.tsx` | 739 |  |
| A1-051 | AdminTenants | Resend reset email | Button | `src/pages/admin/AdminTenants.tsx` | 743 |  |
| A1-052 | AdminTenants | (icon/unlabeled Button) | Button | `src/pages/admin/AdminTenants.tsx` | 747 |  |
| A1-053 | AdminTenants | Enable Per-Check Billing | Switch | `src/pages/admin/AdminTenants.tsx` | 778 |  |
| A1-054 | AdminTenants | Standard Check Rate (cents) | Input(number) | `src/pages/admin/AdminTenants.tsx` | 784 |  |
| A1-055 | AdminTenants | Next Day Credit | Input | `src/pages/admin/AdminTenants.tsx` | 805 |  |
| A1-056 | AdminTenants | Same Day Credit | Input | `src/pages/admin/AdminTenants.tsx` | 809 |  |
| A1-057 | AdminTenants | Save Billing Settings | Button | `src/pages/admin/AdminTenants.tsx` | 815 |  |
| A1-058 | AdminTenants | Pull maintenance fee now | Button | `src/pages/admin/AdminTenants.tsx` | 935 |  |
| A1-059 | AdminTenants | Link for billing | Button | `src/pages/admin/AdminTenants.tsx` | 965 |  |
| A1-060 | AdminTenants | (Select) | Select | `src/pages/admin/AdminTenants.tsx` | 1144 | options: Month, Year |
| A1-061 | AdminTenants | (Select) | Select | `src/pages/admin/AdminTenants.tsx` | 1152 |  |
| A1-062 | AdminTenants | (Select) | Select | `src/pages/admin/AdminTenants.tsx` | 1159 |  |
| A1-063 | AdminTenants | (icon/unlabeled Button) | Button | `src/pages/admin/AdminTenants.tsx` | 1164 |  |
| A1-064 | AdminTenants | Pull & email invoice | Button | `src/pages/admin/AdminTenants.tsx` | 1209 |  |
| A1-065 | AdminTenants | (icon/unlabeled Button) | Button | `src/pages/admin/AdminTenants.tsx` | 1419 |  |
| A1-066 | AdminTenants | (unlabeled switch) | Switch | `src/pages/admin/AdminTenants.tsx` | 1466 |  |
| A1-067 | AdminTenants | (unlabeled switch) | Switch | `src/pages/admin/AdminTenants.tsx` | 1480 |  |
| A1-068 | AdminTenants | (unlabeled switch) | Switch | `src/pages/admin/AdminTenants.tsx` | 1494 |  |
| A1-069 | AdminTenants | (Select) | Select | `src/pages/admin/AdminTenants.tsx` | 1554 | options: Pending, Approved, Rejected |
| A1-070 | AdminTenants | Actions | Button | `src/pages/admin/AdminTenants.tsx` | 1576 |  |
| A1-071 | AdminTenants | Preview portal | MenuItem | `src/pages/admin/AdminTenants.tsx` | 1581 |  |
| A1-072 | AdminTenants | Notes | MenuItem | `src/pages/admin/AdminTenants.tsx` | 1596 |  |
| A1-073 | AdminTenants | OPS Badge | MenuItem | `src/pages/admin/AdminTenants.tsx` | 1599 |  |
| A1-074 | AdminTenants | Manage tenant | MenuItem | `src/pages/admin/AdminTenants.tsx` | 1602 |  |
| A1-075 | AdminTenants | {valueCents == null ? "Set rate" : `$$ `} | Button | `src/pages/admin/AdminTenants.tsx` | 1686 |  |
| A1-076 | AdminTenants | (unlabeled input) | Input(number) | `src/pages/admin/AdminTenants.tsx` | 1697 |  |
| A1-077 | AdminTenants | Internal Notes | Textarea | `src/pages/admin/AdminTenants.tsx` | 1758 | placeholder: Anything to remember about this tenant — billing exceptions, contacts, history… |
| A1-078 | AdminTenants | KYC Notes | Textarea | `src/pages/admin/AdminTenants.tsx` | 1767 | placeholder: What was verified, when, and by whom (EIN, business address, beneficial owner ID, etc.) |
| A1-079 | AdminTenants | Cancel | Button | `src/pages/admin/AdminTenants.tsx` | 1776 |  |
| A1-080 | AdminTenants | Save Notes | Button | `src/pages/admin/AdminTenants.tsx` | 1777 |  |
| A1-081 | PlatformBankPanel | (icon/unlabeled Button) | Button | `src/components/admin/PlatformBankPanel.tsx` | 188 |  |
| A1-082 | PlatformBankPanel | (icon/unlabeled Button) | Button | `src/components/admin/PlatformBankPanel.tsx` | 204 |  |
| A1-083 | PlatformBankPanel | Add bank | Button | `src/components/admin/PlatformBankPanel.tsx` | 264 |  |
| A1-084 | PlatformBankPanel | Enter code / Verify | Button | `src/components/admin/PlatformBankPanel.tsx` | 299 |  |
| A1-085 | PlatformBankPanel | 4-digit code from the $0.01 deposit (MV####) | Input | `src/components/admin/PlatformBankPanel.tsx` | 320 | placeholder: 0000 |
| A1-086 | PlatformBankPanel | Confirm | Button | `src/components/admin/PlatformBankPanel.tsx` | 329 |  |
| A1-087 | PlatformBankPanel | Resend deposit | Button | `src/components/admin/PlatformBankPanel.tsx` | 337 |  |
| A1-088 | PlatformBankPanel | Cancel | Button | `src/components/admin/PlatformBankPanel.tsx` | 345 |  |
| A1-089 | PlatformBankPanel | Account holder name | Input | `src/components/admin/PlatformBankPanel.tsx` | 441 | placeholder: Exactly as it appears at the bank |
| A1-090 | PlatformBankPanel | Holder type | Select | `src/components/admin/PlatformBankPanel.tsx` | 453 | options: Business, Individual, Checking, Savings |
| A1-091 | PlatformBankPanel | Account type | Select | `src/components/admin/PlatformBankPanel.tsx` | 464 | options: Checking, Savings |
| A1-092 | PlatformBankPanel | Routing number | Input | `src/components/admin/PlatformBankPanel.tsx` | 474 | placeholder: 9 digits |
| A1-093 | PlatformBankPanel | Account number | Input | `src/components/admin/PlatformBankPanel.tsx` | 486 | placeholder: 4–17 digits |
| A1-094 | PlatformBankPanel | Cancel | Button | `src/components/admin/PlatformBankPanel.tsx` | 498 |  |
| A1-095 | PlatformBankPanel | Connect bank | Button | `src/components/admin/PlatformBankPanel.tsx` | 501 |  |
| — | TenantMoovIdentityCard | *(none in this file)* | — | `src/components/admin/TenantMoovIdentityCard.tsx` | — | Display-only or composes children listed elsewhere |
| A1-096 | AdminStakeholderLimitRequests | Pending | Tab | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 116 |  |
| A1-097 | AdminStakeholderLimitRequests | Reviewed | Tab | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 117 |  |
| A1-098 | AdminStakeholderLimitRequests | Approve | Button | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 151 |  |
| A1-099 | AdminStakeholderLimitRequests | Deny | Button | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 154 |  |
| A1-100 | AdminStakeholderLimitRequests | (unlabeled input) | Input(number) | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 198 |  |
| A1-101 | AdminStakeholderLimitRequests | (unlabeled textarea) | Textarea | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 204 |  |
| A1-102 | AdminStakeholderLimitRequests | Cancel | Button | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 209 |  |
| A1-103 | AdminStakeholderLimitRequests | Confirm | Button | `src/components/admin/AdminStakeholderLimitRequests.tsx` | 210 |  |
| A1-104 | PlatformTreasuryPanel | Refresh | Button | `src/components/admin/PlatformTreasuryPanel.tsx` | 120 |  |
| A1-105 | PlatformAnnouncementsManager | Title | Input | `src/components/admin/PlatformAnnouncementsManager.tsx` | 97 |  |
| A1-106 | PlatformAnnouncementsManager | Message | Textarea | `src/components/admin/PlatformAnnouncementsManager.tsx` | 101 |  |
| A1-107 | PlatformAnnouncementsManager | Severity | Select | `src/components/admin/PlatformAnnouncementsManager.tsx` | 106 | options: Info, Scheduled maintenance, Critical (cannot be dismissed) |
| A1-108 | PlatformAnnouncementsManager | Banner auto-hides at (optional) | Input(datetime-local) | `src/components/admin/PlatformAnnouncementsManager.tsx` | 116 |  |
| A1-109 | PlatformAnnouncementsManager | Maintenance window start | Input(datetime-local) | `src/components/admin/PlatformAnnouncementsManager.tsx` | 120 |  |
| A1-110 | PlatformAnnouncementsManager | Maintenance window end | Input(datetime-local) | `src/components/admin/PlatformAnnouncementsManager.tsx` | 124 |  |
| A1-111 | PlatformAnnouncementsManager | Refresh instructions | Textarea | `src/components/admin/PlatformAnnouncementsManager.tsx` | 128 |  |
| A1-112 | PlatformAnnouncementsManager | Publish announcement | Button | `src/components/admin/PlatformAnnouncementsManager.tsx` | 132 |  |
| A1-113 | PlatformAnnouncementsManager | (unlabeled switch) | Switch | `src/components/admin/PlatformAnnouncementsManager.tsx` | 169 |  |
| A1-114 | PlatformAnnouncementsManager | (icon/unlabeled Button) | Button | `src/components/admin/PlatformAnnouncementsManager.tsx` | 170 |  |
| A1-115 | AdminReferralDashboard | Export CSV | Button | `src/components/settings/AdminReferralDashboard.tsx` | 108 |  |
| A1-116 | AdminReferralDashboard | Search by company or code... | Input | `src/components/settings/AdminReferralDashboard.tsx` | 170 |  |

**Area 1 count: 116**

## 2. AdminFinancialModel (+ PnlModel / SavingsCalculator)

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| A2-001 | AdminFinancialModel | Back to Login | Button | `src/pages/admin/AdminFinancialModel.tsx` | 54 |  |
| A2-002 | AdminFinancialModel | Back | Button | `src/pages/admin/AdminFinancialModel.tsx` | 65 |  |
| A2-003 | AdminFinancialModel | Home | Button | `src/pages/admin/AdminFinancialModel.tsx` | 68 |  |
| A2-004 | AdminFinancialModel | Tenants | Button | `src/pages/admin/AdminFinancialModel.tsx` | 71 |  |
| A2-005 | AdminFinancialModel | Presentation mode | Switch | `src/pages/admin/AdminFinancialModel.tsx` | 83 |  |
| A2-006 | AdminFinancialModel | Print | Button | `src/pages/admin/AdminFinancialModel.tsx` | 86 |  |
| A2-007 | AdminFinancialModel | P&L Model | Tab | `src/pages/admin/AdminFinancialModel.tsx` | 95 |  |
| A2-008 | AdminFinancialModel | Client Savings | Tab | `src/pages/admin/AdminFinancialModel.tsx` | 98 |  |
| A2-009 | PnlModel | (icon/unlabeled Button) | Button | `src/components/financial/PnlModel.tsx` | 160 |  |
| A2-010 | PnlModel | Reset | Button | `src/components/financial/PnlModel.tsx` | 171 |  |
| A2-011 | PnlModel | Export CSV | Button | `src/components/financial/PnlModel.tsx` | 174 |  |
| A2-012 | PnlModel | Net new tenants per month | Slider | `src/components/financial/PnlModel.tsx` | 503 |  |
| A2-013 | SavingsCalculator | Reset | Button | `src/components/financial/SavingsCalculator.tsx` | 222 |  |
| A2-014 | SavingsCalculator | Export CSV | Button | `src/components/financial/SavingsCalculator.tsx` | 225 |  |
| A2-015 | SavingsCalculator | Uses mortgage / loss-draft services | Switch | `src/components/financial/SavingsCalculator.tsx` | 281 |  |
| A2-016 | SavingsCalculator | Annual term — % off subscription | Switch | `src/components/financial/SavingsCalculator.tsx` | 385 |  |
| A2-017 | NumberField | {hint && ( )} | Input(number) | `src/components/financial/NumberField.tsx` | 38 |  |
| A2-018 | PricingOptimizer | Reset scenarios | Button | `src/components/financial/PricingOptimizer.tsx` | 181 |  |
| A2-019 | PricingOptimizer | Export optimization CSV | Button | `src/components/financial/PricingOptimizer.tsx` | 184 |  |
| A2-020 | PricingOptimizer | Scenario name | Input | `src/components/financial/PricingOptimizer.tsx` | 196 |  |

**Area 2 count: 20**

## 3. AdminMortgageOps

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| A3-001 | AdminMortgageOps | Back | Button | `src/pages/admin/AdminMortgageOps.tsx` | 190 |  |
| A3-002 | AdminMortgageOps | Home | Button | `src/pages/admin/AdminMortgageOps.tsx` | 193 |  |
| A3-003 | AdminMortgageOps | Refresh | Button | `src/pages/admin/AdminMortgageOps.tsx` | 204 |  |
| A3-004 | AdminMortgageOps | Hire Agent | Button | `src/pages/admin/AdminMortgageOps.tsx` | 209 |  |
| A3-005 | AdminMortgageOps | Manage | Button | `src/pages/admin/AdminMortgageOps.tsx` | 272 |  |
| A3-006 | AdminMortgageOps | Send password reset email | Button | `src/pages/admin/AdminMortgageOps.tsx` | 273 |  |
| A3-007 | AdminMortgageOps | (icon: Trash2 remove agent) | Button | `src/pages/admin/AdminMortgageOps.tsx` | 281 | Icon-only; no aria-label |
| A3-008 | AdminMortgageOps | Unassign | Button | `src/pages/admin/AdminMortgageOps.tsx` | 333 |  |
| A3-009 | AdminMortgageOps | Revoke Access | Button | `src/pages/admin/AdminMortgageOps.tsx` | 345 |  |
| A3-010 | AdminMortgageOps | Close | Button | `src/pages/admin/AdminMortgageOps.tsx` | 348 |  |
| A3-011 | AdminMortgageOps | Copy credentials | Button | `src/pages/admin/AdminMortgageOps.tsx` | 422 |  |
| A3-012 | AdminMortgageOps | Done | Button | `src/pages/admin/AdminMortgageOps.tsx` | 432 |  |
| A3-013 | AdminMortgageOps | Full name | Input | `src/pages/admin/AdminMortgageOps.tsx` | 440 | placeholder: Jane Smith |
| A3-014 | AdminMortgageOps | Email | Input(email) | `src/pages/admin/AdminMortgageOps.tsx` | 450 | placeholder: agent@example.com |
| A3-015 | AdminMortgageOps | Temporary password (optional) | Input(text) | `src/pages/admin/AdminMortgageOps.tsx` | 460 | placeholder: Leave blank to auto-generate |
| A3-016 | AdminMortgageOps | Hire Agent | Button | `src/pages/admin/AdminMortgageOps.tsx` | 473 |  |

**Area 3 count: 16**

## 4. Tenant settings

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| A4-001 | AuditLogSettings | Refresh | Button | `src/components/settings/AuditLogSettings.tsx` | 155 |  |
| A4-002 | AuditLogSettings | Export CSV | Button | `src/components/settings/AuditLogSettings.tsx` | 164 |  |
| A4-003 | AuditLogSettings | Search logs... | Input | `src/components/settings/AuditLogSettings.tsx` | 180 |  |
| A4-004 | AuditLogSettings | (Select) | Select | `src/components/settings/AuditLogSettings.tsx` | 188 | options: all / All Actions, all / All Types |
| A4-005 | AuditLogSettings | (Select) | Select | `src/components/settings/AuditLogSettings.tsx` | 200 | options: all / All Types |
| A4-006 | ChangePasswordCard | Forgot password | Link | `src/components/settings/ChangePasswordCard.tsx` | 29 | → /forgot-password |
| A4-007 | ChangePasswordCard | Current Password | Input | `src/components/settings/ChangePasswordCard.tsx` | 87 | placeholder: Enter current password |
| A4-008 | ChangePasswordCard | Current Password | Button | `src/components/settings/ChangePasswordCard.tsx` | 95 |  |
| A4-009 | ChangePasswordCard | New Password | Input | `src/components/settings/ChangePasswordCard.tsx` | 112 | placeholder: At least 8 characters |
| A4-010 | ChangePasswordCard | New Password | Button | `src/components/settings/ChangePasswordCard.tsx` | 120 |  |
| A4-011 | ChangePasswordCard | Confirm New Password | Input | `src/components/settings/ChangePasswordCard.tsx` | 134 | placeholder: Re-enter new password |
| A4-012 | ChangePasswordCard | Updating... / Update Password | Button | `src/components/settings/ChangePasswordCard.tsx` | 150 |  |
| A4-013 | CheckAltSettings | Base URL | Input | `src/components/settings/CheckAltSettings.tsx` | 328 | placeholder: https://uatapi.checkalt.com |
| A4-014 | CheckAltSettings | Merchant | Input | `src/components/settings/CheckAltSettings.tsx` | 340 | placeholder: e.g. lockbox5 |
| A4-015 | CheckAltSettings | FI Key | Input | `src/components/settings/CheckAltSettings.tsx` | 352 | placeholder: e.g. 40E28855-35FA-45C3-... |
| A4-016 | CheckAltSettings | Business Unit | Input | `src/components/settings/CheckAltSettings.tsx` | 364 | placeholder: e.g. CHECKSOPS_PROD |
| A4-017 | CheckAltSettings | Deposit Account Number | Input | `src/components/settings/CheckAltSettings.tsx` | 373 | placeholder: Bank account number for deposits |
| A4-018 | CheckAltSettings | Deposit Account Number | Switch | `src/components/settings/CheckAltSettings.tsx` | 386 |  |
| A4-019 | CheckAltSettings | Enable CheckAlt deposits | Switch | `src/components/settings/CheckAltSettings.tsx` | 404 |  |
| A4-020 | CheckAltSettings | Auto-approve ceiling (USD, optional) | Input(number) | `src/components/settings/CheckAltSettings.tsx` | 426 | placeholder: e.g. 10000 — leave blank for no limit |
| A4-021 | CheckAltSettings | Internal notes | Textarea | `src/components/settings/CheckAltSettings.tsx` | 447 | placeholder: Any internal context (account contact, rollout plan, etc.) |
| A4-022 | CheckAltSettings | Test connection | Button | `src/components/settings/CheckAltSettings.tsx` | 457 |  |
| A4-023 | CheckAltSettings | Reconcile pending deposits | Button | `src/components/settings/CheckAltSettings.tsx` | 468 |  |
| A4-024 | CheckAltSettings | Save settings | Button | `src/components/settings/CheckAltSettings.tsx` | 478 |  |
| A4-025 | CheckAltSettings | User ID (ssoKey) | Input | `src/components/settings/CheckAltSettings.tsx` | 519 | placeholder: e.g. mcarletta |
| A4-026 | CheckAltSettings | Email address | Input(email) | `src/components/settings/CheckAltSettings.tsx` | 531 | placeholder: user@company.com |
| A4-027 | CheckAltSettings | First name | Input | `src/components/settings/CheckAltSettings.tsx` | 541 |  |
| A4-028 | CheckAltSettings | Last name | Input | `src/components/settings/CheckAltSettings.tsx` | 549 |  |
| A4-029 | CheckAltSettings | Deposit account number | Input | `src/components/settings/CheckAltSettings.tsx` | 557 | placeholder: Bank account number |
| A4-030 | CheckAltSettings | Verify user | Button | `src/components/settings/CheckAltSettings.tsx` | 590 |  |
| A4-031 | CheckAltSettings | Re-register account / Register account | Button | `src/components/settings/CheckAltSettings.tsx` | 600 |  |
| A4-032 | CheckAltSettings | Poll Now | Button | `src/components/settings/CheckAltSettings.tsx` | 801 |  |
| A4-033 | CheckAltSettings | Refresh | Button | `src/components/settings/CheckAltSettings.tsx` | 807 |  |
| A4-034 | CheckAltSettings | Poll Now | Button | `src/components/settings/CheckAltSettings.tsx` | 818 |  |
| A4-035 | CheckAltSettings | Reject | Button | `src/components/settings/CheckAltSettings.tsx` | 863 |  |
| A4-036 | CheckAltSettings | Approve | Button | `src/components/settings/CheckAltSettings.tsx` | 871 |  |
| A4-037 | CheckAltSettings | Reject reason (optional) | Input | `src/components/settings/CheckAltSettings.tsx` | 894 | placeholder: Notes shown to CheckAlt |
| A4-038 | CheckAltSettings | Cancel | Button | `src/components/settings/CheckAltSettings.tsx` | 901 |  |
| A4-039 | CheckAltSettings | Confirm reject | Button | `src/components/settings/CheckAltSettings.tsx` | 912 |  |
| A4-040 | CheckAltSettings | Start date | Input(date) | `src/components/settings/CheckAltSettings.tsx` | 1043 |  |
| A4-041 | CheckAltSettings | End date | Input(date) | `src/components/settings/CheckAltSettings.tsx` | 1052 |  |
| A4-042 | CheckAltSettings | Refresh | Button | `src/components/settings/CheckAltSettings.tsx` | 1059 |  |
| A4-043 | CompanyBrandingSettings | Company Name | Input | `src/components/settings/CompanyBrandingSettings.tsx` | 242 | placeholder: Freedom Claims Adjusting |
| A4-044 | CompanyBrandingSettings | Address | Textarea | `src/components/settings/CompanyBrandingSettings.tsx` | 251 | placeholder: 123 Main Street&#10;Suite 100&#10;Philadelphia, PA 19103 |
| A4-045 | CompanyBrandingSettings | Phone | Input | `src/components/settings/CompanyBrandingSettings.tsx` | 262 | placeholder: (555) 123-4567 |
| A4-046 | CompanyBrandingSettings | Email | Input | `src/components/settings/CompanyBrandingSettings.tsx` | 270 | placeholder: claims@freedomclaims.com |
| A4-047 | CompanyBrandingSettings | Uploading... / Click to upload square or horizontal logo | Input(file) | `src/components/settings/CompanyBrandingSettings.tsx` | 311 |  |
| A4-048 | CompanyBrandingSettings | Uploading... / Click to upload wide letterhead image | Input(file) | `src/components/settings/CompanyBrandingSettings.tsx` | 346 |  |
| A4-049 | CompanyBrandingSettings | (unlabeled input) | Input(file) | `src/components/settings/CompanyBrandingSettings.tsx` | 384 |  |
| A4-050 | CompanyBrandingSettings | Invoice Footer Note | Textarea | `src/components/settings/CompanyBrandingSettings.tsx` | 397 | placeholder: Thank you for your business! |
| A4-051 | CompanyBrandingSettings | Default Payment Terms | Textarea | `src/components/settings/CompanyBrandingSettings.tsx` | 408 | placeholder: Payment is due within 30 days. Please make checks payable to... |
| A4-052 | CompanyBrandingSettings | Invoice Accent Color | Input(color) | `src/components/settings/CompanyBrandingSettings.tsx` | 421 |  |
| A4-053 | CompanyBrandingSettings | Invoice Accent Color | Input | `src/components/settings/CompanyBrandingSettings.tsx` | 428 | placeholder: #3B82F6 |
| A4-054 | CompanyBrandingSettings | Invoice Theme | Button | `src/components/settings/CompanyBrandingSettings.tsx` | 444 |  |
| A4-055 | CompanyBrandingSettings | Saving... / Save Company Settings | Button | `src/components/settings/CompanyBrandingSettings.tsx` | 474 |  |
| A4-056 | ComplianceSettings | Save KYC | Button | `src/components/settings/ComplianceSettings.tsx` | 242 |  |
| A4-057 | ComplianceSettings | (unlabeled input) | Input | `src/components/settings/ComplianceSettings.tsx` | 296 |  |
| A4-058 | EmailSenderSettings | From display name | Input | `src/components/settings/EmailSenderSettings.tsx` | 365 |  |
| A4-059 | EmailSenderSettings | Reply-To address | Input(email) | `src/components/settings/EmailSenderSettings.tsx` | 376 | placeholder: claims@yourcompany.com |
| A4-060 | EmailSenderSettings | Save branding | Button | `src/components/settings/EmailSenderSettings.tsx` | 392 |  |
| A4-061 | EmailSenderSettings | Sending subdomain | Input | `src/components/settings/EmailSenderSettings.tsx` | 420 | placeholder: notify.yourcompany.com |
| A4-062 | EmailSenderSettings | From local part | Input | `src/components/settings/EmailSenderSettings.tsx` | 431 | placeholder: noreply |
| A4-063 | EmailSenderSettings | Start domain verification | Button | `src/components/settings/EmailSenderSettings.tsx` | 446 |  |
| A4-064 | EmailSenderSettings | Check verification | Button | `src/components/settings/EmailSenderSettings.tsx` | 455 |  |
| A4-065 | EmailSenderSettings | Disable custom sending | Button | `src/components/settings/EmailSenderSettings.tsx` | 469 |  |
| A4-066 | EmailSenderSettings | (icon/unlabeled Button) | Button | `src/components/settings/EmailSenderSettings.tsx` | 530 |  |
| A4-067 | EmailSenderSettings | (icon/unlabeled Button) | Button | `src/components/settings/EmailSenderSettings.tsx` | 538 |  |
| — | GLBASecurityEventsLog | *(none in this file)* | — | `src/components/settings/GLBASecurityEventsLog.tsx` | — | Display-only or composes children listed elsewhere |
| A4-068 | ImportSettings | Download | Button | `src/components/settings/ImportSettings.tsx` | 271 |  |
| A4-069 | ImportSettings | Upload Excel or CSV File | Input(file) | `src/components/settings/ImportSettings.tsx` | 280 |  |
| A4-070 | ImportSettings | Change File / Select File | Button | `src/components/settings/ImportSettings.tsx` | 287 |  |
| A4-071 | ImportSettings | claim_number / policyholder_name | Select | `src/components/settings/ImportSettings.tsx` | 330 | options: Skip this field |
| A4-072 | ImportSettings | {importing ? "Importing..." : `Import $ Claims`} | Button | `src/components/settings/ImportSettings.tsx` | 397 |  |
| A4-073 | MaintenancePaymentsTracker | Log manual | Button | `src/components/settings/MaintenancePaymentsTracker.tsx` | 109 |  |
| A4-074 | MaintenancePaymentsTracker | Tenant | Select | `src/components/settings/MaintenancePaymentsTracker.tsx` | 121 | options: ($ /mo), Stripe, ACH, Check, Wire, Other |
| A4-075 | MaintenancePaymentsTracker | Amount (USD) | Input(number) | `src/components/settings/MaintenancePaymentsTracker.tsx` | 136 |  |
| A4-076 | MaintenancePaymentsTracker | Method | Select | `src/components/settings/MaintenancePaymentsTracker.tsx` | 141 | options: Stripe, ACH, Check, Wire, Other |
| A4-077 | MaintenancePaymentsTracker | Period start | Input(date) | `src/components/settings/MaintenancePaymentsTracker.tsx` | 153 |  |
| A4-078 | MaintenancePaymentsTracker | Period end | Input(date) | `src/components/settings/MaintenancePaymentsTracker.tsx` | 157 |  |
| A4-079 | MaintenancePaymentsTracker | Reference | Input | `src/components/settings/MaintenancePaymentsTracker.tsx` | 161 | placeholder: Invoice # / txn id |
| A4-080 | MaintenancePaymentsTracker | Notes | Input | `src/components/settings/MaintenancePaymentsTracker.tsx` | 165 |  |
| A4-081 | MaintenancePaymentsTracker | Cancel | Button | `src/components/settings/MaintenancePaymentsTracker.tsx` | 168 |  |
| A4-082 | MaintenancePaymentsTracker | Save | Button | `src/components/settings/MaintenancePaymentsTracker.tsx` | 169 |  |
| A4-083 | MaintenancePaymentsTracker | (icon/unlabeled Button) | Button | `src/components/settings/MaintenancePaymentsTracker.tsx` | 208 |  |
| A4-084 | NotificationPreferencesSettings | In-App Notifications | Switch | `src/components/settings/NotificationPreferencesSettings.tsx` | 121 |  |
| A4-085 | NotificationPreferencesSettings | Email Notifications | Switch | `src/components/settings/NotificationPreferencesSettings.tsx` | 142 |  |
| A4-086 | NotificationPreferencesSettings | SMS Notifications | Switch | `src/components/settings/NotificationPreferencesSettings.tsx` | 163 |  |
| A4-087 | NotificationPreferencesSettings | Save Preferences | Button | `src/components/settings/NotificationPreferencesSettings.tsx` | 171 |  |
| A4-088 | OrganizationSettings | Create Organization | Button | `src/components/settings/OrganizationSettings.tsx` | 352 |  |
| A4-089 | OrganizationSettings | Organization Name | Input | `src/components/settings/OrganizationSettings.tsx` | 367 | placeholder: e.g., Freedom Claims |
| A4-090 | OrganizationSettings | Slug (URL-friendly identifier) | Input | `src/components/settings/OrganizationSettings.tsx` | 380 | placeholder: e.g., freedom-claims |
| A4-091 | OrganizationSettings | Domain (optional) | Input | `src/components/settings/OrganizationSettings.tsx` | 388 | placeholder: e.g., freedomclaims.com |
| A4-092 | OrganizationSettings | Cancel | Button | `src/components/settings/OrganizationSettings.tsx` | 399 |  |
| A4-093 | OrganizationSettings | Creating... / Create Organization | Button | `src/components/settings/OrganizationSettings.tsx` | 402 |  |
| A4-094 | OrganizationSettings | Edit Details | Button | `src/components/settings/OrganizationSettings.tsx` | 450 |  |
| A4-095 | OrganizationSettings | Delete | Button | `src/components/settings/OrganizationSettings.tsx` | 456 |  |
| A4-096 | OrganizationSettings | (Select) | Select | `src/components/settings/OrganizationSettings.tsx` | 516 | options: Member, Admin |
| A4-097 | OrganizationSettings | (icon/unlabeled Button) | Button | `src/components/settings/OrganizationSettings.tsx` | 534 |  |
| A4-098 | OrganizationSettings | Add Team Member | Button | `src/components/settings/OrganizationSettings.tsx` | 553 |  |
| A4-099 | OrganizationSettings | Search users... | Button | `src/components/settings/OrganizationSettings.tsx` | 570 |  |
| A4-100 | OrganizationSettings | Role | Select | `src/components/settings/OrganizationSettings.tsx` | 618 | options: Member, Admin |
| A4-101 | OrganizationSettings | Cancel | Button | `src/components/settings/OrganizationSettings.tsx` | 629 |  |
| A4-102 | OrganizationSettings | Adding... / Add Member | Button | `src/components/settings/OrganizationSettings.tsx` | 632 |  |
| A4-103 | OrganizationSettings | Organization Name | Input | `src/components/settings/OrganizationSettings.tsx` | 655 | placeholder: e.g., Freedom Claims |
| A4-104 | OrganizationSettings | Slug (URL-friendly identifier) | Input | `src/components/settings/OrganizationSettings.tsx` | 663 | placeholder: e.g., freedom-claims |
| A4-105 | OrganizationSettings | Domain (optional) | Input | `src/components/settings/OrganizationSettings.tsx` | 671 | placeholder: e.g., freedomclaims.com |
| A4-106 | OrganizationSettings | Cancel | Button | `src/components/settings/OrganizationSettings.tsx` | 679 |  |
| A4-107 | OrganizationSettings | Saving... / Save Changes | Button | `src/components/settings/OrganizationSettings.tsx` | 682 |  |
| A4-108 | QuickBooksSettings | Disconnect QuickBooks | Button | `src/components/settings/QuickBooksSettings.tsx` | 243 |  |
| A4-109 | QuickBooksSettings | (icon/unlabeled Button) | Button | `src/components/settings/QuickBooksSettings.tsx` | 253 |  |
| A4-110 | ReferralSettings | Your Referral Code | Input | `src/components/settings/ReferralSettings.tsx` | 127 |  |
| A4-111 | ReferralSettings | Your Referral Code | Button | `src/components/settings/ReferralSettings.tsx` | 128 |  |
| A4-112 | ReferralSettings | ENTER-CODE-HERE | Input | `src/components/settings/ReferralSettings.tsx` | 162 |  |
| A4-113 | ReferralSettings | Applying... / Apply Discount | Button | `src/components/settings/ReferralSettings.tsx` | 163 |  |
| — | SectionCard | *(none in this file)* | — | `src/components/settings/SectionCard.tsx` | — | Display-only or composes children listed elsewhere |
| — | SettingsHero | *(none in this file)* | — | `src/components/settings/SettingsHero.tsx` | — | Display-only or composes children listed elsewhere |
| — | SettingsPageShell | *(none in this file)* | — | `src/components/settings/SettingsPageShell.tsx` | — | Display-only or composes children listed elsewhere |
| A4-114 | SignaturePresetsSettings | Add Type | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 197 |  |
| A4-115 | SignaturePresetsSettings | fields | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 228 |  |
| A4-116 | SignaturePresetsSettings | Display Name | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 255 |  |
| A4-117 | SignaturePresetsSettings | Description | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 265 |  |
| A4-118 | SignaturePresetsSettings | (icon/unlabeled Button) | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 308 |  |
| A4-119 | SignaturePresetsSettings | Label shown to signer | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 324 |  |
| A4-120 | SignaturePresetsSettings | Help text | Textarea | `src/components/settings/SignaturePresetsSettings.tsx` | 336 |  |
| A4-121 | SignaturePresetsSettings | Section | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 350 |  |
| A4-122 | SignaturePresetsSettings | Order | Input(number) | `src/components/settings/SignaturePresetsSettings.tsx` | 362 |  |
| A4-123 | SignaturePresetsSettings | e.g. signature_3, text_2 | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 396 |  |
| A4-124 | SignaturePresetsSettings | Add | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 402 |  |
| A4-125 | SignaturePresetsSettings | Saving... / Save | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 419 |  |
| A4-126 | SignaturePresetsSettings | Cancel | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 428 |  |
| A4-127 | SignaturePresetsSettings | Edit Labels | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 439 |  |
| A4-128 | SignaturePresetsSettings | Delete | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 448 |  |
| A4-129 | SignaturePresetsSettings | Display Name | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 481 | placeholder: e.g. Proof of Loss, Affidavit |
| A4-130 | SignaturePresetsSettings | Type Key | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 494 | placeholder: Auto-generated from name |
| A4-131 | SignaturePresetsSettings | Description (optional) | Input | `src/components/settings/SignaturePresetsSettings.tsx` | 506 | placeholder: Brief description of this document type |
| A4-132 | SignaturePresetsSettings | Cancel | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 514 |  |
| A4-133 | SignaturePresetsSettings | Creating... / Create Preset | Button | `src/components/settings/SignaturePresetsSettings.tsx` | 517 |  |
| A4-134 | TeamCapsSettings | Total stakeholder limit | Input(number) | `src/components/settings/TeamCapsSettings.tsx` | 23 |  |
| — | TenantAgreementsAcceptances | *(none in this file)* | — | `src/components/settings/TenantAgreementsAcceptances.tsx` | — | Display-only or composes children listed elsewhere |
| — | TenantAuditActivity | *(none in this file)* | — | `src/components/settings/TenantAuditActivity.tsx` | — | Display-only or composes children listed elsewhere |
| A4-135 | TenantBankAccountSettings | (icon/unlabeled Button) | Button | `src/components/settings/TenantBankAccountSettings.tsx` | 203 |  |
| A4-136 | TenantBankAccountSettings | Resend | Button | `src/components/settings/TenantBankAccountSettings.tsx` | 252 |  |
| A4-137 | TenantBankAccountSettings | Override | Button | `src/components/settings/TenantBankAccountSettings.tsx` | 263 |  |
| A4-138 | TenantBankAccountSettings | (icon/unlabeled Button) | Button | `src/components/settings/TenantBankAccountSettings.tsx` | 274 |  |
| A4-139 | TenantBillingAccountPanel | Enable monthly auto-debit (maintenance + check processing + payment processing) | Checkbox | `src/components/settings/TenantBillingAccountPanel.tsx` | 168 |  |
| A4-140 | TenantBillingAccountPanel | Choose a verified bank account | Select | `src/components/settings/TenantBillingAccountPanel.tsx` | 186 | options: · {a.chk_acct ? `••••$ ` : "Account pending"} · |
| A4-141 | TenantBillingAccountPanel | Choose a verified bank account | Checkbox | `src/components/settings/TenantBillingAccountPanel.tsx` | 200 |  |
| A4-142 | TenantBillingAccountPanel | Replace / Link account | Button | `src/components/settings/TenantBillingAccountPanel.tsx` | 216 |  |
| — | TenantComplianceDocuments | *(none in this file)* | — | `src/components/settings/TenantComplianceDocuments.tsx` | — | Display-only or composes children listed elsewhere |
| — | TenantComplianceIssues | *(none in this file)* | — | `src/components/settings/TenantComplianceIssues.tsx` | — | Display-only or composes children listed elsewhere |
| — | TenantComplianceReviews | *(none in this file)* | — | `src/components/settings/TenantComplianceReviews.tsx` | — | Display-only or composes children listed elsewhere |
| — | TenantComplianceTimeline | *(none in this file)* | — | `src/components/settings/TenantComplianceTimeline.tsx` | — | Display-only or composes children listed elsewhere |
| A4-143 | TenantDocumentLibrary | (tab) | Tab | `src/components/settings/TenantDocumentLibrary.tsx` | 142 |  |
| A4-144 | TenantDocumentLibrary | Document type | Select(native) | `src/components/settings/TenantDocumentLibrary.tsx` | 256 |  |
| A4-145 | TenantDocumentLibrary | Display name (optional) | Input | `src/components/settings/TenantDocumentLibrary.tsx` | 269 |  |
| A4-146 | TenantDocumentLibrary | Display name (optional) | Checkbox | `src/components/settings/TenantDocumentLibrary.tsx` | 278 |  |
| A4-147 | TenantDocumentLibrary | Display name (optional) | Input(file) | `src/components/settings/TenantDocumentLibrary.tsx` | 283 |  |
| A4-148 | TenantDocumentLibrary | Upload | Button | `src/components/settings/TenantDocumentLibrary.tsx` | 293 |  |
| A4-149 | TenantDocumentLibrary | Auto-share with Mortgage Ops | Checkbox | `src/components/settings/TenantDocumentLibrary.tsx` | 423 |  |
| A4-150 | TenantDocumentLibrary | Share with Clients | Checkbox | `src/components/settings/TenantDocumentLibrary.tsx` | 436 |  |
| A4-151 | TenantDocumentLibrary | Open | Button | `src/components/settings/TenantDocumentLibrary.tsx` | 447 |  |
| A4-152 | TenantDocumentLibrary | Delete | Button | `src/components/settings/TenantDocumentLibrary.tsx` | 450 |  |
| A4-153 | TenantManagement | Logo | Input(file) | `src/components/settings/TenantManagement.tsx` | 254 |  |
| A4-154 | TenantManagement | Replace | Button | `src/components/settings/TenantManagement.tsx` | 268 |  |
| A4-155 | TenantManagement | Logo | Button | `src/components/settings/TenantManagement.tsx` | 271 |  |
| A4-156 | TenantManagement | (icon/unlabeled Button) | Button | `src/components/settings/TenantManagement.tsx` | 277 |  |
| A4-157 | TenantManagement | https://... | Input | `src/components/settings/TenantManagement.tsx` | 296 |  |
| A4-158 | TenantManagement | From Name | Input | `src/components/settings/TenantManagement.tsx` | 311 | placeholder: Acme Insurance |
| A4-159 | TenantManagement | From Email | Input | `src/components/settings/TenantManagement.tsx` | 315 | placeholder: checks@acme.com |
| A4-160 | TenantManagement | Reply-To | Input | `src/components/settings/TenantManagement.tsx` | 321 | placeholder: support@acme.com |
| A4-161 | TenantManagement | Email Provider | Select | `src/components/settings/TenantManagement.tsx` | 326 | options: Not configured, SMTP |
| A4-162 | TenantManagement | SMTP Host | Input | `src/components/settings/TenantManagement.tsx` | 340 | placeholder: smtp.example.com |
| A4-163 | TenantManagement | SMTP Port | Input | `src/components/settings/TenantManagement.tsx` | 344 | placeholder: 587 |
| A4-164 | TenantManagement | Username | Input | `src/components/settings/TenantManagement.tsx` | 348 |  |
| A4-165 | TenantManagement | Password | Input(password) | `src/components/settings/TenantManagement.tsx` | 352 |  |
| A4-166 | TenantManagement | App Password | Link | `src/components/settings/TenantManagement.tsx` | 357 | → https://myaccount.google.com/apppasswords |
| A4-167 | TenantManagement | Organization Name | Input | `src/components/settings/TenantManagement.tsx` | 374 |  |
| A4-168 | TenantManagement | URL Slug | Input | `src/components/settings/TenantManagement.tsx` | 378 | placeholder: my-company |
| A4-169 | TenantManagement | Primary Color | Input(color) | `src/components/settings/TenantManagement.tsx` | 387 |  |
| A4-170 | TenantManagement | Primary Color | Input | `src/components/settings/TenantManagement.tsx` | 388 |  |
| A4-171 | TenantManagement | Secondary Color | Input(color) | `src/components/settings/TenantManagement.tsx` | 394 |  |
| A4-172 | TenantManagement | Secondary Color | Input | `src/components/settings/TenantManagement.tsx` | 395 |  |
| A4-173 | TenantManagement | Custom Domain | Input | `src/components/settings/TenantManagement.tsx` | 402 | placeholder: checks.company.com |
| A4-174 | TenantManagement | Max Checks/Month | Input(number) | `src/components/settings/TenantManagement.tsx` | 406 |  |
| A4-175 | TenantManagement | Status | Select | `src/components/settings/TenantManagement.tsx` | 414 | options: Active, Trial, Inactive, Suspended, Starter, Pro, Enterprise |
| A4-176 | TenantManagement | Plan Tier | Select | `src/components/settings/TenantManagement.tsx` | 426 | options: Starter, Pro, Enterprise |
| A4-177 | TenantManagement | Branding & Email | Tab | `src/components/settings/TenantManagement.tsx` | 443 |  |
| A4-178 | TenantManagement | Save Changes / Create Tenant | Button | `src/components/settings/TenantManagement.tsx` | 450 |  |
| A4-179 | TenantManagement | Add Tenant | Button | `src/components/settings/TenantManagement.tsx` | 465 |  |
| A4-180 | TenantManagement | (icon/unlabeled Button) | Button | `src/components/settings/TenantManagement.tsx` | 523 |  |
| A4-181 | TenantManagement | Delete | Button | `src/components/settings/TenantManagement.tsx` | 526 |  |
| A4-182 | TenantManagement | Preview as this tenant (opens their portal in a new tab) | Button | `src/components/settings/TenantManagement.tsx` | 531 |  |
| A4-183 | TenantManagement | Manage Users | Button | `src/components/settings/TenantManagement.tsx` | 534 |  |
| A4-184 | TenantManagement | Usage Tracking | Button | `src/components/settings/TenantManagement.tsx` | 537 |  |
| A4-185 | TenantManagement | Payment Account | Button | `src/components/settings/TenantManagement.tsx` | 540 |  |
| A4-186 | TenantManagement | Security & Compliance | Button | `src/components/settings/TenantManagement.tsx` | 543 |  |
| A4-187 | TenantManagement | Manage OPS Badge | Button | `src/components/settings/TenantManagement.tsx` | 546 |  |
| A4-188 | TenantManagement | Edit | Button | `src/components/settings/TenantManagement.tsx` | 549 |  |
| A4-189 | TenantPaymentAccountPanel | Payments enabled for this organization | Switch | `src/components/settings/TenantPaymentAccountPanel.tsx` | 190 |  |
| A4-190 | TenantPaymentAccountPanel | Create payment account | Button | `src/components/settings/TenantPaymentAccountPanel.tsx` | 261 |  |
| A4-191 | TenantPaymentAccountPanel | Onboarding link | Button | `src/components/settings/TenantPaymentAccountPanel.tsx` | 266 |  |
| A4-192 | TenantPaymentAccountPanel | Sync | Button | `src/components/settings/TenantPaymentAccountPanel.tsx` | 279 |  |
| A4-193 | TenantPaymentAccountPanel | (icon/unlabeled Button) | Button | `src/components/settings/TenantPaymentAccountPanel.tsx` | 292 |  |
| A4-194 | TenantProBadgeManagement | Revoke OPS | Button | `src/components/settings/TenantProBadgeManagement.tsx` | 175 |  |
| A4-195 | TenantProBadgeManagement | {pending ? : } Approve OPS | Button | `src/components/settings/TenantProBadgeManagement.tsx` | 186 |  |
| — | TenantSecurityCompliance | *(none in this file)* | — | `src/components/settings/TenantSecurityCompliance.tsx` | — | Display-only or composes children listed elsewhere |
| A4-196 | TenantSecurityComplianceAws | Retry | Button | `src/components/settings/TenantSecurityComplianceAws.tsx` | 68 |  |
| A4-197 | TenantSecurityComplianceView | View | Button | `src/components/settings/TenantSecurityComplianceView.tsx` | 43 |  |
| A4-198 | TenantSecurityComplianceView | Permissions | Button | `src/components/settings/TenantSecurityComplianceView.tsx` | 43 |  |
| A4-199 | TenantSecurityComplianceView | Restrict Financial | Button | `src/components/settings/TenantSecurityComplianceView.tsx` | 43 |  |
| A4-200 | TenantSecurityComplianceView | Require Security | Button | `src/components/settings/TenantSecurityComplianceView.tsx` | 43 |  |
| A4-201 | TenantSecurityComplianceView | Revoke | Button | `src/components/settings/TenantSecurityComplianceView.tsx` | 43 |  |
| A4-202 | TenantSecurityComplianceView | Edit Financial Permissions | Button | `src/components/settings/TenantSecurityComplianceView.tsx` | 44 |  |
| A4-203 | TenantSecurityComplianceView | Require Security Setup | Button | `src/components/settings/TenantSecurityComplianceView.tsx` | 45 |  |
| — | TenantUsageDashboard | *(none in this file)* | — | `src/components/settings/TenantUsageDashboard.tsx` | — | Display-only or composes children listed elsewhere |
| A4-204 | TenantUserManagement | Search by name or email... | Input | `src/components/settings/TenantUserManagement.tsx` | 377 |  |
| A4-205 | TenantUserManagement | (Select) | Select | `src/components/settings/TenantUserManagement.tsx` | 395 | options: Admin, Operator, Viewer |
| A4-206 | TenantUserManagement | Remove | Button | `src/components/settings/TenantUserManagement.tsx` | 404 |  |
| A4-207 | TenantUserManagement | Add User | Button | `src/components/settings/TenantUserManagement.tsx` | 416 |  |
| A4-208 | TenantUserManagement | (unlabeled input) | Input(checkbox) | `src/components/settings/TenantUserManagement.tsx` | 445 |  |
| A4-209 | TenantUserManagement | (unlabeled input) | Input(checkbox) | `src/components/settings/TenantUserManagement.tsx` | 483 |  |
| A4-210 | TenantUserManagement | (Select) | Select | `src/components/settings/TenantUserManagement.tsx` | 499 |  |
| A4-211 | TenantUserManagement | Remove user | Button | `src/components/settings/TenantUserManagement.tsx` | 533 |  |
| A4-212 | TenantUserManagement | Full Name | Input | `src/components/settings/TenantUserManagement.tsx` | 570 | placeholder: Jane Smith |
| A4-213 | TenantUserManagement | Email | Input(email) | `src/components/settings/TenantUserManagement.tsx` | 579 | placeholder: jane@company.com |
| A4-214 | TenantUserManagement | Role | Select | `src/components/settings/TenantUserManagement.tsx` | 590 | options: — |
| A4-215 | TenantUserManagement | Cancel | Button | `src/components/settings/TenantUserManagement.tsx` | 609 |  |
| A4-216 | TenantUserManagement | Create & Send Invite | Button | `src/components/settings/TenantUserManagement.tsx` | 612 |  |
| A4-217 | UserManagementSettings | Reset two-factor | Button | `src/components/settings/UserManagementSettings.tsx` | 319 |  |
| A4-218 | UserManagementSettings | Approve | Button | `src/components/settings/UserManagementSettings.tsx` | 323 |  |
| A4-219 | UserManagementSettings | Deny | Button | `src/components/settings/UserManagementSettings.tsx` | 326 |  |
| A4-220 | UserManagementSettings | (icon/unlabeled Button) | Button | `src/components/settings/UserManagementSettings.tsx` | 359 |  |
| A4-221 | UserManagementSettings | Reset two-factor authentication | Button | `src/components/settings/UserManagementSettings.tsx` | 369 |  |
| A4-222 | UserManagementSettings | (Select) | Select | `src/components/settings/UserManagementSettings.tsx` | 373 | options: Admin, Staff, Mortgage Agent |
| A4-223 | UserManagementSettings | Remove all roles | Button | `src/components/settings/UserManagementSettings.tsx` | 383 |  |
| A4-224 | UserManagementSettings | Delete user | Button | `src/components/settings/UserManagementSettings.tsx` | 387 |  |
| A4-225 | ZapierIntegrationSettings | https://hooks.zapier.com/hooks/catch/... | Input | `src/components/settings/ZapierIntegrationSettings.tsx` | 153 |  |
| A4-226 | ZapierIntegrationSettings | Sending... / Test | Button | `src/components/settings/ZapierIntegrationSettings.tsx` | 159 |  |
| A4-227 | ZapierIntegrationSettings | Browse Zapier Apps | Button | `src/components/settings/ZapierIntegrationSettings.tsx` | 169 |  |
| A4-228 | AccountSecurity | Back | Button | `src/pages/AccountSecurity.tsx` | 38 |  |
| A4-229 | AccountSecurity | Passkey | Button | `src/pages/AccountSecurity.tsx` | 63 |  |
| A4-230 | AccountSecurity | Email link | Button | `src/pages/AccountSecurity.tsx` | 69 |  |

**Area 4 count: 230**

## 5. Payments / WalletOps / Cash Jobs / DisbursementConsole

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| A5-001 | Payments | Payment History | Tab | `src/pages/Payments.tsx` | 90 |  |
| A5-002 | Payments | Invoices | Tab | `src/pages/Payments.tsx` | 94 |  |
| A5-003 | Payments | Revenue & Profit | Tab | `src/pages/Payments.tsx` | 98 |  |
| A5-004 | Payments | By Recipient | Tab | `src/pages/Payments.tsx` | 102 |  |
| A5-005 | Payments | Tax & 1099 | Tab | `src/pages/Payments.tsx` | 106 |  |
| A5-006 | Payments | Payroll | Tab | `src/pages/Payments.tsx` | 111 |  |
| A5-007 | WalletOps | Go to Payment Account | Button | `src/pages/WalletOps.tsx` | 217 |  |
| A5-008 | WalletOps | Refresh balances | Button | `src/pages/WalletOps.tsx` | 284 |  |
| A5-009 | WalletOps | Manage sweeps | Button | `src/pages/WalletOps.tsx` | 349 |  |
| A5-010 | WalletOps | Add funds | Button | `src/pages/WalletOps.tsx` | 364 |  |
| A5-011 | WalletOps | Default payout speed | Select | `src/pages/WalletOps.tsx` | 408 |  |
| A5-012 | WalletOps | Save payout preference | Button | `src/pages/WalletOps.tsx` | 430 |  |
| A5-013 | WalletOps | Open Payment Account | Button | `src/pages/WalletOps.tsx` | 477 |  |
| — | CashJobs | *(none in this file)* | — | `src/pages/CashJobs.tsx` | — | Display-only or composes children listed elsewhere |
| A5-014 | PayrollTab | New Payroll Payment | Button | `src/pages/payments/PayrollTab.tsx` | 33 |  |
| A5-015 | InvoicesTab | Invoice Branding | Button | `src/pages/payments/InvoicesTab.tsx` | 210 |  |
| A5-016 | InvoicesTab | Refresh | Button | `src/pages/payments/InvoicesTab.tsx` | 225 |  |
| A5-017 | InvoicesTab | New invoice | Button | `src/pages/payments/InvoicesTab.tsx` | 238 |  |
| A5-018 | InvoicesTab | Customer name | Input | `src/pages/payments/InvoicesTab.tsx` | 266 | placeholder: Acme Restoration LLC |
| A5-019 | InvoicesTab | Customer email | Input(email) | `src/pages/payments/InvoicesTab.tsx` | 270 | placeholder: billing@acme.com |
| A5-020 | InvoicesTab | Customer type | Select | `src/pages/payments/InvoicesTab.tsx` | 275 | options: Business, Individual |
| A5-021 | InvoicesTab | Due date | Input(date) | `src/pages/payments/InvoicesTab.tsx` | 284 |  |
| A5-022 | InvoicesTab | Description | Textarea | `src/pages/payments/InvoicesTab.tsx` | 290 | placeholder: Mitigation services — claim #12345 |
| A5-023 | InvoicesTab | Line items | Input | `src/pages/payments/InvoicesTab.tsx` | 302 | placeholder: Description |
| A5-024 | InvoicesTab | Line items | Input(number) | `src/pages/payments/InvoicesTab.tsx` | 308 | placeholder: 0.00 |
| A5-025 | InvoicesTab | (unlabeled input) | Input(number) | `src/pages/payments/InvoicesTab.tsx` | 314 |  |
| A5-026 | InvoicesTab | Remove line item | Button | `src/pages/payments/InvoicesTab.tsx` | 320 |  |
| A5-027 | InvoicesTab | Add line item | Button | `src/pages/payments/InvoicesTab.tsx` | 329 |  |
| A5-028 | InvoicesTab | Save draft | Button | `src/pages/payments/InvoicesTab.tsx` | 351 |  |
| A5-029 | InvoicesTab | Send invoice | Button | `src/pages/payments/InvoicesTab.tsx` | 354 |  |
| A5-030 | InvoicesTab | Invoice actions | Button | `src/pages/payments/InvoicesTab.tsx` | 494 |  |
| A5-031 | InvoicesTab | Send invoice | MenuItem | `src/pages/payments/InvoicesTab.tsx` | 498 |  |
| A5-032 | InvoicesTab | Resend invoice | MenuItem | `src/pages/payments/InvoicesTab.tsx` | 503 |  |
| A5-033 | InvoicesTab | Copy payment link | MenuItem | `src/pages/payments/InvoicesTab.tsx` | 509 |  |
| A5-034 | InvoicesTab | Open invoice page | MenuItem | `src/pages/payments/InvoicesTab.tsx` | 512 |  |
| A5-035 | InvoicesTab | Cancel invoice | MenuItem | `src/pages/payments/InvoicesTab.tsx` | 518 |  |
| A5-036 | InvoicesTab | Delete invoice | MenuItem | `src/pages/payments/InvoicesTab.tsx` | 523 |  |
| — | PaymentSettingsTab | *(none in this file)* | — | `src/pages/payments/PaymentSettingsTab.tsx` | — | Display-only or composes children listed elsewhere |
| A5-037 | PaymentLedger | Search recipient, check #, carrier... | Input | `src/components/ledger/PaymentLedger.tsx` | 230 |  |
| A5-038 | PaymentLedger | (Select) | Select | `src/components/ledger/PaymentLedger.tsx` | 233 | options: This month, Last month, This year, All time, All types, All status, Settled, In Transit |
| A5-039 | PaymentLedger | (Select) | Select | `src/components/ledger/PaymentLedger.tsx` | 242 | options: All types, All status, Settled, In Transit, Returned, Failed |
| A5-040 | PaymentLedger | (Select) | Select | `src/components/ledger/PaymentLedger.tsx` | 251 | options: All status, Settled, In Transit, Returned, Failed |
| A5-041 | PaymentLedger | Export CSV | Button | `src/components/ledger/PaymentLedger.tsx` | 260 |  |
| A5-042 | PaymentLedger | (Select) | Select | `src/components/ledger/PaymentLedger.tsx` | 312 |  |
| A5-043 | RecipientReport | ${v.total.toLocaleString("en-US", )} payment | Button | `src/components/ledger/RecipientReport.tsx` | 228 |  |
| A5-044 | RecipientReport | Search recipient name... | Input | `src/components/ledger/RecipientReport.tsx` | 250 |  |
| A5-045 | RecipientReport | (Select) | Select | `src/components/ledger/RecipientReport.tsx` | 253 | options: This month, Last month, This year, All time, All types |
| A5-046 | RecipientReport | (Select) | Select | `src/components/ledger/RecipientReport.tsx` | 262 | options: All types |
| A5-047 | RecipientReport | Export CSV | Button | `src/components/ledger/RecipientReport.tsx` | 270 |  |
| A5-048 | RecipientReport | Edit recipient | Button | `src/components/ledger/RecipientReport.tsx` | 371 |  |
| A5-049 | RecipientReport | Recipient name | Input | `src/components/ledger/RecipientReport.tsx` | 404 |  |
| A5-050 | RecipientReport | Type | Select | `src/components/ledger/RecipientReport.tsx` | 409 |  |
| A5-051 | RecipientReport | Cancel | Button | `src/components/ledger/RecipientReport.tsx` | 420 |  |
| A5-052 | RecipientReport | Saving... / Save changes | Button | `src/components/ledger/RecipientReport.tsx` | 421 |  |
| A5-053 | TaxSummary | (Select) | Select | `src/components/ledger/TaxSummary.tsx` | 480 |  |
| A5-054 | TaxSummary | Export for accountant | Button | `src/components/ledger/TaxSummary.tsx` | 485 |  |
| A5-055 | TaxSummary | Generate {flag1099Count > 0 ? `$ ` : ""}1099 | Button | `src/components/ledger/TaxSummary.tsx` | 488 |  |
| A5-056 | TaxSummary | ${monthlyTotals[i].toLocaleString("en-US", )} | Button | `src/components/ledger/TaxSummary.tsx` | 553 |  |
| A5-057 | TaxSummary | Year ${totalPaid.toLocaleString("en-US", )} | Button | `src/components/ledger/TaxSummary.tsx` | 564 |  |
| A5-058 | TaxSummary | Search recipient... | Input | `src/components/ledger/TaxSummary.tsx` | 581 |  |
| A5-059 | TaxSummary | (Select) | Select | `src/components/ledger/TaxSummary.tsx` | 584 | options: All types, Full year |
| A5-060 | TaxSummary | (Select) | Select | `src/components/ledger/TaxSummary.tsx` | 593 | options: Full year |
| A5-061 | TaxSummary | Edit | Button | `src/components/ledger/TaxSummary.tsx` | 684 |  |
| A5-062 | TaxSummary | Generate | Button | `src/components/ledger/TaxSummary.tsx` | 692 |  |
| A5-063 | TaxSummary | Tax info | Button | `src/components/ledger/TaxSummary.tsx` | 705 |  |
| A5-064 | TaxSummary | Recipient name (as shown on 1099) | Input | `src/components/ledger/TaxSummary.tsx` | 759 |  |
| A5-065 | TaxSummary | Recipient TIN / SSN / EIN | Input | `src/components/ledger/TaxSummary.tsx` | 763 | placeholder: XX-XXXXXXX or XXX-XX-XXXX |
| A5-066 | TaxSummary | Street address | Input | `src/components/ledger/TaxSummary.tsx` | 767 |  |
| A5-067 | TaxSummary | City | Input | `src/components/ledger/TaxSummary.tsx` | 772 |  |
| A5-068 | TaxSummary | State | Input | `src/components/ledger/TaxSummary.tsx` | 776 |  |
| A5-069 | TaxSummary | ZIP | Input | `src/components/ledger/TaxSummary.tsx` | 780 |  |
| A5-070 | TaxSummary | Account number (optional) | Input | `src/components/ledger/TaxSummary.tsx` | 785 |  |
| A5-071 | TaxSummary | Notes (optional) | Input | `src/components/ledger/TaxSummary.tsx` | 789 |  |
| A5-072 | TaxSummary | Cancel | Button | `src/components/ledger/TaxSummary.tsx` | 793 |  |
| A5-073 | TaxSummary | Saving... / Save | Button | `src/components/ledger/TaxSummary.tsx` | 794 |  |
| — | RevenueSummary | *(none in this file)* | — | `src/components/ledger/RevenueSummary.tsx` | — | Display-only or composes children listed elsewhere |
| A5-074 | CashJobCheckUpload | (icon/unlabeled Button) | Button | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 198 |  |
| A5-075 | CashJobCheckUpload | Upload check from client | Button | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 215 |  |
| A5-076 | CashJobCheckUpload | (icon/unlabeled Button) | Button | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 229 |  |
| A5-077 | CashJobCheckUpload | Payment type | Select | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 240 |  |
| A5-078 | CashJobCheckUpload | Front of check * | Button | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 270 |  |
| A5-079 | CashJobCheckUpload | (unlabeled input) | Input(file) | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 283 |  |
| A5-080 | CashJobCheckUpload | Back of check (optional) | Button | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 303 |  |
| A5-081 | CashJobCheckUpload | (unlabeled input) | Input(file) | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 316 |  |
| A5-082 | CashJobCheckUpload | (icon/unlabeled Button) | Button | `src/components/cash-jobs/CashJobCheckUpload.tsx` | 325 |  |
| A5-083 | CashJobDetail | Back | Button | `src/components/cash-jobs/CashJobDetail.tsx` | 149 |  |
| A5-084 | CashJobDetail | Edit | Button | `src/components/cash-jobs/CashJobDetail.tsx` | 154 |  |
| A5-085 | CashJobDetail | (link) | Link | `src/components/cash-jobs/CashJobDetail.tsx` | 175 |  |
| A5-086 | CashJobDetail | (link) | Link | `src/components/cash-jobs/CashJobDetail.tsx` | 180 |  |
| A5-087 | CashJobDetail | Record payment | Button | `src/components/cash-jobs/CashJobDetail.tsx` | 271 |  |
| A5-088 | CashJobDetail | Amount ($) | Input(number) | `src/components/cash-jobs/CashJobDetail.tsx` | 296 | placeholder: 0.00 |
| A5-089 | CashJobDetail | Payment method | Select | `src/components/cash-jobs/CashJobDetail.tsx` | 301 |  |
| A5-090 | CashJobDetail | Payment date | Input(date) | `src/components/cash-jobs/CashJobDetail.tsx` | 311 |  |
| A5-091 | CashJobDetail | Reference # (optional) | Input | `src/components/cash-jobs/CashJobDetail.tsx` | 315 | placeholder: Check #, transaction ID |
| A5-092 | CashJobDetail | Notes (optional) | Input | `src/components/cash-jobs/CashJobDetail.tsx` | 319 | placeholder: e.g. Initial deposit |
| A5-093 | CashJobDetail | Saving... / Record payment | Button | `src/components/cash-jobs/CashJobDetail.tsx` | 323 |  |
| A5-094 | CashJobDetail | Cancel | Button | `src/components/cash-jobs/CashJobDetail.tsx` | 326 |  |
| A5-095 | CashJobDetail | (icon/unlabeled Button) | Button | `src/components/cash-jobs/CashJobDetail.tsx` | 350 |  |
| A5-096 | CashJobForm | Back | Button | `src/components/cash-jobs/CashJobForm.tsx` | 147 |  |
| A5-097 | CashJobForm | Job name * | Input | `src/components/cash-jobs/CashJobForm.tsx` | 161 | placeholder: e.g. Smith Roof Replacement |
| A5-098 | CashJobForm | Work type | Select | `src/components/cash-jobs/CashJobForm.tsx` | 166 |  |
| A5-099 | CashJobForm | Contract amount ($) | Input(number) | `src/components/cash-jobs/CashJobForm.tsx` | 174 | placeholder: 0.00 |
| A5-100 | CashJobForm | Estimate date | Input(date) | `src/components/cash-jobs/CashJobForm.tsx` | 182 |  |
| A5-101 | CashJobForm | Start date | Input(date) | `src/components/cash-jobs/CashJobForm.tsx` | 186 |  |
| A5-102 | CashJobForm | Completion date | Input(date) | `src/components/cash-jobs/CashJobForm.tsx` | 190 |  |
| A5-103 | CashJobForm | Description | Textarea | `src/components/cash-jobs/CashJobForm.tsx` | 196 | placeholder: Scope of work... |
| A5-104 | CashJobForm | Customer name * | Input | `src/components/cash-jobs/CashJobForm.tsx` | 208 | placeholder: Full name |
| A5-105 | CashJobForm | Phone | Input | `src/components/cash-jobs/CashJobForm.tsx` | 212 | placeholder: (555) 000-0000 |
| A5-106 | CashJobForm | Email | Input(email) | `src/components/cash-jobs/CashJobForm.tsx` | 216 | placeholder: email@example.com |
| A5-107 | CashJobForm | Property address | Input | `src/components/cash-jobs/CashJobForm.tsx` | 220 | placeholder: Street address |
| A5-108 | CashJobForm | City | Input | `src/components/cash-jobs/CashJobForm.tsx` | 224 |  |
| A5-109 | CashJobForm | State | Input | `src/components/cash-jobs/CashJobForm.tsx` | 229 | placeholder: TX |
| A5-110 | CashJobForm | ZIP | Input | `src/components/cash-jobs/CashJobForm.tsx` | 233 |  |
| A5-111 | CashJobForm | Add line | Button | `src/components/cash-jobs/CashJobForm.tsx` | 245 |  |
| A5-112 | CashJobForm | Description | Input | `src/components/cash-jobs/CashJobForm.tsx` | 254 |  |
| A5-113 | CashJobForm | Qty | Input(number) | `src/components/cash-jobs/CashJobForm.tsx` | 260 |  |
| A5-114 | CashJobForm | Unit $ | Input(number) | `src/components/cash-jobs/CashJobForm.tsx` | 267 |  |
| A5-115 | CashJobForm | (icon/unlabeled Button) | Button | `src/components/cash-jobs/CashJobForm.tsx` | 278 |  |
| A5-116 | CashJobForm | Notes | Textarea | `src/components/cash-jobs/CashJobForm.tsx` | 297 | placeholder: Internal notes... |
| A5-117 | CashJobForm | Saving... / Save job | Button | `src/components/cash-jobs/CashJobForm.tsx` | 303 |  |
| A5-118 | CashJobForm | Cancel | Button | `src/components/cash-jobs/CashJobForm.tsx` | 307 |  |
| A5-119 | CashJobsPage | New job | Button | `src/components/cash-jobs/CashJobsPage.tsx` | 121 |  |
| A5-120 | CashJobsPage | Search customer, job, address... | Input | `src/components/cash-jobs/CashJobsPage.tsx` | 162 |  |
| A5-121 | CashJobsPage | (Select) | Select | `src/components/cash-jobs/CashJobsPage.tsx` | 170 | options: All status |
| A5-122 | CashJobsPage | Add your first job | Button | `src/components/cash-jobs/CashJobsPage.tsx` | 187 |  |
| A5-123 | AchAuthorizationForm | Revoke | Button | `src/components/disbursement/AchAuthorizationForm.tsx` | 123 |  |
| A5-124 | AchAuthorizationForm | Sign & Authorize ACH | Button | `src/components/disbursement/AchAuthorizationForm.tsx` | 161 |  |
| A5-125 | AddExternalStakeholderDialog | (unlabeled input) | Input | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 176 |  |
| A5-126 | AddExternalStakeholderDialog | (icon/unlabeled Button) | Button | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 177 |  |
| A5-127 | AddExternalStakeholderDialog | Name | Input | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 190 | placeholder: ABC Roofing or Jane Smith |
| A5-128 | AddExternalStakeholderDialog | Recipient is | Select | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 196 | options: A person, A business, Subcontractor, Vendor, Contractor, Supplier, Other |
| A5-129 | AddExternalStakeholderDialog | Role on check | Select | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 206 | options: Subcontractor, Vendor, Contractor, Supplier, Other |
| A5-130 | AddExternalStakeholderDialog | Email (sends the verification link) | Input(email) | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 219 | placeholder: name@company.com |
| A5-131 | AddExternalStakeholderDialog | Phone (optional) | Input | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 223 | placeholder: (555) 555-5555 |
| A5-132 | AddExternalStakeholderDialog | Done | Button | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 230 |  |
| A5-133 | AddExternalStakeholderDialog | Cancel | Button | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 233 |  |
| A5-134 | AddExternalStakeholderDialog | Add & send link | Button | `src/components/disbursement/AddExternalStakeholderDialog.tsx` | 234 |  |
| — | BankVerification | *(none in this file)* | — | `src/components/disbursement/BankVerification.tsx` | — | Display-only or composes children listed elsewhere |
| A5-135 | CheckStakeholdersManager | Bank link | Button | `src/components/disbursement/CheckStakeholdersManager.tsx` | 240 |  |
| A5-136 | CheckStakeholdersManager | Add | Button | `src/components/disbursement/CheckStakeholdersManager.tsx` | 254 |  |
| A5-137 | CheckStakeholdersManager | Search stakeholders... | Input | `src/components/disbursement/CheckStakeholdersManager.tsx` | 262 |  |
| A5-138 | CheckStakeholdersManager | {p.payout_ready ? `Bank approved${p.last_four ? ` · $ ••$ ` : ""}` : "Bank not verified yet"} Partner | Button | `src/components/disbursement/CheckStakeholdersManager.tsx` | 276 |  |
| A5-139 | CheckStakeholdersManager | Payment account connected | Button | `src/components/disbursement/CheckStakeholdersManager.tsx` | 312 |  |
| A5-140 | CheckStakeholdersManager | Add someone new | Button | `src/components/disbursement/CheckStakeholdersManager.tsx` | 338 |  |
| A5-141 | CheckStakeholdersManager | Enable payouts | Button | `src/components/disbursement/CheckStakeholdersManager.tsx` | 409 |  |
| A5-142 | CheckStakeholdersManager | (icon/unlabeled Button) | Button | `src/components/disbursement/CheckStakeholdersManager.tsx` | 423 |  |
| A5-143 | DisbursementConsole | Switch to $ / Switch to % | Button | `src/components/disbursement/DisbursementConsole.tsx` | 491 | Toggles $ vs % allocation inputs |
| A5-144 | DisbursementConsole | Bank / auto | Balance | RadioButton | `src/components/disbursement/DisbursementConsole.tsx` | 593 | Funding source radiogroup (.map); options: Bank / auto, Balance |
| A5-145 | DisbursementConsole | Next Day | Same Day | External / Manual | RadioButton | `src/components/disbursement/DisbursementConsole.tsx` | 631 | Delivery speed radiogroup (.map) |
| A5-146 | DisbursementConsole | Allocation amount | Input(number) | `src/components/disbursement/DisbursementConsole.tsx` | 709 | Per-account allocation; placeholder 0 |
| A5-147 | DisbursementConsole | Admin override: send anyway. This is audit-logged against your user and the affected accounts. | Checkbox | `src/components/disbursement/DisbursementConsole.tsx` | 757 | Shown when unverified accounts allocated |
| A5-148 | DisbursementConsole | Send $N / Verify accounts to send / Funds available in ~Xh / Submitting... | Button | `src/components/disbursement/DisbursementConsole.tsx` | 808 | Label depends on submit/hold/verification state |
| A5-149 | RequestStakeholderLimitDialog | New cap | Input(number) | `src/components/disbursement/RequestStakeholderLimitDialog.tsx` | 69 |  |
| A5-150 | RequestStakeholderLimitDialog | Reason (optional) | Textarea | `src/components/disbursement/RequestStakeholderLimitDialog.tsx` | 78 | placeholder: Why do you need more? |
| A5-151 | RequestStakeholderLimitDialog | Cancel | Button | `src/components/disbursement/RequestStakeholderLimitDialog.tsx` | 87 |  |
| A5-152 | RequestStakeholderLimitDialog | Submit request | Button | `src/components/disbursement/RequestStakeholderLimitDialog.tsx` | 88 |  |
| A5-153 | SendHomeownerBankLinkDialog | Attach to | Radio | `src/components/disbursement/SendHomeownerBankLinkDialog.tsx` | 86 |  |
| A5-154 | SendHomeownerBankLinkDialog | Just this check | Radio | `src/components/disbursement/SendHomeownerBankLinkDialog.tsx` | 90 |  |
| A5-155 | SendHomeownerBankLinkDialog | Homeowner name | Input | `src/components/disbursement/SendHomeownerBankLinkDialog.tsx` | 100 | placeholder: Jane Homeowner |
| A5-156 | SendHomeownerBankLinkDialog | Homeowner email | Input(email) | `src/components/disbursement/SendHomeownerBankLinkDialog.tsx` | 104 | placeholder: jane@example.com |
| A5-157 | SendHomeownerBankLinkDialog | Cancel | Button | `src/components/disbursement/SendHomeownerBankLinkDialog.tsx` | 109 |  |
| A5-158 | SendHomeownerBankLinkDialog | Send link | Button | `src/components/disbursement/SendHomeownerBankLinkDialog.tsx` | 110 |  |
| A5-159 | StakeholderAccountSettings | Nickname | Input | `src/components/disbursement/StakeholderAccountSettings.tsx` | 355 | placeholder: e.g. Operating account |
| A5-160 | StakeholderAccountSettings | Type | Select | `src/components/disbursement/StakeholderAccountSettings.tsx` | 369 | options: Checking, Savings |
| A5-161 | StakeholderAccountSettings | Account holder name | Input | `src/components/disbursement/StakeholderAccountSettings.tsx` | 382 | placeholder: Full legal name on account |
| A5-162 | StakeholderAccountSettings | Account type | Select | `src/components/disbursement/StakeholderAccountSettings.tsx` | 387 | options: Checking, Savings |
| A5-163 | StakeholderAccountSettings | Account type | Switch | `src/components/disbursement/StakeholderAccountSettings.tsx` | 395 |  |
| A5-164 | StakeholderAccountSettings | Set as primary account | Switch | `src/components/disbursement/StakeholderAccountSettings.tsx` | 408 |  |
| A5-165 | StakeholderAccountSettings | Account holder's email | Input(email) | `src/components/disbursement/StakeholderAccountSettings.tsx` | 418 | placeholder: name@example.com |
| A5-166 | StakeholderAccountSettings | email / Send link / Continue to bank login | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 438 |  |
| A5-167 | StakeholderAccountSettings | Cancel | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 463 |  |
| A5-168 | StakeholderAccountSettings | Resend | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 516 |  |
| A5-169 | StakeholderAccountSettings | Override | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 527 |  |
| A5-170 | StakeholderAccountSettings | Send terms link | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 539 |  |
| A5-171 | StakeholderAccountSettings | (icon/unlabeled Button) | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 550 |  |
| A5-172 | StakeholderAccountSettings | Close | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 600 |  |
| A5-173 | StakeholderAccountSettings | Also disconnect their payment account | Switch | `src/components/disbursement/StakeholderAccountSettings.tsx` | 614 |  |
| A5-174 | StakeholderAccountSettings | Cancel | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 630 |  |
| A5-175 | StakeholderAccountSettings | Remove | Button | `src/components/disbursement/StakeholderAccountSettings.tsx` | 631 |  |
| A5-176 | TenantStakeholderLimitRequests | Pending | Tab | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 122 |  |
| A5-177 | TenantStakeholderLimitRequests | Reviewed | Tab | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 123 |  |
| A5-178 | TenantStakeholderLimitRequests | Approve | Button | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 155 |  |
| A5-179 | TenantStakeholderLimitRequests | Deny | Button | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 158 |  |
| A5-180 | TenantStakeholderLimitRequests | (unlabeled input) | Input(number) | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 201 |  |
| A5-181 | TenantStakeholderLimitRequests | (unlabeled textarea) | Textarea | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 206 |  |
| A5-182 | TenantStakeholderLimitRequests | Cancel | Button | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 211 |  |
| A5-183 | TenantStakeholderLimitRequests | Confirm | Button | `src/components/disbursement/TenantStakeholderLimitRequests.tsx` | 212 |  |
| A5-184 | AutoFundingPanel | (unlabeled switch) | Switch | `src/components/payments/AutoFundingPanel.tsx` | 162 |  |
| A5-185 | AutoFundingPanel | Accept and save | Button | `src/components/payments/AutoFundingPanel.tsx` | 185 |  |
| A5-186 | AutoFundingPanel | Funding bank account | Select | `src/components/payments/AutoFundingPanel.tsx` | 204 | options: •••• |
| A5-187 | AutoFundingPanel | Funding strategy | Select | `src/components/payments/AutoFundingPanel.tsx` | 224 |  |
| A5-188 | AutoFundingPanel | Target wallet balance | Input | `src/components/payments/AutoFundingPanel.tsx` | 241 |  |
| A5-189 | AutoFundingPanel | Maximum single transfer | Input | `src/components/payments/AutoFundingPanel.tsx` | 247 |  |
| A5-190 | AutoFundingPanel | Maximum per day | Input | `src/components/payments/AutoFundingPanel.tsx` | 252 |  |
| A5-191 | AutoFundingPanel | Save funding settings | Button | `src/components/payments/AutoFundingPanel.tsx` | 256 |  |
| A5-192 | AutoFundingPanel | One-time transfer from your bank | Input | `src/components/payments/AutoFundingPanel.tsx` | 280 | placeholder: Amount |
| A5-193 | AutoFundingPanel | Transfer to wallet | Button | `src/components/payments/AutoFundingPanel.tsx` | 288 |  |
| A5-194 | AutoFundingPanel | Cancel | Button | `src/components/payments/AutoFundingPanel.tsx` | 311 |  |
| A5-195 | ClaimLedgerCard | Claim number | Input | `src/components/payments/ClaimLedgerCard.tsx` | 223 |  |
| A5-196 | ClaimLedgerCard | Linking... / Link | Button | `src/components/payments/ClaimLedgerCard.tsx` | 229 |  |
| A5-197 | ClaimLedgerCard | Change | Button | `src/components/payments/ClaimLedgerCard.tsx` | 352 |  |
| A5-198 | ClaimLedgerCard | Re-link to a different claim number | Input | `src/components/payments/ClaimLedgerCard.tsx` | 369 |  |
| A5-199 | ClaimLedgerCard | Saving... / Save | Button | `src/components/payments/ClaimLedgerCard.tsx` | 375 |  |
| A5-200 | ClaimLedgerCard | Edit amounts / Enter amounts | Button | `src/components/payments/ClaimLedgerCard.tsx` | 416 |  |
| A5-201 | ClaimSettlementEditor | (tab) | Tab | `src/components/payments/ClaimSettlementEditor.tsx` | 135 |  |
| A5-202 | ClaimSettlementEditor | Cancel | Button | `src/components/payments/ClaimSettlementEditor.tsx` | 166 |  |
| A5-203 | ClaimSettlementEditor | Saving... / Save All Categories | Button | `src/components/payments/ClaimSettlementEditor.tsx` | 167 |  |
| A5-204 | ClaimSettlementEditor | (unlabeled input) | Input(number) | `src/components/payments/ClaimSettlementEditor.tsx` | 180 |  |
| A5-205 | FundsTab | % | Button | `src/components/payments/FundsTab.tsx` | 371 |  |
| A5-206 | FundsTab | $ | Button | `src/components/payments/FundsTab.tsx` | 372 |  |
| A5-207 | FundsTab | Public adjuster fee (optional) | Input(number) | `src/components/payments/FundsTab.tsx` | 377 | placeholder: e.g. 10 |
| A5-208 | FundsTab | $ amount | Input(number) | `src/components/payments/FundsTab.tsx` | 379 |  |
| A5-209 | FundsTab | Save | Button | `src/components/payments/FundsTab.tsx` | 381 |  |
| A5-210 | FundsTab | Send Homeowner Payment Link | Button | `src/components/payments/FundsTab.tsx` | 431 |  |
| A5-211 | FundsTab | Resending… / Resend Payment Link | Button | `src/components/payments/FundsTab.tsx` | 436 |  |
| A5-212 | FundsTab | Disburse to Stakeholders | Button | `src/components/payments/FundsTab.tsx` | 478 |  |
| A5-213 | FundsTab | Disburse Outside ChecksOps | Button | `src/components/payments/FundsTab.tsx` | 486 |  |
| A5-214 | FundsTab | Cancel | Button | `src/components/payments/FundsTab.tsx` | 513 |  |
| A5-215 | FundsTab | Cancel | Button | `src/components/payments/FundsTab.tsx` | 545 |  |
| A5-216 | FundsTab | Recurring recipient (optional) | Select | `src/components/payments/FundsTab.tsx` | 567 | options: · · × |
| A5-217 | FundsTab | Recipient | Input | `src/components/payments/FundsTab.tsx` | 584 | placeholder: e.g. ABC Roofing |
| A5-218 | FundsTab | Type | Select(native) | `src/components/payments/FundsTab.tsx` | 588 |  |
| A5-219 | FundsTab | Check # | Input | `src/components/payments/FundsTab.tsx` | 608 | placeholder: 1234 |
| A5-220 | FundsTab | Amount | Input(number) | `src/components/payments/FundsTab.tsx` | 612 | placeholder: 0.00 |
| A5-221 | FundsTab | Notes (optional) | Input | `src/components/payments/FundsTab.tsx` | 617 | placeholder: Memo, date paid, etc. |
| A5-222 | FundsTab | Recording... / Record Payment | Button | `src/components/payments/FundsTab.tsx` | 620 |  |
| A5-223 | MicroDepositVerification | Restart verification | Button | `src/components/payments/MicroDepositVerification.tsx` | 187 |  |
| A5-224 | MicroDepositVerification | 4-digit code | Input(text) | `src/components/payments/MicroDepositVerification.tsx` | 218 |  |
| A5-225 | MicroDepositVerification | Confirm code | Button | `src/components/payments/MicroDepositVerification.tsx` | 229 |  |
| A5-226 | MicroDepositVerification | Restart verification | Button | `src/components/payments/MicroDepositVerification.tsx` | 238 |  |
| A5-227 | MicroDepositVerification | Verify with instant micro-deposit | Button | `src/components/payments/MicroDepositVerification.tsx` | 254 |  |
| A5-228 | MoovBankLink | Account holder name | Input | `src/components/payments/MoovBankLink.tsx` | 91 | placeholder: Exactly as it appears at the bank |
| A5-229 | MoovBankLink | Holder type | Select | `src/components/payments/MoovBankLink.tsx` | 103 | options: Business, Individual, Checking, Savings |
| A5-230 | MoovBankLink | Account type | Select | `src/components/payments/MoovBankLink.tsx` | 114 | options: Checking, Savings |
| A5-231 | MoovBankLink | Routing number | Input | `src/components/payments/MoovBankLink.tsx` | 124 | placeholder: 9 digits |
| A5-232 | MoovBankLink | Account number | Input | `src/components/payments/MoovBankLink.tsx` | 136 | placeholder: 4–17 digits |
| A5-233 | MoovBankLink | Cancel | Button | `src/components/payments/MoovBankLink.tsx` | 154 |  |
| A5-234 | MoovBankLink | Connect bank | Button | `src/components/payments/MoovBankLink.tsx` | 157 |  |
| A5-235 | MoovTreasuryPanel | Refresh | Button | `src/components/payments/MoovTreasuryPanel.tsx` | 135 |  |
| A5-236 | MoovTreasuryPanel | Payout speed | Select | `src/components/payments/MoovTreasuryPanel.tsx` | 205 |  |
| A5-237 | MoovTreasuryPanel | Minimum balance to keep | Input | `src/components/payments/MoovTreasuryPanel.tsx` | 223 |  |
| A5-238 | MoovTreasuryPanel | Bank statement description | Input | `src/components/payments/MoovTreasuryPanel.tsx` | 237 | placeholder: CHECKSOPS |
| A5-239 | MoovTreasuryPanel | Save changes / Turn on daily payouts | Button | `src/components/payments/MoovTreasuryPanel.tsx` | 252 |  |
| A5-240 | MoovTreasuryPanel | Turn off | Button | `src/components/payments/MoovTreasuryPanel.tsx` | 257 |  |
| A5-241 | PaymentAccountPanel | Open payment account setup | Link | `src/components/payments/PaymentAccountPanel.tsx` | 221 |  |
| A5-242 | PaymentAccountPanel | (icon/unlabeled Button) | Button | `src/components/payments/PaymentAccountPanel.tsx` | 239 |  |
| A5-243 | PaymentAccountPanel | setup / additional_information_required / restricted | Button | `src/components/payments/PaymentAccountPanel.tsx` | 254 |  |
| A5-244 | PaymentAccountPanel | Connect Bank | Button | `src/components/payments/PaymentAccountPanel.tsx` | 267 |  |
| A5-245 | PaymentAccountPanel | sync | Button | `src/components/payments/PaymentAccountPanel.tsx` | 277 |  |
| A5-246 | PaymentOnboardingDialog | Street address | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 85 |  |
| A5-247 | PaymentOnboardingDialog | Suite (optional) | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 89 |  |
| A5-248 | PaymentOnboardingDialog | City | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 93 |  |
| A5-249 | PaymentOnboardingDialog | State | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 97 |  |
| A5-250 | PaymentOnboardingDialog | ZIP | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 101 |  |
| A5-251 | PaymentOnboardingDialog | Legal business name | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 277 |  |
| A5-252 | PaymentOnboardingDialog | Doing business as (optional) | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 281 |  |
| A5-253 | PaymentOnboardingDialog | Business type | Select | `src/components/payments/PaymentOnboardingDialog.tsx` | 286 |  |
| A5-254 | PaymentOnboardingDialog | EIN (9 digits) | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 296 | placeholder: 12-3456789 |
| A5-255 | PaymentOnboardingDialog | Business email | Input(email) | `src/components/payments/PaymentOnboardingDialog.tsx` | 300 |  |
| A5-256 | PaymentOnboardingDialog | Business phone | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 304 |  |
| A5-257 | PaymentOnboardingDialog | Website | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 308 | placeholder: example.com |
| A5-258 | PaymentOnboardingDialog | What the business does (if no website) | Textarea | `src/components/payments/PaymentOnboardingDialog.tsx` | 312 |  |
| A5-259 | PaymentOnboardingDialog | Add person | Button | `src/components/payments/PaymentOnboardingDialog.tsx` | 330 |  |
| A5-260 | PaymentOnboardingDialog | (icon/unlabeled Button) | Button | `src/components/payments/PaymentOnboardingDialog.tsx` | 348 |  |
| A5-261 | PaymentOnboardingDialog | First name | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 363 |  |
| A5-262 | PaymentOnboardingDialog | Last name | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 367 |  |
| A5-263 | PaymentOnboardingDialog | Email | Input(email) | `src/components/payments/PaymentOnboardingDialog.tsx` | 371 |  |
| A5-264 | PaymentOnboardingDialog | Phone | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 375 |  |
| A5-265 | PaymentOnboardingDialog | Job title | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 379 |  |
| A5-266 | PaymentOnboardingDialog | Date of birth | Input(date) | `src/components/payments/PaymentOnboardingDialog.tsx` | 383 |  |
| A5-267 | PaymentOnboardingDialog | Social Security number | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 387 | placeholder: 123-45-6789 |
| A5-268 | PaymentOnboardingDialog | Ownership % | Input | `src/components/payments/PaymentOnboardingDialog.tsx` | 397 | placeholder: 100 |
| A5-269 | PaymentOnboardingDialog | Ownership % | Checkbox | `src/components/payments/PaymentOnboardingDialog.tsx` | 414 |  |
| A5-270 | PaymentOnboardingDialog | (unlabeled checkbox) | Checkbox | `src/components/payments/PaymentOnboardingDialog.tsx` | 425 |  |
| A5-271 | PaymentOnboardingDialog | Cancel | Button | `src/components/payments/PaymentOnboardingDialog.tsx` | 437 |  |
| A5-272 | PaymentOnboardingDialog | Submit for verification | Button | `src/components/payments/PaymentOnboardingDialog.tsx` | 440 |  |
| A5-273 | PaymentProviderAdmin | Testing… / Run connection test | Button | `src/components/payments/PaymentProviderAdmin.tsx` | 84 |  |
| A5-274 | PaymentReadinessPanel | platform agreement | Link | `src/components/payments/PaymentReadinessPanel.tsx` | 191 | → https://moov.io/legal/platform-agreement/ |
| A5-275 | PaymentReadinessPanel | privacy policy | Link | `src/components/payments/PaymentReadinessPanel.tsx` | 200 | → https://moov.io/legal/privacy-policy/ |
| A5-276 | PaymentReadinessPanel | Accept terms | Button | `src/components/payments/PaymentReadinessPanel.tsx` | 215 |  |
| A5-277 | PaymentReadinessPanel | (icon/unlabeled Button) | Button | `src/components/payments/PaymentReadinessPanel.tsx` | 221 |  |
| A5-278 | PlatformFeeSchedulePanel | Refresh | Button | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 111 |  |
| A5-279 | PlatformFeeSchedulePanel | Preview | Button | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 127 |  |
| A5-280 | PlatformFeeSchedulePanel | Bill now | Button | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 130 |  |
| A5-281 | PlatformFeeSchedulePanel | Charge day of month | Input(number) | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 140 |  |
| A5-282 | PlatformFeeSchedulePanel | Amount | Select | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 152 | options: Usage only, Base + usage |
| A5-283 | PlatformFeeSchedulePanel | Base amount (USD) | Input(number) | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 163 | placeholder: 0.00 |
| A5-284 | PlatformFeeSchedulePanel | Update schedule / Create schedule | Button | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 177 |  |
| A5-285 | PlatformFeeSchedulePanel | Cancel schedule | Button | `src/components/payments/PlatformFeeSchedulePanel.tsx` | 184 |  |
| A5-286 | SendPaymentPanel | % | Button | `src/components/payments/SendPaymentPanel.tsx` | 245 |  |
| A5-287 | SendPaymentPanel | $ | Button | `src/components/payments/SendPaymentPanel.tsx` | 251 |  |
| A5-288 | SendPaymentPanel | Your fee | Input(number) | `src/components/payments/SendPaymentPanel.tsx` | 261 |  |
| A5-289 | SendPaymentPanel | Notes (optional) | Input | `src/components/payments/SendPaymentPanel.tsx` | 302 | placeholder: e.g. Initial draw for roof repairs |
| A5-290 | SendPaymentPanel | Admin override: | Checkbox | `src/components/payments/SendPaymentPanel.tsx` | 330 |  |
| A5-291 | SendPaymentPanel | (icon/unlabeled Button) | Button | `src/components/payments/SendPaymentPanel.tsx` | 345 |  |
| A5-292 | SendPaymentPanel | {sendPayment.isPending ? ( <> Sending... ) : ( <> Confirm & send )} | Button | `src/components/payments/SendPaymentPanel.tsx` | 364 |  |
| A5-293 | SendPaymentPanel | Cancel | Button | `src/components/payments/SendPaymentPanel.tsx` | 375 |  |
| A5-294 | UnderwritingQuestionnairePanel | Average payment ($) | Input | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 152 | placeholder: 5000 |
| A5-295 | UnderwritingQuestionnairePanel | Largest payment ($) | Input | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 161 | placeholder: 50000 |
| A5-296 | UnderwritingQuestionnairePanel | Monthly volume ($) | Input | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 170 | placeholder: 250000 |
| A5-297 | UnderwritingQuestionnairePanel | Volume with business customers (%) | Input | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 182 |  |
| A5-298 | UnderwritingQuestionnairePanel | Volume with consumers (%) | Input | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 197 |  |
| A5-299 | UnderwritingQuestionnairePanel | We sell or deliver physical goods | Switch | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 204 |  |
| A5-300 | UnderwritingQuestionnairePanel | We ship products to customers | Switch | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 213 |  |
| A5-301 | UnderwritingQuestionnairePanel | Typical delivery time (days) | Input | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 221 |  |
| A5-302 | UnderwritingQuestionnairePanel | Return policy | Select | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 230 |  |
| A5-303 | UnderwritingQuestionnairePanel | Return policy | Button | `src/components/payments/UnderwritingQuestionnairePanel.tsx` | 243 |  |
| A5-304 | UsageLogTab | (Select) | Select | `src/components/payments/UsageLogTab.tsx` | 77 | options: MMMM yyyy |
| A5-305 | VerificationDocumentsPanel | (icon/unlabeled Button) | Button | `src/components/payments/VerificationDocumentsPanel.tsx` | 144 |  |
| A5-306 | VerificationDocumentsPanel | Document type | Select | `src/components/payments/VerificationDocumentsPanel.tsx` | 165 |  |
| A5-307 | VerificationDocumentsPanel | Business representative | Select | `src/components/payments/VerificationDocumentsPanel.tsx` | 182 |  |
| A5-308 | VerificationDocumentsPanel | Business representative | Input(file) | `src/components/payments/VerificationDocumentsPanel.tsx` | 195 |  |
| A5-309 | VerificationDocumentsPanel | (icon/unlabeled Button) | Button | `src/components/payments/VerificationDocumentsPanel.tsx` | 207 |  |
| A5-310 | VerificationDocumentsPanel | (icon/unlabeled Button) | Button | `src/components/payments/VerificationDocumentsPanel.tsx` | 273 |  |
| A5-311 | WalletPanel | Refresh | Button | `src/components/payments/WalletPanel.tsx` | 71 |  |
| A5-312 | WalletPanel | Amount to add | Input(number) | `src/components/payments/WalletPanel.tsx` | 122 |  |
| A5-313 | WalletPanel | Add funds from bank | Button | `src/components/payments/WalletPanel.tsx` | 133 |  |

**Area 5 count: 313**

## 6. MortgageOpsQueue + MortgageOpsLogin

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| A6-001 | MortgageOpsQueue | Sign out | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 249 |  |
| A6-002 | MortgageOpsQueue | Queued | Tab | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 267 |  |
| A6-003 | MortgageOpsQueue | In progress | Tab | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 271 |  |
| A6-004 | MortgageOpsQueue | Completed | Tab | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 275 |  |
| A6-005 | MortgageOpsQueue | Directory | Tab | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 279 |  |
| A6-006 | MortgageOpsQueue | Accept task | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 326 |  |
| A6-007 | MortgageOpsQueue | View details | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 334 |  |
| A6-008 | MortgageOpsQueue | Add a work note… | Textarea | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 391 |  |
| A6-009 | MortgageOpsQueue | View details | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 398 |  |
| A6-010 | MortgageOpsQueue | Add note | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 401 |  |
| A6-011 | MortgageOpsQueue | Mark complete | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 409 |  |
| A6-012 | MortgageOpsQueue | Cancel | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 416 |  |
| A6-013 | MortgageOpsQueue | View details | Button | `src/pages/mortgage-ops/MortgageOpsQueue.tsx` | 475 |  |
| A6-014 | MortgageOpsLogin | Email verification code | Input | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 156 |  |
| A6-015 | MortgageOpsLogin | Verify and sign in | Button | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 166 |  |
| A6-016 | MortgageOpsLogin | Use a different email | Button | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 170 |  |
| A6-017 | MortgageOpsLogin | Use a different email | Button | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 180 |  |
| A6-018 | MortgageOpsLogin | Work email | Input(email) | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 191 |  |
| A6-019 | MortgageOpsLogin | Signing in… / Sign in with passkey | Button | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 201 |  |
| A6-020 | MortgageOpsLogin | Work email | Input(email) | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 226 |  |
| A6-021 | MortgageOpsLogin | Sending… / Email me a verification code / Email me a sign-in link | Button | `src/pages/mortgage-ops/MortgageOpsLogin.tsx` | 236 |  |

**Area 6 count: 21**

## 7. HomeownerCheckUpload / ClaimPortal / Ledger / Sign / Endorse / PaymentDirection

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| A7-001 | HomeownerCheckUpload | Upload code | Input | `src/pages/HomeownerCheckUpload.tsx` | 426 | placeholder: 123456 |
| A7-002 | HomeownerCheckUpload | Verify and continue | Button | `src/pages/HomeownerCheckUpload.tsx` | 435 |  |
| A7-003 | HomeownerCheckUpload | Use a different email | Button | `src/pages/HomeownerCheckUpload.tsx` | 441 |  |
| A7-004 | HomeownerCheckUpload | Your email | Input(email) | `src/pages/HomeownerCheckUpload.tsx` | 449 | placeholder: you@example.com |
| A7-005 | HomeownerCheckUpload | Send me a secure code / Send me a secure link | Button | `src/pages/HomeownerCheckUpload.tsx` | 461 |  |
| A7-006 | HomeownerCheckUpload | Back to directory | Link | `src/pages/HomeownerCheckUpload.tsx` | 466 | → /find-a-pro |
| A7-007 | HomeownerCheckUpload | Sign out | Button | `src/pages/HomeownerCheckUpload.tsx` | 494 |  |
| A7-008 | HomeownerCheckUpload | Find a Pro | Link | `src/pages/HomeownerCheckUpload.tsx` | 507 | → /find-a-pro |
| A7-009 | HomeownerCheckUpload | (unlabeled input) | Input(file) | `src/pages/HomeownerCheckUpload.tsx` | 547 |  |
| A7-010 | HomeownerCheckUpload | Anything the contractor should know? (optional) | Textarea | `src/pages/HomeownerCheckUpload.tsx` | 559 | placeholder: e.g. Mortgage company on the check is Wells Fargo… |
| A7-011 | HomeownerCheckUpload | Send check securely | Button | `src/pages/HomeownerCheckUpload.tsx` | 568 |  |
| A7-012 | HomeownerCheckUpload | ChecksOps home | Link | `src/pages/HomeownerCheckUpload.tsx` | 624 | → /find-a-pro |
| A7-013 | HomeownerClaimPortal | Back to Find a Pro | Link | `src/pages/HomeownerClaimPortal.tsx` | 377 | → /find-a-pro |
| A7-014 | HomeownerClaimPortal | (unlabeled input) | Input(file) | `src/pages/HomeownerClaimPortal.tsx` | 436 |  |
| A7-015 | HomeownerClaimPortal | (icon/unlabeled Button) | Button | `src/pages/HomeownerClaimPortal.tsx` | 479 |  |
| A7-016 | HomeownerClaimPortal | Sign | Button | `src/pages/HomeownerClaimPortal.tsx` | 497 |  |
| A7-017 | HomeownerClaimPortal | Fill in | Button | `src/pages/HomeownerClaimPortal.tsx` | 501 |  |
| A7-018 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 649 |  |
| A7-019 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 652 |  |
| A7-020 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 655 |  |
| A7-021 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 658 |  |
| A7-022 | HomeownerClaimPortal | I have read and agree to the Direction to Pay above. | Checkbox | `src/pages/HomeownerClaimPortal.tsx` | 673 |  |
| A7-023 | HomeownerClaimPortal | First Last | Input | `src/pages/HomeownerClaimPortal.tsx` | 679 |  |
| A7-024 | HomeownerClaimPortal | Sign Direction to Pay | Button | `src/pages/HomeownerClaimPortal.tsx` | 686 |  |
| A7-025 | HomeownerClaimPortal | (unlabeled input) | Input(file) | `src/pages/HomeownerClaimPortal.tsx` | 726 |  |
| A7-026 | HomeownerClaimPortal | Note to contractor (optional) | Textarea | `src/pages/HomeownerClaimPortal.tsx` | 737 | placeholder: e.g. Mortgage company on the check is Wells Fargo… |
| A7-027 | HomeownerClaimPortal | Send check securely | Button | `src/pages/HomeownerClaimPortal.tsx` | 745 |  |
| A7-028 | HomeownerClaimPortal | I have read and agree. My typed name is my signature. | Checkbox | `src/pages/HomeownerClaimPortal.tsx` | 812 |  |
| A7-029 | HomeownerClaimPortal | First Last | Input | `src/pages/HomeownerClaimPortal.tsx` | 822 |  |
| A7-030 | HomeownerClaimPortal | Cancel | Button | `src/pages/HomeownerClaimPortal.tsx` | 831 |  |
| A7-031 | HomeownerClaimPortal | Sign document | Button | `src/pages/HomeownerClaimPortal.tsx` | 832 |  |
| A7-032 | HomeownerClaimPortal | e.g. Wells Fargo Home Mortgage | Input | `src/pages/HomeownerClaimPortal.tsx` | 854 |  |
| A7-033 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 863 |  |
| A7-034 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 870 |  |
| A7-035 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 878 |  |
| A7-036 | HomeownerClaimPortal | (unlabeled input) | Input | `src/pages/HomeownerClaimPortal.tsx` | 885 |  |
| A7-037 | HomeownerClaimPortal | 1234 | Input | `src/pages/HomeownerClaimPortal.tsx` | 892 |  |
| A7-038 | HomeownerClaimPortal | (unlabeled textarea) | Textarea | `src/pages/HomeownerClaimPortal.tsx` | 901 |  |
| A7-039 | HomeownerClaimPortal | First Last | Input | `src/pages/HomeownerClaimPortal.tsx` | 909 |  |
| A7-040 | HomeownerClaimPortal | Cancel | Button | `src/pages/HomeownerClaimPortal.tsx` | 922 |  |
| A7-041 | HomeownerClaimPortal | Submit mortgage info | Button | `src/pages/HomeownerClaimPortal.tsx` | 923 |  |
| A7-042 | HomeownerClaimPortal | ChecksOps home | Link | `src/pages/HomeownerClaimPortal.tsx` | 966 | → /find-a-pro |
| A7-043 | HomeownerLedger | Send a new check or document | Button | `src/pages/HomeownerLedger.tsx` | 331 |  |
| A7-044 | HomeownerLedger | Sign now | Button | `src/pages/HomeownerLedger.tsx` | 412 |  |
| A7-045 | HomeownerLedger | Sign now | Button | `src/pages/HomeownerLedger.tsx` | 499 |  |
| A7-046 | HomeownerLedger | View | Button | `src/pages/HomeownerLedger.tsx` | 547 |  |
| A7-047 | HomeownerLedger | New check | Button | `src/pages/HomeownerLedger.tsx` | 655 |  |
| A7-048 | HomeownerLedger | Production doc | Button | `src/pages/HomeownerLedger.tsx` | 656 |  |
| A7-049 | HomeownerLedger | Amount (optional) | Input | `src/pages/HomeownerLedger.tsx` | 667 | placeholder: 0.00 |
| A7-050 | HomeownerLedger | Note (optional) | Textarea | `src/pages/HomeownerLedger.tsx` | 673 |  |
| A7-051 | HomeownerLedger | Send securely | Button | `src/pages/HomeownerLedger.tsx` | 675 |  |
| A7-052 | HomeownerLedger | (unlabeled input) | Input(file) | `src/pages/HomeownerLedger.tsx` | 705 |  |
| A7-053 | HomeownerLedger | Pay deductible from your bank | Button | `src/pages/HomeownerLedger.tsx` | 910 |  |
| A7-054 | HomeownerLedger | Amount | Input(number) | `src/pages/HomeownerLedger.tsx` | 920 |  |
| A7-055 | HomeownerLedger | Name on the account | Input | `src/pages/HomeownerLedger.tsx` | 924 | placeholder: Jane Homeowner |
| A7-056 | HomeownerLedger | Routing number | Input | `src/pages/HomeownerLedger.tsx` | 929 |  |
| A7-057 | HomeownerLedger | Account number | Input | `src/pages/HomeownerLedger.tsx` | 933 |  |
| A7-058 | HomeownerLedger | Account number | Button | `src/pages/HomeownerLedger.tsx` | 938 |  |
| A7-059 | HomeownerLedger | Account number | Input(checkbox) | `src/pages/HomeownerLedger.tsx` | 945 |  |
| A7-060 | HomeownerLedger | Pay | Button | `src/pages/HomeownerLedger.tsx` | 952 |  |
| A7-061 | HomeownerLedger | Cancel | Button | `src/pages/HomeownerLedger.tsx` | 956 |  |
| A7-062 | Sign | Doc | Button | `src/pages/Sign.tsx` | 410 |  |
| A7-063 | Sign | Finish | Button | `src/pages/Sign.tsx` | 421 |  |
| A7-064 | Sign | 1 Review Document | Button | `src/pages/Sign.tsx` | 448 |  |
| A7-065 | Sign | 2 Sign & Complete | Button | `src/pages/Sign.tsx` | 466 |  |
| A7-066 | Sign | I've Reviewed — Continue to Sign | Button | `src/pages/Sign.tsx` | 507 |  |
| A7-067 | Sign | ↑ View Document Again | Button | `src/pages/Sign.tsx` | 547 |  |
| A7-068 | Sign | ↺ Clear & Redo | Button | `src/pages/Sign.tsx` | 679 |  |
| A7-069 | Sign | (field.checkboxLabel || field.label || "I agree") | Checkbox | `src/pages/Sign.tsx` | 689 | Dynamic per document field |
| A7-070 | Sign | (unlabeled input) | Input(date) | `src/pages/Sign.tsx` | 702 |  |
| A7-071 | Sign | (unlabeled input) | Input(text) | `src/pages/Sign.tsx` | 711 |  |
| A7-072 | Sign | (eSignConsentText) | Checkbox | `src/pages/Sign.tsx` | 731 | E-sign consent |
| A7-073 | Sign | Complete Signature / Submitting Signature... | Button | `src/pages/Sign.tsx` | 738 |  |
| A7-074 | Sign | ← Back to Document Review | Button | `src/pages/Sign.tsx` | 757 |  |
| A7-075 | Endorse | Clear | Button | `src/pages/Endorse.tsx` | 338 |  |
| A7-076 | Endorse | (unlabeled input) | Input(checkbox) | `src/pages/Endorse.tsx` | 343 |  |
| A7-077 | Endorse | (unlabeled input) | Input(radio) | `src/pages/Endorse.tsx` | 370 |  |
| A7-078 | Endorse | (unlabeled input) | Input(radio) | `src/pages/Endorse.tsx` | 393 |  |
| A7-079 | Endorse | Enter contractor name... | Input(text) | `src/pages/Endorse.tsx` | 414 |  |
| A7-080 | Endorse | Endorse Check | Button | `src/pages/Endorse.tsx` | 427 |  |
| A7-081 | Endorse | Reject | Button | `src/pages/Endorse.tsx` | 432 |  |
| A7-082 | PaymentDirectionPage | Yes, pay contractor directly | Button | `src/pages/PaymentDirectionPage.tsx` | 132 |  |
| A7-083 | PaymentDirectionPage | No, send funds to me | Button | `src/pages/PaymentDirectionPage.tsx` | 141 |  |
| A7-084 | AttachUploadToClaimDialog | Amount (optional) | Input(number) | `src/components/homeowner-ledger/AttachUploadToClaimDialog.tsx` | 109 | placeholder: 0.00 |
| A7-085 | AttachUploadToClaimDialog | Find claim | Input | `src/components/homeowner-ledger/AttachUploadToClaimDialog.tsx` | 123 | placeholder: Claim number, homeowner name, or address |
| A7-086 | AttachUploadToClaimDialog | {c.policyholder_address ? ` • $ ` : ""} | Button | `src/components/homeowner-ledger/AttachUploadToClaimDialog.tsx` | 145 |  |
| A7-087 | AttachUploadToClaimDialog | Cancel | Button | `src/components/homeowner-ledger/AttachUploadToClaimDialog.tsx` | 166 |  |
| A7-088 | AttachUploadToClaimDialog | (icon/unlabeled Button) | Button | `src/components/homeowner-ledger/AttachUploadToClaimDialog.tsx` | 167 |  |
| A7-089 | HomeownerLedgerPanel | Name | Input | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 98 |  |
| A7-090 | HomeownerLedgerPanel | Email | Input(email) | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 99 |  |
| A7-091 | HomeownerLedgerPanel | Phone | Input | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 100 | placeholder: (optional) |
| A7-092 | HomeownerLedgerPanel | Send ledger link | Button | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 102 |  |
| A7-093 | HomeownerLedgerPanel | Copy | Button | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 132 |  |
| A7-094 | HomeownerLedgerPanel | View | Button | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 135 |  |
| A7-095 | HomeownerLedgerPanel | Resend | Button | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 138 |  |
| A7-096 | HomeownerLedgerPanel | Revoke | Button | `src/components/homeowner-ledger/HomeownerLedgerPanel.tsx` | 141 |  |
| A7-097 | HomeownerSubmittedChecksInbox | Process to Review | Button | `src/components/homeowner-ledger/HomeownerSubmittedChecksInbox.tsx` | 111 |  |
| A7-098 | HomeownerSubmittedChecksInbox | Reject | Button | `src/components/homeowner-ledger/HomeownerSubmittedChecksInbox.tsx` | 114 |  |
| A7-099 | HomeownerSubmittedChecksInbox | (link) | Link | `src/components/homeowner-ledger/HomeownerSubmittedChecksInbox.tsx` | 145 |  |
| A7-100 | PostHomeownerUpdateCard | Share a status update the homeowner should see (e.g.  | Textarea | `src/components/homeowner-ledger/PostHomeownerUpdateCard.tsx` | 95 |  |
| A7-101 | PostHomeownerUpdateCard | Post update | Button | `src/components/homeowner-ledger/PostHomeownerUpdateCard.tsx` | 102 |  |
| A7-102 | ProjectPlanCard | Tentative start | Input(date) | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 198 |  |
| A7-103 | ProjectPlanCard | Through | Input(date) | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 203 |  |
| A7-104 | ProjectPlanCard | Status | Select | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 209 |  |
| A7-105 | ProjectPlanCard | Note to homeowner | Textarea | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 219 | placeholder: Materials arrive the week prior; crew starts weather permitting. |
| A7-106 | ProjectPlanCard | Total project / claim amount | Input(number) | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 226 | placeholder: 0.00 |
| A7-107 | ProjectPlanCard | Deductible | Input(number) | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 233 | placeholder: 0.00 |
| A7-108 | ProjectPlanCard | Other out of pocket | Input(number) | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 240 | placeholder: 0.00 |
| A7-109 | ProjectPlanCard | (unlabeled switch) | Switch | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 260 |  |
| A7-110 | ProjectPlanCard | (unlabeled switch) | Switch | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 265 |  |
| A7-111 | ProjectPlanCard | Save project details | Button | `src/components/homeowner-ledger/ProjectPlanCard.tsx` | 271 |  |
| A7-112 | SendCheckTrackingLinkButton | Link this check to a claim first | Button | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 112 |  |
| A7-113 | SendCheckTrackingLinkButton | (icon/unlabeled Button) | Button | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 120 |  |
| A7-114 | SendCheckTrackingLinkButton | Copy | Button | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 139 |  |
| A7-115 | SendCheckTrackingLinkButton | Preview | Button | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 142 |  |
| A7-116 | SendCheckTrackingLinkButton | Done | Button | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 151 |  |
| A7-117 | SendCheckTrackingLinkButton | Homeowner name | Input | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 159 |  |
| A7-118 | SendCheckTrackingLinkButton | Email | Input(email) | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 163 | placeholder: name@example.com |
| A7-119 | SendCheckTrackingLinkButton | Phone (optional) | Input | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 167 |  |
| A7-120 | SendCheckTrackingLinkButton | Cancel | Button | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 171 |  |
| A7-121 | SendCheckTrackingLinkButton | Send link | Button | `src/components/homeowner-ledger/SendCheckTrackingLinkButton.tsx` | 172 |  |
| A7-122 | SendHomeownerUploadLink | Homeowner name | Input | `src/components/homeowner-ledger/SendHomeownerUploadLink.tsx` | 117 |  |
| A7-123 | SendHomeownerUploadLink | Email | Input(email) | `src/components/homeowner-ledger/SendHomeownerUploadLink.tsx` | 118 | placeholder: name@example.com |
| A7-124 | SendHomeownerUploadLink | Phone | Input | `src/components/homeowner-ledger/SendHomeownerUploadLink.tsx` | 119 | placeholder: (optional) |
| A7-125 | SendHomeownerUploadLink | Send upload link | Button | `src/components/homeowner-ledger/SendHomeownerUploadLink.tsx` | 122 |  |
| A7-126 | SendHomeownerUploadLink | Copy | Button | `src/components/homeowner-ledger/SendHomeownerUploadLink.tsx` | 157 |  |
| A7-127 | SendHomeownerUploadLink | Preview | Button | `src/components/homeowner-ledger/SendHomeownerUploadLink.tsx` | 160 |  |
| A7-128 | SendHomeownerUploadLink | Revoke | Button | `src/components/homeowner-ledger/SendHomeownerUploadLink.tsx` | 163 |  |

**Area 7 count: 128**

## 8. Public CheckOpsLanding / Login / Signup / Pricing / Security / Privacy / Terms / FindAPro

| ID | Screen | Control label/name | Element type | File | Approx line | Notes |
|---|---|---|---|---|---|---|
| — | CheckOpsLanding | *(none in this file)* | — | `src/pages/checkops/CheckOpsLanding.tsx` | — | Display-only or composes children listed elsewhere |
| A8-001 | CheckCenterMarketing | Send $8,420.00 | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 120 |  |
| A8-002 | CheckCenterMarketing | Add funds | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 153 |  |
| A8-003 | CheckCenterMarketing | Capabilities | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 362 | → #capabilities |
| A8-004 | CheckCenterMarketing | Workflow | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 363 | → #workflow |
| A8-005 | CheckCenterMarketing | Money Movement | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 364 | → #money-movement |
| A8-006 | CheckCenterMarketing | Partners | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 365 | → #partners |
| A8-007 | CheckCenterMarketing | Security | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 366 | → #security |
| A8-008 | CheckCenterMarketing | Demo | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 367 | → #demo |
| A8-009 | CheckCenterMarketing | Sign in | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 370 |  |
| A8-010 | CheckCenterMarketing | Menu | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 373 |  |
| A8-011 | CheckCenterMarketing | (link) | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 381 |  |
| A8-012 | CheckCenterMarketing | Log in | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 385 | → /login |
| A8-013 | CheckCenterMarketing | Book a live demo | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 418 |  |
| A8-014 | CheckCenterMarketing | Sign in | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 421 |  |
| A8-015 | CheckCenterMarketing | Upload loss-draft documents | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 597 |  |
| A8-016 | CheckCenterMarketing | Name * | Input | `src/pages/marketing/CheckCenterMarketing.tsx` | 776 | placeholder: Jane Doe |
| A8-017 | CheckCenterMarketing | Work email * | Input(email) | `src/pages/marketing/CheckCenterMarketing.tsx` | 780 | placeholder: jane@firm.com |
| A8-018 | CheckCenterMarketing | Company | Input | `src/pages/marketing/CheckCenterMarketing.tsx` | 786 | placeholder: Firm or contractor |
| A8-019 | CheckCenterMarketing | Role | Input | `src/pages/marketing/CheckCenterMarketing.tsx` | 790 | placeholder: PA, Owner, Ops |
| A8-020 | CheckCenterMarketing | What would you like to see? | Textarea | `src/pages/marketing/CheckCenterMarketing.tsx` | 795 | placeholder: Volume of checks, partner sharing interest, loss draft use case… |
| A8-021 | CheckCenterMarketing | Sending… / Request demo | Button | `src/pages/marketing/CheckCenterMarketing.tsx` | 797 |  |
| A8-022 | CheckCenterMarketing | (link) | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 805 |  |
| A8-023 | CheckCenterMarketing | Support | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 822 |  |
| A8-024 | CheckCenterMarketing | Sign in | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 823 | → /login |
| A8-025 | CheckCenterMarketing | Book demo | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 824 | → #demo |
| A8-026 | CheckCenterMarketing | Privacy Notice | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 825 | → /privacy-notice |
| A8-027 | CheckCenterMarketing | Terms of Service | Link | `src/pages/marketing/CheckCenterMarketing.tsx` | 826 | → /terms |
| A8-028 | CheckOpsLogin | Email verification code | Input | `src/pages/checkops/CheckOpsLogin.tsx` | 189 |  |
| A8-029 | CheckOpsLogin | Verify and sign in | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 191 |  |
| A8-030 | CheckOpsLogin | Request a new code | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 192 |  |
| A8-031 | CheckOpsLogin | Email | Input(email) | `src/pages/checkops/CheckOpsLogin.tsx` | 198 |  |
| A8-032 | CheckOpsLogin | Password | Input(password) | `src/pages/checkops/CheckOpsLogin.tsx` | 202 |  |
| A8-033 | CheckOpsLogin | Sign in with a passkey | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 208 | Badge: Recommended |
| A8-034 | CheckOpsLogin | Email me a verification code / Email me a sign-in link | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 211 |  |
| A8-035 | CheckOpsLogin | Sign in with password | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 214 |  |
| A8-036 | CheckOpsLogin | Use email verification / passkey instead / Use staging password (master UAT) | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 217 |  |
| A8-037 | CheckOpsLogin | Need an account? Create one | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 228 |  |
| A8-038 | CheckOpsLogin | Back to checksops.com | Button | `src/pages/checkops/CheckOpsLogin.tsx` | 228 |  |
| A8-039 | CheckOpsSignup | Back to sign in | Button | `src/pages/checkops/CheckOpsSignup.tsx` | 81 |  |
| A8-040 | CheckOpsSignup | Full name | Input | `src/pages/checkops/CheckOpsSignup.tsx` | 110 |  |
| A8-041 | CheckOpsSignup | Work email | Input(email) | `src/pages/checkops/CheckOpsSignup.tsx` | 114 |  |
| A8-042 | CheckOpsSignup | Passkey Recommended Fastest and most secure. Face ID, Touch ID, Windows Hello or a security key — nothing to remember and nothing to phish. | Button | `src/pages/checkops/CheckOpsSignup.tsx` | 127 |  |
| A8-043 | CheckOpsSignup | Email sign-in link We email you a one-time link each time you sign in. Slower, and only as safe as your inbox. | Button | `src/pages/checkops/CheckOpsSignup.tsx` | 145 |  |
| A8-044 | CheckOpsSignup | Create account | Button | `src/pages/checkops/CheckOpsSignup.tsx` | 169 |  |
| A8-045 | CheckOpsSignup | Already have an account? | Button | `src/pages/checkops/CheckOpsSignup.tsx` | 176 |  |
| A8-046 | CheckOpsPricing | / | Link | `src/pages/checkops/CheckOpsPricing.tsx` | 36 | → / |
| A8-047 | CheckOpsPricing | Capabilities | Link | `src/pages/checkops/CheckOpsPricing.tsx` | 40 | → /#capabilities |
| A8-048 | CheckOpsPricing | Workflow | Link | `src/pages/checkops/CheckOpsPricing.tsx` | 41 | → /#workflow |
| A8-049 | CheckOpsPricing | Security | Link | `src/pages/checkops/CheckOpsPricing.tsx` | 42 | → /#security |
| A8-050 | CheckOpsPricing | Log in | Button | `src/pages/checkops/CheckOpsPricing.tsx` | 46 |  |
| A8-051 | CheckOpsPricing | Talk to us | Button | `src/pages/checkops/CheckOpsPricing.tsx` | 49 |  |
| A8-052 | CheckOpsPricing | Schedule onboarding | Button | `src/pages/checkops/CheckOpsPricing.tsx` | 210 |  |
| A8-053 | CheckOpsPricing | Sign in | Button | `src/pages/checkops/CheckOpsPricing.tsx` | 213 |  |
| A8-054 | CheckOpsSecurity | / | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 114 | → / |
| A8-055 | CheckOpsSecurity | Capabilities | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 118 | → /#capabilities |
| A8-056 | CheckOpsSecurity | Workflow | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 119 | → /#workflow |
| A8-057 | CheckOpsSecurity | Pricing | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 121 | → /pricing |
| A8-058 | CheckOpsSecurity | Log in | Button | `src/pages/checkops/CheckOpsSecurity.tsx` | 124 |  |
| A8-059 | CheckOpsSecurity | Talk to us | Button | `src/pages/checkops/CheckOpsSecurity.tsx` | 127 |  |
| A8-060 | CheckOpsSecurity | security@checksops.com | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 296 | → mailto:security@checksops.com |
| A8-061 | CheckOpsSecurity | Talk to us | Button | `src/pages/checkops/CheckOpsSecurity.tsx` | 311 |  |
| A8-062 | CheckOpsSecurity | See pricing | Button | `src/pages/checkops/CheckOpsSecurity.tsx` | 314 |  |
| A8-063 | CheckOpsSecurity | Privacy | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 324 | → /privacy-notice |
| A8-064 | CheckOpsSecurity | Security | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 325 | → /security |
| A8-065 | CheckOpsSecurity | Pricing | Link | `src/pages/checkops/CheckOpsSecurity.tsx` | 326 | → /pricing |
| A8-066 | PrivacyNotice | Your name | Input | `src/pages/PrivacyNotice.tsx` | 180 |  |
| A8-067 | PrivacyNotice | Email * | Input(email) | `src/pages/PrivacyNotice.tsx` | 184 |  |
| A8-068 | PrivacyNotice | Recording… / I acknowledge receipt of this Privacy Notice | Button | `src/pages/PrivacyNotice.tsx` | 187 |  |
| A8-069 | Terms | / | Link | `src/pages/Terms.tsx` | 33 | → / |
| A8-070 | Terms | Privacy Notice | Link | `src/pages/Terms.tsx` | 165 | → /privacy-notice |
| A8-071 | Terms | (link) | Link | `src/pages/Terms.tsx` | 293 |  |
| A8-072 | Terms | Home | Link | `src/pages/Terms.tsx` | 301 | → / |
| A8-073 | Terms | Privacy Notice | Link | `src/pages/Terms.tsx` | 302 | → /privacy-notice |
| A8-074 | Terms | Security | Link | `src/pages/Terms.tsx` | 303 | → /security |
| A8-075 | FindAPro | you@example.com | Input(email) | `src/pages/FindAPro.tsx` | 117 |  |
| A8-076 | FindAPro | 33101 | Input | `src/pages/FindAPro.tsx` | 121 |  |
| A8-077 | FindAPro | (icon/unlabeled Button) | Button | `src/pages/FindAPro.tsx` | 123 |  |
| A8-078 | FindAPro | change | Button | `src/pages/FindAPro.tsx` | 214 |  |
| A8-079 | FindAPro | Search name or specialty | Input | `src/pages/FindAPro.tsx` | 230 |  |
| A8-080 | FindAPro | (Select) | Select | `src/pages/FindAPro.tsx` | 233 | options: All trades, All states, Any rating, 3★+, 4★+, 4.5★+ |
| A8-081 | FindAPro | (Select) | Select | `src/pages/FindAPro.tsx` | 240 | options: All states, Any rating, 3★+, 4★+, 4.5★+ |
| A8-082 | FindAPro | (Select) | Select | `src/pages/FindAPro.tsx` | 247 | options: Any rating, 3★+, 4★+, 4.5★+ |
| A8-083 | FindAPro | Update Results | Button | `src/pages/FindAPro.tsx` | 255 |  |
| A8-084 | FindAPro | Contact this Pro | Button | `src/pages/FindAPro.tsx` | 329 |  |
| A8-085 | FindAPro | G View Google Reviews | Link | `src/pages/FindAPro.tsx` | 405 |  |
| A8-086 | FindAPro | ChecksOps home | Link | `src/pages/FindAPro.tsx` | 446 | → / |
| A8-087 | FindAPro | Privacy | Link | `src/pages/FindAPro.tsx` | 462 | → /privacy-notice |
| A8-088 | FindAPro | About ChecksOps | Link | `src/pages/FindAPro.tsx` | 463 | → / |

**Area 8 count: 88**

## Counts by area

- 1. Admin Tenants + admin/* (platform finance, referrals, announcements, manage tenant): **116**
- 2. AdminFinancialModel (+ PnlModel / SavingsCalculator): **20**
- 3. AdminMortgageOps: **16**
- 4. Tenant settings: **230**
- 5. Payments / WalletOps / Cash Jobs / DisbursementConsole: **313**
- 6. MortgageOpsQueue + MortgageOpsLogin: **21**
- 7. HomeownerCheckUpload / ClaimPortal / Ledger / Sign / Endorse / PaymentDirection: **128**
- 8. Public CheckOpsLanding / Login / Signup / Pricing / Security / Privacy / Terms / FindAPro: **88**

**Grand total: 932**

## Scope notes

- Repo file names: `AdminFinancialModel.tsx`, `AdminMortgageOps.tsx`, `CheckOpsLanding.tsx`, `FindAPro.tsx` (user aliases AdminFinancialModel / AdminMortgageOps / CheckOpsLanding / FindAPro).
- `CheckOpsLanding.tsx` has no own controls; marketing controls are under `CheckCenterMarketing.tsx`.
- `CashJobs.tsx` / `PaymentSettingsTab.tsx` are wrappers; controls live in composed components.
- `TenantMoovIdentityCard.tsx` and several compliance view files are display-only.
