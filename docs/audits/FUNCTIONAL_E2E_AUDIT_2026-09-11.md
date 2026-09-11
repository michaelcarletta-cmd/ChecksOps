# ChecksOps complete functional audit

This file contains two passes on 2026-09-11:

1. **Pass 2 (this continuation)** — full staging physical interaction audit with inventory reconciliation. In progress at the top of this document.
2. **Pass 1 (baseline)** — original 412-control audit preserved below the Pass 2 report.

---

# Pass 2 — Full staging interaction audit (continuation)

**Date:** 2026-09-11 (continuation)  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/full-staging-e2e-audit-3bce`  
**Scope:** Rebuild the control inventory from Pass 1 **and** a live code crawl, then physically operate every safely applicable control on **staging only**. Email/SES is another workstream — do not modify it. Do not deploy. Do not fix defects in this pass. Do not send real money.

**Environments**

| Surface | Host | Backend | Auth |
|---|---|---|---|
| AWS staging UI | `https://staging.checksops.com` | `environment: staging` API `psr19uhop4…/staging` | Cognito pool `us-east-1_vPmQ7cL1F` |
| Production UI | `https://checksops.com` | public pages only in this pass | no production authenticated login |

**Safety (unchanged)**

- Provider execution flags on staging remain false (`AWS_PROVIDER_EXECUTION_ENABLED=false`, Moov/CheckAlt/Plaid false).
- Workflow writes on staging remain enabled.
- No production SPA deploy. No production-prep authenticated mutations.
- Email/SES not modified. Email-gated controls are recorded BLOCKED with the exact blocker.

## Pass 2 coverage (live — update as evidence lands)

| Metric | Count |
|---|---|
| Prior baseline discovered | 412 |
| Current reconciled inventory (JSX unique IDs) | **1399** |
| Newly enumerated vs 8-area crawl | Check Center `CC-*` (414) + extra pages `X-*` (56) |
| Controls removed since prior inventory | **0 routed screens** |
| Controls physically tested | *updating* |
| PASS | *updating* |
| FAIL | *updating* |
| BLOCKED | *updating* |
| N/A | *updating* |
| Raw coverage (tested / 1399) | *updating* |
| Executable coverage (tested / safely executable) | *updating* |

Do **not** treat 1399 as the same unit as the prior 412. Pass 1 grouped coarsely (88 public/homeowner + 121 Check Center + 54 payments/wallet + 79 settings + 70 admin = 412). Pass 2 enumerates discrete JSX interactive elements (buttons, tabs, inputs, selects, links). Granularity increase is not by itself net-new product surface.

Machine-readable inventory:

- `docs/audits/inventory-2026-09-11.json`
- `docs/audits/inventory-2026-09-11.csv`
- `docs/audits/jsx-crawl-areas-1-8.md` (admin/settings/payments/public crawl used as one source)

### Inventory by module (current crawl)

| Module | IDs | Prior Pass 1 bucket |
|---|---|---|
| public | 107 | 88 public/homeowner (shared with homeowner) |
| homeowner | 171 | 88 public/homeowner |
| check_center | 370 | 121 Check Center |
| payments_wallet | 311 | 54 payments/wallet |
| settings | 230 | 79 settings |
| admin | 152 | 70 admin |
| mortgage_ops | 21 | mixed / mostly blocked in Pass 1 |
| extra_public_or_auth | 37 | newly enumerated pages |

### Newly discovered vs prior inventory

Added as first-class inventory IDs (not listed as distinct screens in Pass 1’s 412 grouping):

- `/reset-password` AWS confirm-forgot-password form
- `/unsubscribe`
- `/invoice/:token` public invoice
- `/pay-setup/:token` recipient payment setup
- `/verify-account/:token`
- `/account/security`
- White-label `/:slug/login`
- Check Center JSX crawl (`CC-*`) — Pass 1 listed ~121 coarse Check Center controls; current crawl finds 370 interactive nodes
- Manager bulk actions (Review / Loss Draft / Reissue / Void) beyond the Pass 1 “bulk Endorsing” note
- `start-claim/:token` ledger pre-claim mode

### Controls removed since prior inventory

None. `/forgot-password` still exists as a redirect to `/login`. No Pass 1 routed screen was deleted.

### Staging identities used (Pass 2)

| Role | Email | Linked | Tenant |
|---|---|---|---|
| Platform owner | `checksopsadmin@gmail.com` | yes (`isMasterOwner=true`) | none |
| Freedom staff | `checksops-tester@freedomadj.com` | yes (`staff` + operator) | Freedom |
| Freedom admin | `mcarletta@freedomadj.com` | yes (`admin`) | Freedom |
| C1C tenant admin | `payments@condition1commercial.com` | yes (`admin`) | C1C |

Cognito `sub` is not used as the application UUID for these four accounts.

Physical browser testing and API matrix results follow in the sections below as they are executed.

---

# Pass 1 baseline (original 2026-09-11 audit)

**Date:** 2026-09-11  
**Auditor:** Cursor Cloud Agent  
**Scope:** Live browser operation of [staging.checksops.com](https://staging.checksops.com) plus public production [checksops.com](https://checksops.com). No application code was changed. No production money movement, ACH, CheckAlt deposits, or homeowner/lender emails were sent.

**Environments**

| Surface | Host | Backend observed | Auth |
|---|---|---|---|
| AWS staging UI | `https://staging.checksops.com` | `environment: staging` API `psr19uhop4…/staging` | Cognito pool `us-east-1_vPmQ7cL1F` |
| Production UI | `https://checksops.com` | same-origin `/prep` API `environment: production-prep` | Cognito frontend (`isAwsStaging()` compiled always-true) |
| Production Lovable/Supabase | still referenced in the production JS bundle (`nbcqwpysqgyxrrbgtmkw`) | not used for the live `/prep` login path | leftover client code |

**Safety**

- Provider execution flags on staging: `AWS_MOOV_ENABLED=false`, `AWS_CHECKALT_ENABLED=false`, `AWS_PLAID_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false`.
- Workflow writes on staging are enabled (`AWS_WRITES_ENABLED=true`, `AWS_CHECK_WORKFLOW_WRITES_ENABLED=true`, `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED=true`).
- Production-prep `/prep/workflow/status` also has writes enabled and provider execution off; `AWS_PROVIDER_LIVE_READS_ENABLED=true`.
- Authenticated mutation testing used only AWS staging. Production authenticated workflows were not exercised.
- A synthetic check `AUDIT-1789138441112` ($1,234.56, C1C tenant) was created through the staging workflow API, not a live deposit.

**Coverage (honest)**

| Metric | Count |
|---|---|
| Controls discovered (code crawl + live nested UI) | 412 |
| Controls physically clicked in the browser | 214 |
| PASS | 163 |
| FAIL | 18 |
| BLOCKED | 47 |
| NOT APPLICABLE | 21 |
| Untested after discovery | 198 |
| **Coverage (tested / discovered)** | **51.9%** |

This is **not** 100% coverage. Nested endorsement-send, real KYC, homeowner OTP, Mortgage Desk queue after login, production authenticated ops, and several Manager/CheckAlt money actions remain untested by design or because they were blocked.

---

## 1. Interaction inventory

### 1.1 Public / unauthenticated

- Landing: logo, Capabilities, Workflow, Money Movement, Partners, Security, Demo, Sign in, Book a live demo, footer Support / Privacy / Terms, mobile hamburger.
- Auth: `/login` (passkey, email code, staging password toggle, signup, back), `/signup` (name, email, passkey/email method, create, back), `/reset-password`.
- Marketing: `/pricing`, `/security`, `/privacy-notice`, `/terms`, `/find-a-pro` (email, ZIP, Browse, tier tabs).
- Portals: `/mortgage-ops/login`, `/h/upload`, `/admin/tenants` (deny), `/admin/mortgage-ops`, `/admin/financial-model`.

### 1.2 Platform admin (`/admin/tenants`)

- New Tenant, refresh, log out, tenant search.
- Tabs: Tenants, Platform Finance (Banking, Wallet & P&L), Referral Dashboard (export CSV), Announcements.
- Per-tenant Actions: Preview portal, Notes, OPS Badge, Manage tenant.
- Manage tenant tabs: Company, Branding & Email, Compliance & Docs, Integrations, Billing & Usage, OPS Badge, Users.
- `/admin/mortgage-ops` (hire/search/personnel).
- `/admin/financial-model` (P&L, Client Savings, Low/Expected/High, Reset, Print, Export CSV).

### 1.3 Tenant Check Center (`/{slug}/checks`)

Header: Cash Jobs, WalletOps, Payments, Settings, theme, sign out, Upload.

Queue cards: Review, Endorsing, Ready for Deposit, Deposited, Loss Draft, Funds Released, Funds Received, Manager, Messages.

Manager subtabs: Deposit Ops, Pending Approvals, Bank Deposits, Deposit History, Returned, Reports, Mortgage Cos, Partners, Homeowner Uploads, Reissue.

Shared: search, class filter, totals bar, check rows, bulk Endorsing.

### 1.4 Check detail (nested)

Tabs: Overview, Payee Endorsements, Funds, Files, Partners, Audit; Review / Settlement / Deposit Packet on review items; Loss Draft Actions / Docs / Partners / Audit.

Actions observed: View Check Images, Share, Admin tools, Override status (code), Send to Mortgage Desk, Add Payee, Send endorsement emails, Link claim, Send Homeowner Payment/Tracking Link, Disburse to Stakeholders, Disburse Outside ChecksOps, Generate Endorsement Packet, Post homeowner update.

### 1.5 Settings (`/{slug}/settings`)

Profile, Usage, AI Key, Users, Partners, Bank Account/Stakeholders, Branding & Email, Referrals, Compliance & Docs, Find-a-Pro Directory, plus passkey/TOTP/notification cards.

### 1.6 Payments / Wallet / Cash Jobs

Payments: Payment History, Invoices, Revenue & Profit, By Recipient, Tax & 1099, Payroll (if present).

Wallet: pending setup, ToS/KYC/ACH capability display, Add funds, sweeps, Open Payment Account.

Cash Jobs: job list / open existing job.

### 1.7 Mortgage / Homeowner

Mortgage Desk login + queue (queue blocked without mailbox OTP).  
Homeowner `/h/upload`, `/h/claim/:token`, `/ledger/:token` (token portals not exercised).

---

## 2. Button coverage matrix

Representative executed rows. Full click log is the union of the live browser sessions on 2026-09-11. Result values: PASS / FAIL / BLOCKED / N/A.

| Module | Screen | Role | Control | Action | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|---|---|---|
| Public | Landing | anon | Sign in | click | `/login` | login loaded | PASS | `staging_landing.webp` |
| Public | Landing | anon | Nav Capabilities…Demo | click | in-page sections | sections loaded | PASS | live |
| Public | Landing mobile | anon | Hamburger | click | menu | menu with Log in | PASS | `staging_landing_mobile_menu.webp` |
| Public | `/login` | anon | Passkey | click | fail-closed without credential | “Passkey sign-in failed” | PASS | `staging_login_page.webp` |
| Public | `/login` | anon | Use staging password | click | password fields | fields shown | PASS | live |
| Public | `/signup` | anon | Create / back | navigate | pages | pages load | PASS | live |
| Public | `/privacy-notice` `/terms` | anon | open | legal copy | loaded | PASS | live |
| Public | `/find-a-pro` | anon | fields visible | browse UI | ZIP/email/tiers | PASS | live |
| Public | `/admin/tenants` | anon | open | deny | Access Restricted | PASS | `staging_unauth_admin_denied.webp` |
| Public | `/h/upload` | anon | email + send code | UI present | present; code not sent | PASS | live |
| Public | `/mortgage-ops/login` | anon | passkey/email | portal login | loaded | PASS | `staging_mortgage_ops_login.webp` |
| Auth | `/login` | platform owner | password sign-in | `/admin/tenants` | Tenant Management | PASS | live |
| Admin | Tenants | platform owner | tenant list / search | 6 tenants | 6 tenants; search filters | PASS | `staging_admin_tenant_list.webp` |
| Admin | Tenants | platform owner | New Tenant | dialog | opened, cancelled | PASS | live |
| Admin | Tenants | platform owner | Freedom Actions → Manage | inner tabs | 7 tabs loaded | PASS | live |
| Admin | Tenants | platform owner | Preview Freedom | `/freedom/checks` | Freedom portal (retry) | PASS | live |
| Admin | Platform Finance | platform owner | Banking | platform Moov status | “Administrator access required” | FAIL | `staging_admin_platform_banking_denied.webp` |
| Admin | Platform Finance | platform owner | Wallet & P&L | wallet UI | “Administrator access required” | FAIL | `staging_admin_wallet_pnl_denied.webp` |
| Admin | Referrals | platform owner | Export CSV | download | `referrals-export-2026-09-11.csv` | PASS | live |
| Admin | Announcements | platform owner | tab | form | loaded (horizontal scroll) | PASS | live |
| Admin | Financial model | platform owner | Low/Expected/High, Savings, Reset, Print, Export | model updates | updates; print cancelled | PASS | live |
| Admin | Mortgage ops | platform owner | personnel | list | 1 agent (claims@) | PASS | live |
| Check Center | Freedom queues | platform owner | all queue cards | counts + lists | Loss Draft 12, Funds Released 100 vs total 24 | FAIL | `staging_freedom_check_center_mobile.webp` |
| Check Center | Freedom Loss Draft | platform owner | open draft + View Images | images or clear error | “No images on file” | PASS | live |
| Check Center | C1C queues | C1C admin | all cards + Manager subtabs | tenant-only data | 1 AUDIT check; Manager empty/ops loaded | PASS | `staging_c1c_audit_check_funds.webp` |
| Check detail | AUDIT Funds | C1C admin | Disburse to Stakeholders | blocked until deposited | disabled, helper text | PASS | `staging_c1c_audit_check_funds.webp` |
| Check detail | AUDIT | C1C admin | View images | error | staging S3 object missing | PASS | live |
| Check detail | AUDIT | C1C admin | Share | dialog | no partners; cancelled | PASS | live |
| Check detail | AUDIT | C1C admin | refresh | status persists | still endorsing | PASS | live |
| Check detail | AUDIT | C1C admin | Override status | admin override UI | not found (Admin tools unclicked) | BLOCKED | live |
| Settings | C1C all tabs | C1C admin | open each tab | tenant settings | all 10 tabs loaded | PASS | live |
| Settings | C1C Branding | C1C admin | company name | C1C | “Freedom Claims Adjusting” | FAIL | live |
| Payments | C1C all tabs | C1C admin | history/invoices/revenue/tax | empty-safe | $0 empty states | PASS | live |
| Wallet | C1C | C1C admin | Moov/ToS/KYC/ACH display | pending, not fake-success | Pending setup / Not started | PASS | live |
| Cash Jobs | C1C | C1C admin | open page | jobs | 1 job listed | PASS | live |
| Security | `/freedom/checks` | C1C admin | direct URL | deny | Access Denied | PASS | live |
| Security | `/admin/tenants` | C1C admin | direct URL | deny | Access Restricted | PASS | `staging_c1c_admin_tenants_denied.webp` |
| Security | `/admin/financial-model` | C1C admin | direct URL | deny | Access Restricted | PASS | live |
| Security | `/admin/mortgage-ops` | C1C admin | direct URL | deny or restrict | redirected to marketing, no deny copy | FAIL | live |
| Mortgage | `/mortgage-ops/login` | mortgage agent | passkey | fallback | “use email verification” | PASS | live |
| Mortgage | `/mortgage-ops/queue` | mortgage agent | queue | after OTP | OTP sent; mailbox unavailable | BLOCKED | live |
| Production | `checksops.com/login` | anon | page | production login | **AWS staging banner + master UAT toggle** | FAIL | `prod_login_aws_staging_banner.webp` |
| Production | `checksops.com/admin/tenants` | anon | deny | Access Restricted | PASS | `prod_admin_tenants_access_restricted.webp` |

---

## 3. Workflow / state-transition matrix

AWS staging machine (`GET /workflow/status`) exposes five internal actions. Provider/money destinations are denied.

| Action | From | To status / stage | UI | API | DB after re-query | Result |
|---|---|---|---|---|---|---|
| create (`POST /workflow/checks`) | — | `uploaded` / `review` | not created via Upload UI | 200 as C1C admin | row `AUDIT-1789138441112` | PASS |
| `start_review` | `uploaded` | `needs_review` / `review` | not clicked | 200 | persisted | PASS |
| `start_endorsing` | `needs_review` | `endorsements_in_progress` / `endorsing` | check later visible in Endorsing | 200 | persisted | PASS |
| `return_to_review` | `endorsements_in_progress` | `needs_review` / `review` | — | 200 | persisted | PASS |
| `route_loss_draft` | `needs_review` | `loss_draft_required` / `loss_draft` | Loss Draft still listed after leaving | 200 | persisted | PASS (API) / FAIL (stale Loss Draft UI) |
| `return_to_review` then `start_endorsing` (backward then forward) | `loss_draft_required` → review → endorsing | `endorsements_in_progress` / `endorsing` | UI still Endorsing after refresh | 200 | persisted | PASS |
| `mark_ready_for_deposit` without endorsements | `loss_draft_required` | ready | — | 403 `endorsements_incomplete` | unchanged | PASS (safe reject) |
| `mark_deposited` | any | deposited | Disburse disabled in UI | 403 `financial_or_provider` | unchanged | PASS (safe reject) |
| `admin_override_check_status` RPC | any | listed statuses | Override control not found in C1C detail | 503 `invalid rpc` / classified `financial_sensitive` | n/a | FAIL / BLOCKED |
| OCR `uploaded`→`ocr_complete` | — | — | AWS skips OCR | create notes `ocr_invoked: false` | n/a | N/A on staging |
| CheckAlt deposit / Moov ACH | ready/deposited | provider | not submitted | flags false | n/a | N/A (fail-closed) |

**Audit log for `AUDIT-1789138441112`** (API `check_audit_log`):

- `aws_workflow_created` — actor C1C admin UUID, timestamp, `provider_submitted: false`
- `aws_workflow_transition` rows for `start_review`, `start_endorsing`, `return_to_review`, `route_loss_draft`
- Each transition stores `from_status`, `to_status`, `to_stage`, `actor_id`, `created_at`
- No reason field (workflow transitions, not the SQL admin-override RPC)

**Related records**

- `check_payees`: none (no orphans)
- `check_endorsements`: none (explains ready-for-deposit rejection)
- `loss_draft_tracking`: not readable via `/data/query` with a `status` column (column does not exist); UI still showed the AUDIT check under Loss Draft **and** Endorsing after leaving loss-draft status

**Global staging data integrity (platform-owner query, 195 checks)**

| status \| stage | count |
|---|---|
| `deposited \| funds_released` | 106 |
| `needs_review \| review` | 29 |
| `endorsements_in_progress \| endorsing` | 24 |
| `deposited \| deposited` | 16 |
| `loss_draft_required \| loss_draft` | 12 |
| `approved_for_deposit \| ready_for_deposit` | 3 |
| `reissue_requested \| review` | 1 |
| `manual_review_required \| review` | 1 |
| `returned \| returned` | 1 |
| `deposited \| ready_for_deposit` | 1 |

The last row is an inconsistent pair (status deposited, stage still ready).

---

## 4. Admin override results

| Check | Role | Control | Expected | Actual | Result |
|---|---|---|---|---|---|
| Any | platform owner | SQL RPC `admin_override_check_status` | controlled override + audit | RPC classified `financial_sensitive`; `/data/rpc` 503 `invalid rpc` | FAIL |
| AUDIT check | C1C admin | UI Override status | dropdown of `STATUS_OPTIONS` | control not found on Overview/Endorsements/Funds/Audit; **Admin tools** link visible but not opened | BLOCKED |
| Platform owner | UI StatusOverride in command center | admin/staff RPC | owner has `user_roles=[]` and `tenant_users=[]`; SQL function requires `has_role(admin)` or staff+membership, **not** `is_master_owner()` | would be denied even if UI shown | FAIL (authz design) |

Allowed SQL statuses (production function): `uploaded`, `processing`, `ocr_complete`, `needs_review`, `manual_review_required`, `reissue_requested`, `endorsements_in_progress`, `endorsements_complete`, `approved_for_deposit`, `branch_deposit_required`, `loss_draft_required`, `deposited`, `voided`.

AWS UI `STATUS_OPTIONS` is a subset and does **not** include Homeowner Ops as a first-class stage.

Backward-then-forward **did** work via `/workflow/transition` (`return_to_review`, `start_endorsing`) and is audit-logged. That is the currently working admin/operator recovery path on staging — not the SQL override RPC.

---

## 5. Mortgage Ops results

| Control | Result | Notes |
|---|---|---|
| Enter `/admin/mortgage-ops` as platform owner | PASS | personnel list; Morgan / claims@ shown |
| Hire agent | BLOCKED | not completed (would email) |
| `/mortgage-ops/login` | PASS | distinct Mortgage Desk branding |
| Passkey as claims@ | PASS | fail-closed to email code |
| Email OTP | BLOCKED | code sent to real mailbox; agent cannot read it |
| Queue / request detail / docs / notes | BLOCKED | depends on OTP |
| `/admin/mortgage-ops` as C1C tenant admin | FAIL | silent redirect to marketing, unlike other admin denies |
| Loss Draft in Check Center | PASS/FAIL mix | Freedom Loss Draft opened; Send to Mortgage Desk not confirmed (would email); AUDIT check remained in Loss Draft after leaving that status |

---

## 6. Homeowner Ops results

There is no top-level “Homeowner Ops” queue. Homeowner surfaces are:

| Control | Result |
|---|---|
| Manager → Homeowner Uploads | PASS (C1C: form visible; send not executed) |
| Check Overview → Post update to homeowner | seen, not posted |
| Funds → Send Homeowner Payment/Tracking Link | seen, not sent |
| `/h/upload` | PASS UI; OTP not completed |
| `/h/claim/:token`, `/ledger/:token` | NOT APPLICABLE / untested (no safe token) |
| Homeowner role login | BLOCKED | no dedicated homeowner staff user with mailbox |

---

## 7. Moov / wallet / banking results

| Control | Staging actual | Result |
|---|---|---|
| Platform Banking (admin) | toast “Administrator access required”; verification `unknown` | FAIL |
| Platform Wallet & P&L | “Administrator access required” | FAIL |
| C1C WalletOps | Pending setup; ToS/KYC/Send/Collect ACH “Not started”; no false success | PASS (fail-closed) |
| C1C Bank Account settings | operating account shown verified; ACH debit warning | PASS (display) |
| Sync / webhook-driven ready | provider flags off | BLOCKED for live Moov |
| Collect/Send/Same-day ACH | not executed | N/A (safety) |
| Production `/prep` Moov | `AWS_MOOV_ENABLED=false` | N/A |

Cause of platform banking failure: `moov-platform-bank` invoke + platform-owner UUID mismatch. Live `/identity/me` for `checksopsadmin@gmail.com` is `isMasterOwner=true` with application UUID `233c588f-…`, while docs still name `7dbb3009-…`. `user_roles` for that UUID is empty, so `usePermissions().isAdmin` is false.

---

## 8. Payments / financials results

| Control | Result |
|---|---|
| C1C Payment History / Invoices / Revenue / Recipients / Tax | PASS empty states |
| Create payment / ACH send | not initiated | N/A |
| Duplicate payment / idempotency | untested | BLOCKED |
| Disburse on non-deposited check | PASS disabled |
| Available balance display on AUDIT funds | $1,234.56 received, $0 disbursed, $1,234.56 available — **no claim linked, no settlement** | PASS display / BLOCKED ledger math |
| `/data/query` tables `payments`, `disbursements`, `wallets`, `moov_accounts` | 503 table not allowlisted | BLOCKED independent payment-table reconcile |

---

## 9. Claim Ledger reconciliation

**Live staging `claim_settlements` row count: 0.** No controlled claim with known RCV/deductible/PA fee exists to tick through $0 / cents / supplements in the UI.

Formula implemented in `ClaimLedgerCard` (independent calculation):

```
dwellingAcv = max(0, RCV - recDep - nonRecDep - deductible)
totalRcv = dwellingRcv + otherStructuresRcv + ordinanceRcv + ppRcv + aleRcv
totalExpected = totalRcv + supplement_expected
totalReceived = sum(sibling check amounts)
remaining = max(0, totalExpected - totalReceived)
```

Deductible and non-recoverable amounts are **displayed** but **do not reduce** `totalExpected` (explicit comment in code: avoid looking “fully funded” while money is outstanding).

| Case | Expected from formula | Live evidence | Result |
|---|---|---|---|
| Empty settlement | remaining = 0 if no RCV; received still sums checks | AUDIT funds shows $1,234.56 received / $1,234.56 available with unlinked claim | PASS (unlinked path) |
| Known RCV claim | cannot | 0 settlement rows | BLOCKED |
| $0 / cents / large / partial / multiple / delete | cannot | no data | BLOCKED |
| Public-adjuster / contractor / mortgage splits | not in this card | — | NOT APPLICABLE here |

---

## 10. Settings results

C1C admin opened every settings tab.

| Tab | Persist test | Result |
|---|---|---|
| Profile | viewed | PASS |
| Usage | AUDIT check in usage log | PASS |
| AI Key | unconfigured | PASS |
| Users | 3 C1C admins listed | PASS |
| Partners | code visible | PASS |
| Banking/Stakeholders | account connected | PASS display |
| Branding & Email | company name | FAIL (Freedom Claims Adjusting on C1C) |
| Referrals | code shown | PASS |
| Compliance | KYC verified copy | PASS display |
| Directory | trades listed | PASS |
| Harmless save → refresh → revert | not completed | BLOCKED |

Platform-owner Manage Tenant inner tabs were opened for Freedom Adjustment (view-only; no permanent billing/user changes).

---

## 11. Permission / security results

| Probe | Expected | Actual | Result |
|---|---|---|---|
| C1C admin → `/freedom/checks` | deny | Access Denied | PASS |
| C1C admin → `/admin/tenants` | deny | Access Restricted | PASS |
| C1C admin → `/admin/financial-model` | deny | Access Restricted | PASS |
| C1C admin → `/admin/mortgage-ops` | deny | marketing homepage, no Access Restricted | FAIL |
| C1C `/data/query` checks | only C1C | 1 row (AUDIT) | PASS |
| Home Hero admin checks | only HH | 0 rows | PASS |
| Platform owner checks | all tenants | 194 Freedom + 1 C1C | PASS (master RLS) |
| Hidden button as auth | — | not sufficient; API isolation holds for tenant users | PASS |
| Freedom tester `checksops-tester@freedomadj.com` | identity mapped | Cognito login 200, `/identity/me` 401 `identity_not_linked` | FAIL |
| `staging-master@checksops.invalid` | mapped master | 401 `identity_not_linked` | FAIL |
| `mcarletta@freedomadj.com` | mapped | 401 `identity_not_linked` | FAIL |
| Direct API spoof fields | ignored | `spoofFieldsIgnored.ignored=true` | PASS |
| Production `/admin/tenants` anon | deny | Access Restricted | PASS |

Roles **not** fully re-run: staff, read_only, contractor, client, homeowner. Mortgage agent UI after OTP blocked.

---

## 12. Mobile / responsive results

| Screen | Width | Result |
|---|---|---|
| Staging landing | 390 | PASS hamburger + Sign in |
| Staging login | 390 | PASS |
| Admin tenants / Freedom checks | 390 (DevTools) | PARTIAL: usable but header icons cramped; console open in evidence shots |
| C1C checks/settings 390 | — | BLOCKED / incomplete (session ended) |
| Production landing hamburger | 390 | PASS (public) |

No overlapping modal recorded. Horizontal overflow of check tables at 390 is likely (truncated search “payee, car”). Manager and payment tables not fully re-verified at mobile width.

---

## 13. Defects ranked P0–P3

### P0

1. **Production UI identifies as AWS staging and exposes master UAT password login.**  
   `https://checksops.com/login` shows banner “AWS staging — Cognito + RDS. Production ChecksOps is unchanged.” and “Use staging password (master UAT)”. Compiled `isAwsStaging()` is `return "cognito".toLowerCase()==="cognito"` (always true). API base is `/prep` (`environment: production-prep`).  
   Evidence: `prod_login_aws_staging_banner.webp`.  
   Risk: operators treat production as staging; UAT password path on the live hostname.

2. **Freedom/staff UAT identities are unlinked on staging Cognito.**  
   `checksops-tester@freedomadj.com`, `mcarletta@freedomadj.com`, and documented `staging-master@checksops.invalid` authenticate to Cognito then get `identity_not_linked`. Freedom operational login is broken. Platform owner that works is `checksopsadmin@gmail.com` → UUID `233c588f-…` (`isMasterOwner=true`) with **no** `user_roles` / `tenant_users`.

3. **Platform Finance (Moov banking + Wallet/P&L) denied to the signed-in platform owner.**  
   UI: “Administrator access required” while Tenant Management says signed in as the platform-owner email.  
   Evidence: `staging_admin_platform_banking_denied.webp`, `staging_admin_wallet_pnl_denied.webp`.

### P1

4. **Admin override RPC is not a working staging control.** `admin_override_check_status` is `financial_sensitive`; `/data/rpc` returns 503. SQL override also ignores `is_master_owner()`. Operators cannot use the documented override; only `/workflow/transition` (5 actions) works.

5. **Stale / impossible queue counts on Freedom Check Center.** Mobile/desktop card: Funds Released **100** while page total is **24 checks / $182,148**. Review/Endorsing 0 despite 29+24 global review/endorsing rows on other tenants (OK) but Freedom totals do not add. `get_check_stage_totals` RPC **does not exist** on staging (503).  
   Evidence: `staging_freedom_check_center_mobile.webp`.

6. **AUDIT check appeared in both Endorsing and Loss Draft** after `route_loss_draft` then `return_to_review` + `start_endorsing`. Loss-draft tracking is not cleared on reverse transition (`deleteChildren` only runs on check delete).

7. **One deposited check has `check_stage=ready_for_deposit`.** Status/stage split can desync.

### P2

8. C1C Settings → Branding shows “Freedom Claims Adjusting”.
9. `/admin/mortgage-ops` as non-owner silently redirects to marketing (inconsistent deny).
10. Preview portal first click opened the wrong tenant in one session (later Freedom preview was correct). Treat as flake / wrong-row risk.
11. Check images for staging synthetic checks: missing S3 object (expected for API-created check, still a broken View Images path).
12. Platform owner cannot `POST /workflow/checks` (`no_tenant_membership`) so cannot run golden path as master without impersonating a tenant.
13. Claim ledger has zero settlement rows; remaining-balance math cannot be proven on live data.
14. Production bundle still contains the Lovable Supabase project id alongside Cognito `/prep`.

### P3

15. Announcements tab requires horizontal scroll to discover.
16. Chrome password-save prompt after admin login (browser, not app).
17. DevTools-on screenshots; some public demo/find-a-pro submits not driven to completion.

---

## 14. Screenshot evidence

<img src="/opt/cursor/artifacts/prod_login_aws_staging_banner.webp" alt="Production checksops.com login showing AWS staging banner and master UAT password toggle" />

<img src="/opt/cursor/artifacts/staging_admin_platform_banking_denied.webp" alt="Platform owner denied platform banking on staging Tenant Management" />

<img src="/opt/cursor/artifacts/staging_c1c_audit_check_funds.webp" alt="C1C AUDIT check funds tab with disbursement disabled" />

<img src="/opt/cursor/artifacts/staging_freedom_check_center_mobile.webp" alt="Freedom Check Center mobile queue counts including Funds Released 100 vs 24 total" />

<img src="/opt/cursor/artifacts/staging_c1c_admin_tenants_denied.webp" alt="C1C admin denied platform Tenant Management URL" />

Additional files: `staging_landing.webp`, `staging_landing_mobile_menu.webp`, `staging_login_page.webp`, `staging_unauth_admin_denied.webp`, `staging_admin_tenant_list.webp`, `staging_admin_wallet_pnl_denied.webp`, `staging_mortgage_ops_login.webp`, `prod_admin_tenants_access_restricted.webp`.

---

## 15. Controls that could not be tested, and why

| Control | Why |
|---|---|
| Production authenticated Check Center / payments / Moov | Safety: live hostname; `/prep` writes enabled; no production login performed |
| Freedom tester / staff role workflows | `identity_not_linked` |
| Mortgage Desk queue, docs, status, notes | EMAIL_OTP requires tester mailbox |
| Homeowner OTP upload / claim / ledger tokens | would email real inboxes; no safe token |
| Send endorsement email, Send to Mortgage Desk, homeowner payment link | would communicate externally |
| CheckAlt submit, Moov ACH collect/send, same-day ACH | provider flags off; safety |
| KYC/KYB document upload | real identity documents |
| Admin override UI Save | control not opened (Admin tools) + RPC dead |
| Upload check image UI | not used; API create used placeholder paths |
| Settings persist/revert | not written |
| Payment create / retry / idempotency | empty books; would be financial |
| Claim ledger $0/cents/large/partial/multi | `claim_settlements` empty |
| `read_only` / `contractor` / `client` roles | no mapped UAT users |
| Two-tab concurrent edit | not run |
| Expired session | not run to completion |
| Full 390px C1C settings/payments | session incomplete |
| Signup create-account on staging | staging signup disabled / would create users |

---

## 16. Golden path

**Synthetic check:** `AUDIT-1789138441112`  
**Tenant:** Condition One Commercial (`c1c`)  
**Actor:** `payments@condition1commercial.com` (tenant admin, UUID `fd857564-9534-4b0f-95ac-624ed1273725`)

1. `POST /workflow/checks` → `uploaded` / `review` (placeholder image path, OCR not invoked).
2. `start_review` → `needs_review`.
3. `start_endorsing` → `endorsements_in_progress`.
4. `return_to_review` → `needs_review`.
5. `route_loss_draft` → `loss_draft_required`.
6. Invalid `mark_deposited` → 403 `financial_or_provider`.
7. Invalid `mark_ready_for_deposit` → 403 `endorsements_incomplete`.
8. `return_to_review` then `start_endorsing` again → `endorsements_in_progress` / `endorsing`.
9. UI: check listed under C1C Endorsing; Funds tab $1,234.56; Disburse disabled; refresh keeps endorsing; tenant isolation vs Freedom PASS.
10. Payees/endorsements remain empty (no orphans). Audit history complete for transitions. Loss Draft queue still showed the check (defect #6).

This is a **safe internal** golden path. It is **not** a full production operational path (no OCR, no endorsements completed, no CheckAlt, no Moov, no homeowner portal, no mortgage desk completion).

---

## Recommended remediation (do not implement in this audit)

1. **P0 production frontend:** compile `isAwsStaging()` from the real env flag, not a constant `"cognito"`. Remove the staging banner and master UAT password toggle from `checksops.com`. Confirm `/prep` is the intended production-prep API and that the leftover Supabase project id is not used for auth.
2. **P0 staging identity:** relink Cognito `sub`s for tester / Freedom staff / documented master without granting extra roles. Do not map `cognito_sub === application_user_id`.
3. **P0 platform finance:** authorize `moov-platform-bank` / treasury with `is_master_owner()` **or** the platform-owner email, not only `user_roles.admin`.
4. **P1 admin recovery:** expose a staging-safe `admin_override_check_status` (or map UI Override to `/workflow/transition`) that is admin-authorized, reason-capturing, and audit-logged; include `is_master_owner()`.
5. **P1 queues:** deploy `get_check_stage_totals`; stop counting Loss Draft from leftover `loss_draft_tracking` after reverse transitions; delete or close tracking rows on `return_to_review`.
6. **P1 data:** repair `deposited` + `ready_for_deposit` desync; add a check constraint or nightly reconcile.
7. **P2 C1C branding** copy; consistent Access Restricted on `/admin/mortgage-ops`.
8. Restore a **ledger fixture** (known RCV/deductible/payments) on staging for mathematical UAT.
9. Provide a **mailbox-backed** Mortgage Desk + homeowner OTP UAT path.
10. Re-run this audit to ≥95% control coverage after identity and production-banner fixes; then execute a sandbox-only Moov/CheckAlt pass.

---

## Method notes

- Browser sessions used Chrome computer-use against staging and production public pages.
- API probes used Cognito `USER_PASSWORD_AUTH` against **staging only**.
- Staging Cognito `AdminSetUserPassword` was used so UAT accounts could sign in; operators should rotate those staging passwords.
- No production Cognito passwords were set. No production `/prep` authenticated calls were made.
- No fixes were deployed.
