# ChecksOps complete functional audit

This file contains two passes on 2026-09-11:

1. **Pass 2 (this continuation)** — inventory reconciliation plus physical staging interaction. Results are at the top.
2. **Pass 1 (baseline)** — original 412-control audit preserved below.

**Verdict: CONDITIONAL GO** for C1C tenant-admin and platform-owner staging workflows. **NO-GO** for Freedom admin identity (`identity_not_linked`) and for treating production `checksops.com` as a clean production SPA (Pass 1 P0 banner still unreleased). This is **not** 95% or 100% control coverage.

---

# Pass 2 — Full staging interaction audit (continuation)

**Date:** 2026-09-11 (continuation)  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/full-staging-e2e-audit-3bce`  
**PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/237  
**Scope:** Rebuild the control inventory from Pass 1 **and** a live code crawl, then physically operate applicable controls on **staging only**. Email/SES is another workstream — not modified. No production deploy. No defect fixes. No real money.

**Environments**

| Surface | Host | Backend | Auth |
|---|---|---|---|
| AWS staging UI | `https://staging.checksops.com` | `environment: staging` API `psr19uhop4…/staging` | Cognito pool `us-east-1_vPmQ7cL1F` |
| Production UI | `https://checksops.com` | public pages from Pass 1 only | no production authenticated login this pass |

**Safety (unchanged)**

- Provider flags: `AWS_PROVIDER_EXECUTION_ENABLED=false`, Moov/CheckAlt/Plaid/Actum false.
- Workflow writes on staging enabled.
- No production SPA deploy. No `/prep` authenticated mutations.
- Email/SES not modified. Email-gated controls recorded BLOCKED.

## Pass 2 coverage (honest)

| Metric | Count |
|---|---|
| Prior baseline discovered (coarse) | 412 |
| Current reconciled inventory (JSX unique IDs) | **1399** |
| Newly enumerated vs 8-area crawl | Check Center `CC-*` (414) + extra pages `X-*` (56) |
| Controls removed since prior inventory | **0 routed screens** |
| Controls physically clicked this pass | **168** |
| PASS | **142** |
| FAIL | **8** |
| BLOCKED | **14** |
| N/A | **4** |
| Untested after discovery | **1231** |
| **Raw coverage (168 / 1399)** | **12.0%** |
| Safety-class executable IDs (`executable_or_ui` + `executable`) | 1261 |
| **Executable coverage (168 / 1261)** | **13.3%** |

Do **not** treat 1399 as the same unit as the prior 412. Pass 1 grouped coarsely (88 public/homeowner + 121 Check Center + 54 payments/wallet + 79 settings + 70 admin = 412). Pass 2 enumerates discrete JSX nodes. Opening a Settings tab is one physical operation; it does not mark all 230 settings inputs PASS.

Machine-readable inventory: `docs/audits/inventory-2026-09-11.json`, `.csv`, `docs/audits/jsx-crawl-areas-1-8.md`.

API evidence: `/opt/cursor/artifacts/c1c_workflow_retry.json`, `/opt/cursor/artifacts/staging_e2e_api_audit.json`.

### Inventory by module (current crawl)

| Module | IDs | Prior Pass 1 bucket | This pass physically exercised |
|---|---|---|---|
| public | 107 | 88 public/homeowner | landing, login, signup, reset-password, pricing, find-a-pro, unauth denies, invalid tokens |
| homeowner | 171 | 88 public/homeowner | `/h/upload` UI; existing `/ledger/:token` view-only; Sign/Pay not completed |
| check_center | 370 | 121 Check Center | C1C queues/detail/override/manager; Freedom staff queues |
| payments_wallet | 311 | 54 payments/wallet | C1C payment tabs + wallet cancel-add-funds + cash-jobs list |
| settings | 230 | 79 settings | all C1C tabs opened; persist/revert **not** completed |
| admin | 152 | 70 admin | owner tenants/finance/model/mortgage-ops view; New Tenant cancelled |
| mortgage_ops | 21 | mixed | login fail-closed; queue **BLOCKED** (OTP); hire not clicked |
| extra_public_or_auth | 37 | newly enumerated | `/unsubscribe`, invalid invoice/pay-setup/sign/endorse |

### Newly discovered vs prior inventory

- `/reset-password`, `/unsubscribe`, `/invoice/:token`, `/pay-setup/:token`, `/verify-account/:token`, `/account/security`, `/:slug/login`, `/start-claim/:token`
- Check Center JSX crawl (`CC-*`): 370 nodes vs Pass 1’s 121 coarse controls
- Manager bulk Review / Loss Draft / Reissue / Void (beyond Pass 1 bulk Endorsing)

### Controls removed since prior inventory

None. `/forgot-password` still redirects to `/login`.

### Staging identities (end of Pass 2)

| Role | Email | Cognito login | `/identity/me` | Tenant |
|---|---|---|---|---|
| Platform owner | `checksopsadmin@gmail.com` | 200 | 200 `isMasterOwner=true` | none |
| Freedom staff | `checksops-tester@freedomadj.com` | 200 | 200 staff + Freedom operator | Freedom |
| Freedom admin | `mcarletta@freedomadj.com` | 200 | **401 `identity_not_linked`** | — |
| C1C tenant admin | `payments@condition1commercial.com` | 200 | 200 admin | C1C |

Cognito `sub` ≠ application UUID for the three linked accounts. Freedom admin **was linked at the start of this pass** and is unlinked now — record as a regression, not a Pass 1 leftover.

---

## 2. Physical click matrix (representative)

Result values: PASS / FAIL / BLOCKED / N/A. Source-code existence is never PASS.

| Module | Control | Role | Result | Evidence |
|---|---|---|---|---|
| Public | Landing nav Capabilities…Demo | anon | PASS | live + `staging_landing.webp` |
| Public | Demo form fill; submit skipped | anon | BLOCKED | email/SES workstream |
| Public | `/login` passkey fail-closed | anon | PASS | live |
| Public | Staging password toggle | anon | PASS | `staging_login_password_toggle.webp` |
| Public | `/signup` method radios + back | anon | PASS | live |
| Public | `/reset-password` fields | anon | PASS | live |
| Public | `/find-a-pro` ZIP/filters; Contact skipped | anon | PASS / BLOCKED | `staging_find_a_pro.webp` |
| Public | `/h/upload` fields; OTP not sent | anon | PASS / BLOCKED | `staging_h_upload.webp` |
| Public | `/mortgage-ops/login` passkey fail-closed | anon | PASS | `staging_mortgage_ops_login.webp` |
| Public | `/unsubscribe` missing token | anon | PASS | live |
| Public | Invalid `/ledger` `/h/claim` `/endorse` `/sign` | anon | PASS | `staging_invalid_ledger_token.webp` |
| Public | Invalid `/invoice` `/pay-setup` | anon | FAIL (P3) | UI shows `missing_cognito_token` |
| Public | Unauth `/admin/tenants` `/admin/financial-model` | anon/C1C | PASS | Access Restricted |
| Public | Unauth `/admin/mortgage-ops` | anon | PASS | landing + Not authorized toast |
| Auth | C1C password login | C1C admin | PASS | `/c1c/checks` |
| Check Center | C1C queues | C1C admin | PASS | Endorsing 2, Deposited 3, Manager 7; `c1c_check_center_queues.webp` |
| Check Center | E2E-1789149838411 tabs | C1C admin | PASS | Overview/Endorsements/Funds/Files/Partners/Audit |
| Check Center | Admin override Review then Endorsing | C1C admin | PASS | `c1c_e2e_override_audit.webp` |
| Check Center | Disburse on non-deposited | C1C admin | PASS | disabled / not submitted |
| Manager | All 10 subtabs | C1C admin | PASS | live |
| Settings | All 10 C1C tabs | C1C admin | PASS (open) | Branding company **Freedom Claims Adjusting** |
| Settings | Harmless save → refresh → revert | C1C admin | BLOCKED | not written |
| Payments | History/Invoices/Revenue/Recipients/Tax | C1C admin | PASS | $0 empty states |
| Wallet | Add funds opened then cancelled | C1C admin | PASS | fail-closed, no ACH |
| Cash Jobs | List + estimate | C1C admin | PASS | 1 Smith Roof estimate |
| Isolation | C1C → `/freedom/checks` | C1C admin | PASS | Access Denied |
| Isolation | C1C → `/admin/tenants` | C1C admin | PASS | Access Restricted |
| Homeowner | Existing Freedom ledger token | public | PASS | Claim #2026-160754; no Pay/Sign |
| Admin | Owner Tenant Management | platform owner | PASS | New Tenant cancelled |
| Admin | Platform Banking + Wallet & P&L | platform owner | PASS | **no longer denied** |
| Admin | Financial model Reset/Export/Print cancel | platform owner | PASS | live |
| Admin | Mortgage ops personnel; Hire skipped | platform owner | PASS / BLOCKED | Morgan / claims@; hire would email |
| Check Center | Freedom staff queues | Freedom staff | PASS | Review 26, Endorsing 26, Ready 3, Deposited 17, Loss Draft 11, Funds Released 109; `freedom_staff_check_center_queues.webp` |
| Isolation | Staff → `/admin/tenants` | Freedom staff | PASS | silent homepage + Not authorized; `freedom_staff_admin_tenants_not_authorized.webp` |
| Auth | Freedom admin UI login | Freedom admin | FAIL | `identity_not_linked` |
| Mobile 390 | C1C/Freedom Check Center taps | — | BLOCKED | not completed this pass (Pass 1 had landing hamburger) |
| Mortgage Desk | Queue after OTP | mortgage agent | BLOCKED | EMAIL_OTP / no mailbox |

---

## 3. Workflow / state-transition matrix

Synthetic C1C check **`E2E-1789149838411`** / id `6e7303ba-e62d-4811-8521-52fb0004b32d` / $2,345.67. Actor: C1C admin. Provider destinations denied.

| Action | From | To status / stage | UI | API | DB re-query | Audit | Result |
|---|---|---|---|---|---|---|---|
| `POST /workflow/checks` | — | `uploaded` / `review` | later visible | 200 | row created | create event | PASS |
| `start_review` | uploaded | `needs_review` / `review` | — | 200 | match | transition | PASS |
| `start_endorsing` | needs_review | `endorsements_in_progress` / `endorsing` | Endorsing queue | 200 | match | transition | PASS |
| `return_to_review` | endorsing | `needs_review` / `review` | — | 200 | match | transition | PASS |
| `route_loss_draft` | review | `loss_draft_required` / `loss_draft` | — | 200 | match; **no** `loss_draft_tracking` row | transition | PASS |
| `return_to_review` | loss_draft | `needs_review` / `review` | — | 200 | match | transition | PASS |
| `start_endorsing` | review | endorsing | Endorsing | 200 | match | transition | PASS |
| `mark_ready_for_deposit` without endorsements | endorsing | — | — | 403 `invalid_transition` | unchanged | — | PASS (safe reject) |
| `mark_deposited` | endorsing | — | Disburse not executed | 403 `financial_or_provider` | unchanged | — | PASS (safe reject) |
| UI Admin override → Review | endorsing | `needs_review` / `review` | saved | `/workflow/override` 200 | match; `review_notes` = reason | `status_manual_override` | PASS |
| UI Admin override → Endorsing | review | endorsing | saved | 200 | match | override event | PASS |
| API override → loss_draft then reverse → endorsing | mixed | endorsing | — | 200 | match; tracking leftover **[]** | override events | PASS |
| Owner `POST /workflow/checks` | — | — | — | 403 `no_tenant_membership` | — | — | PASS (deny) |
| Staff override of C1C check | — | — | — | 403 `rls_denied` | unchanged | — | PASS (isolation) |
| Freedom admin override of Freedom review check (API, earlier this pass) | review | endorsing then review | — | 200 | restored | override | PASS |
| Override deposited check | deposited | — | — | `financial_or_provider` | unchanged | — | PASS (safe reject) |

OCR upload UI not used (API create, `ocr_invoked: false`) — N/A on staging. CheckAlt/Moov N/A fail-closed.

**Related records for E2E check:** `check_payees` empty, `check_endorsements` empty, no duplicate intake rows, reverse loss-draft leftover tracking **empty** (Pass 1 P1 stale Loss Draft did **not** reproduce on this new check).

---

## 4. Admin recovery results

| Probe | Result | Notes |
|---|---|---|
| C1C UI Admin tools override | PASS | Reason ≥5 chars required; actor C1C UUID; old/new status in audit; timestamp present; no provider call |
| C1C `/workflow/override` + `/data/rpc admin_override_check_status` | PASS | both 200 after P0/P1 remediation overlay |
| Platform owner finance | PASS | Banking + Wallet & P&L authorized (Pass 1 P0 **fixed on staging**) |
| Freedom admin UI recovery | FAIL | Cognito 200 then `identity_not_linked` |
| Freedom staff Admin override of C1C | PASS deny | 403 `rls_denied` |
| Deposited override | PASS deny | `financial_or_provider`; no fabricated financial events |
| Non-admin `/admin/tenants` URL | PASS deny | C1C Access Restricted; staff silent redirect + toast |

---

## 5. Mortgage Ops results

| Control | Result | Notes |
|---|---|---|
| `/admin/mortgage-ops` as owner | PASS | personnel: Morgan / `claims@freedomadj.com`; completed 1 |
| Hire agent | BLOCKED | would email |
| `/mortgage-ops/login` passkey | PASS | fail-closed “Enter your email first” |
| Email OTP / queue / request detail | BLOCKED | EMAIL_OTP; mailbox not used |
| `/admin/mortgage-ops` as C1C | not re-clicked this pass after C1C session | Pass 1 FAIL silent redirect; staff this pass: landing + Not authorized toast |
| C1C Manager → Mortgage Cos | PASS | 4 companies listed (view) |

---

## 6. Homeowner Ops results

| Control | Result |
|---|---|
| `/h/upload` UI | PASS; OTP not sent (BLOCKED email) |
| Manager → Homeowner Uploads | PASS view (1 pending, 1 pre-claim link); send not executed |
| Existing ledger token `034def45…` | PASS view Claim #2026-160754; Received $29,164.60; Released $26,248.14; Remaining $2,916.46; no Pay/Sign |
| Invalid ledger/claim tokens | PASS fail-closed; no other-tenant leak |
| `/sign` `/endorse` without token | PASS error pages |
| Complete signature / deductible ACH | N/A safety |

Public ledger remaining **independently** = 29164.60 − 26248.14 = **2916.46** (matches UI). No tenant UUID or admin chrome on the public page.

---

## 7. Claim Ledger reconciliation

`GET`/`query` `claim_settlements` as owner: **HTTP 503** this pass (Pass 1 had 0 rows via a working query). Live RCV/ACV/deductible fixture **BLOCKED**.

Independent calculator (same formulas as `ClaimLedgerCard`):

| Fixture | totalRcv | totalExpected | received | remaining | dwellingAcv |
|---|---|---|---|---|---|
| zero | 0 | 0 | 0 | 0 | 0 |
| cents (RCV 10000.01, ded 0.01, rec 123.45) | 10000.01 | 10000.01 | 123.45 | 9876.56 | 10000.00 |
| partial (RCV 10000, recDep 500, nonRec 200, ded 1000, supp 1500, rec 5500.50) | 10000 | 11500 | 5500.50 | 5999.50 | 8300 |
| multiple checks (RCV 50000+5000+2000+1000+800, amounts 10000+20000+0+0.01) | 58800 | 58800 | 30000.01 | 28799.99 | 50000 |

Deductible/non-recoverable **do not** reduce `totalExpected` (code comment: avoid looking fully funded). UI vs these fixtures **not** proven because no settlement row is readable.

Public ledger remaining math PASS as above (received − released), which is **not** the RCV ledger card.

---

## 8. Moov / wallet / payments / financials

| Control | Result |
|---|---|
| Owner platform Banking | PASS authorized; live provider not called |
| Owner Wallet & P&L | PASS $0 display |
| C1C WalletOps | PASS pending / not started; Add funds cancelled |
| C1C payment tabs | PASS $0 |
| ACH/CheckAlt/Moov transfer APIs | fail-closed / 4xx; **not initiated** |
| P&L model (admin) | PASS local model; Export/Print cancelled |

---

## 9. Settings results

C1C: all 10 tabs opened. Branding company name still **Freedom Claims Adjusting** while Profile company is **Condition One Commercial** — FAIL (P2, unchanged from Pass 1). Persist/revert **not** executed (BLOCKED). Owner Manage Tenant inner tabs viewed; no permanent billing/user changes.

---

## 10. Role / permission / tenant isolation

| Probe | Result |
|---|---|
| C1C checks API | only C1C tenant | PASS |
| Freedom staff checks API | only Freedom | PASS |
| C1C spoof `tenant_id=Freedom` on `/data/query` | ignored; no Freedom rows | PASS |
| C1C → `/freedom/checks` UI | Access Denied | PASS |
| C1C → `/admin/tenants` | Access Restricted | PASS |
| Staff → `/admin/tenants` | homepage + Not authorized | PASS (deny) / P2 UX vs Access Restricted |
| Staff override C1C check | 403 `rls_denied` | PASS |
| C1C `/providers/moov-platform-bank` | 403 platform owner required | PASS |
| Owner platform bank | 200, `liveProviderCalled: false` | PASS |
| Freedom admin identity | 401 `identity_not_linked` | FAIL P0 |

---

## 11. Mobile / failure testing

| Item | Result |
|---|---|
| Pass 1 landing hamburger 390 | PASS (baseline) |
| This pass 390 Check Center tap | BLOCKED / incomplete |
| Double-submit / two-tab edit | not run | BLOCKED |
| Invalid amount payment | N/A (payments not created) |
| Back/Forward after override | C1C refresh kept endorsing after restore | PASS (detail) |

---

## 12. Defects ranked P0–P3 (this pass)

### P0

1. **Freedom admin `mcarletta@freedomadj.com` is `identity_not_linked`.** Cognito password login 200; `/identity/me` 401. UI blocked. Was linked at the start of this pass. Do not confuse with Pass 1 unlinked-tester (that was fixed, then this admin mapping broke).
2. **Production `checksops.com` still identifies as AWS staging** (Pass 1; production SPA not deployed this pass). Evidence: `prod_login_aws_staging_banner.webp`.

### P1

3. **Inconsistent status/stage pairs increased from 1 to 4.** Still not rewritten. Sample: Freedom `61d0b41e-…` `deposited` / `ready_for_deposit`; three C1C rows `uploaded` / `deposited` with `deposited_at` null. RPC `get_inconsistent_check_status_stages` `{ rewritten: false }`.
4. **`claim_settlements` query 503** — live RCV/ACV ledger UAT blocked.

### P2

5. C1C Settings → Branding shows **Freedom Claims Adjusting**.
6. Non-owner `/admin/mortgage-ops` (and staff `/admin/tenants`) use silent marketing redirect + toast instead of the Access Restricted page used for `/admin/tenants` as C1C.
7. Invalid `/invoice/:token` and `/pay-setup/:token` expose internal `missing_cognito_token`.

### P3

8. Staging login still advertises `staging-master@checksops.invalid` as master UAT (that mailbox is not the working owner).
9. Check Center 390px tap pass not completed.

---

## 13. Evidence paths

<img src="/opt/cursor/artifacts/c1c_check_center_queues.webp" alt="C1C Check Center queues including Endorsing E2E check" />

<img src="/opt/cursor/artifacts/c1c_e2e_override_audit.webp" alt="C1C E2E check Audit tab after admin override" />

<img src="/opt/cursor/artifacts/public_ledger_token.webp" alt="Public homeowner ledger token view-only" />

<img src="/opt/cursor/artifacts/freedom_staff_check_center_queues.webp" alt="Freedom staff Check Center queue badges" />

<img src="/opt/cursor/artifacts/freedom_staff_admin_tenants_not_authorized.webp" alt="Freedom staff denied platform admin with Not authorized toast" />

<img src="/opt/cursor/artifacts/platform_owner_banking_authorized.webp" alt="Platform owner Banking authorized on staging" />

Additional: `staging_login_unauth.webp`, `staging_login_password_toggle.webp`, `staging_find_a_pro.webp`, `staging_h_upload.webp`, `staging_mortgage_ops_login.webp`, `staging_invalid_ledger_token.webp`, `staging_invalid_claim_token.webp`, `staging_endorse_no_token.webp`, `c1c_admin_override_dialog.webp`, `c1c_workflow_retry.json`, `staging_e2e_api_audit.json`.

A long `staging_public_unauth_controls.mp4` was captured (~47MB) and is **not** cited as reviewed (exceeds 15MB video-review limit).

---

## 14. Controls not tested, and why

| Control | Why |
|---|---|
| Remaining ~1231 JSX nodes | Time/session; many are nested inputs on tabs already opened |
| Settings persist/revert | not written |
| Freedom admin UI override | identity_not_linked |
| Mortgage Desk queue | EMAIL_OTP |
| Send endorsement / homeowner / hire / demo submit | email/SES workstream |
| Moov ACH collect/send, CheckAlt deposit | provider flags + safety |
| KYC document upload | real identity docs |
| Claim settlement RCV UI | table 503 / no fixture |
| `read_only` / `contractor` / `client` roles | no mapped UAT users |
| Production authenticated ops | safety |
| Mobile 390 Check Center taps | session incomplete |
| Two-tab concurrent edit | not run |
| Bulk Void | would destroy live Freedom checks |

---

## 15. Golden path (Pass 2)

**Check:** `E2E-1789149838411`  
**Tenant:** C1C  
**Actor:** `payments@condition1commercial.com`

API: create → review → endorsing → review → loss_draft → review → endorsing → ready-for-deposit rejected → deposited rejected → admin override review → endorsing. UI: opened on C1C Endorsing, all detail tabs, Admin tools override round-trip, Audit events, Funds $2,345.67, Disburse not executed, isolation vs Freedom PASS. Reverse loss-draft tracking leftover empty. No payees/endorsements fabricated. No provider execution.

This is a **safe internal** path. It is **not** OCR + completed endorsements + CheckAlt + Moov + homeowner sign + Mortgage Desk.

---

## Recommended next actions (do not implement in this audit)

1. Relink `mcarletta@freedomadj.com` Cognito `sub` to application UUID `7dbb3009-…` without mapping `sub === uuid`.
2. Keep production SPA off until `isAwsStaging()` is not compiled true.
3. Report-only reconcile the four inconsistent status/stage rows (do not silently rewrite in an audit).
4. Restore a readable `claim_settlements` fixture for ledger UAT.
5. Re-run persist/revert settings, 390px Check Center, and Freedom admin override after identity is linked.
6. Do not claim ≥95% until the 1231 untested JSX nodes are physically clicked or explicitly N/A.

---

# Pass 1 baseline (original 2026-09-11 audit)


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
