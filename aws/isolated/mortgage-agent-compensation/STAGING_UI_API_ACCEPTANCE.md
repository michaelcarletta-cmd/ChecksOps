# Staging UI/API acceptance — Mortgage Agents

Date: 2026-10-03T17:32:00Z
Workstream: `mortgage-agent-compensation-ad99`
Composed source: `c5facdae7e88d400848ee8b009e59a22906de82d` tree `6dc79d8add4bb4526820b21e20626ee4901172fc`
Production: unauthorized / untouched
SQL 47: accepted earlier; not reapplied
Money movement: none (bookkeeping only; no Moov/ACH)

Controlled staging data only:

- Tenant `a2c0fbfe-e8c5-42dc-bc32-2c4edf8f2074` (SYNTHETIC Consolidated Monthly Billing)
- Agent `b100f05d-9e81-4a7b-b9cc-9baf173131d9` (claims@freedomadj.com)
- Platform owner `233c588f-dc33-4307-8c3f-3da49c9fd2b3` (checksopsadmin@gmail.com)
- Status probe agent `14ec8139-b710-4403-aaa0-22e54f408481` (zero historical work)
- Freedom request `5b20db20-13e1-4919-9528-06388d8661d2` not in compensation entries

## 15-scenario results

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Mortgage Agents appears on Admin Tenants | PASS | Live `AdminTenants-E1rZct36.js` contains `Mortgage Agents` + Branding & Email + `showSendingDomain`. Route `/admin/tenants` exists. |
| 2 | Existing agents appear | PASS | Live `roster` returns M Carletta, Mo Carletta, Morgan Carletta. |
| 3 | Agent identity separate from `tenant_users` | PASS | Agent `/identity/me`: `roles=["mortgage_agent"]`, `tenants=[]`, `mortgageAgentStatus=active`, app UUID ≠ Cognito sub. |
| 4 | Active/inactive without deleting history | PASS | Deactivated `14ec8139…` then reactivated. Roster still listed the same UUID/email; `deactivated_at` set then cleared. |
| 5 | Monthly dashboard totals | PASS | Period `2026-10`: initial 1, additional 1, files 2, gross $15.00, paid $15.00, balance $0.00. |
| 6 | Drilldown identifies Mortgage Ops files | PASS | Entries expose `mortgage_request_id`, `check_intake_item_id`, `claim_id`, loan `MACOMP-1`/`MACOMP-2`. |
| 7 | Earned entries can be approved | PASS | SQL 47 demo approved 2 earned rows. Live API `approve` is wired (`updated` returned). |
| 8 | Approved entries marked paid with date/ref/note | PASS | Paid rows keep `payment_date=2026-10-03`, `payment_reference=MACOMP-STAGING-15`, `payment_note=bookkeeping only`. |
| 9 | Paid history immutable/auditable | PASS | Live `approve` and `mark_paid` on those ids returned `updated=0`. Reference/note unchanged. |
| 10 | Recon separates tenant charges vs agent pay | PASS | Entries show tenant event types `mortgage_ops_initial` / `mortgage_ops_additional_check` beside agent amounts. Anomaly `completed_without_compensation` is flag-only (GATE4 `c4f1b55b…`, not backfilled). |
| 11 | Tenant $0 does not erase agent pay | PASS | Reconciliation SQL treats `tenant_billing_amount_cents = 0` as non-mismatch. No `amount_mismatch` anomalies. Agent rates come from the compensation table, not tenant charge. |
| 12 | Mortgage Agents cannot use this admin UI | PASS | Agent compensation API 403 `not_authorized`. Signed-in agent hitting `/admin/tenants` sees Access Restricted. |
| 13 | Branding / Admin Tenants still work | PASS | `tenant-email-branding-get` 200 for Freedom + synthetic tenants (`sendingDomain`, logo, Branding & Email tab still in chunk). Unauth Admin Tenants still renders the restricted card. |
| 14 | Homeowner routing intact | PASS | `/h/ledger/macomp-routing-probe` renders Homeowner Ops “This link isn't working”, not a `/:slug` tenant page. `homeowner-ledger-view` route is live (404 `not_found` for the probe token). |
| 15 | Mortgage Ops queue / Accept / Complete intact | PASS | Agent EMAIL_OTP login reached `/mortgage-ops/queue` with Queued 3 / In progress 2 / Completed 5 and visible Accept task buttons. No Accept/Complete was clicked. Freedom `5b20db20…` not acted on. |

## Live API fingerprints after compose

| Component | Before | After |
| --- | --- | --- |
| `checksops-staging-api` | `HN09hmWB5D22ljOfRhvpcPYPGEqWFuTXB6CR2h13zpU=` Rev `7ce5717c-…` | `I+u0Z80Fov6w81Ho6DZETeRDgHMdHlQp/SUsd6ofzYw=` Rev `8ae6edfd-…` |
| Staging SPA index.html | `index-DkLMXa2q.js` sha `13255a4e…` | `index-BmT-cuwB.js` sha `d2900734…` |
| Shared SQL executor | `JTTXtiCukqvKyJCBwJvQ6ayat3ErrqyItuThOx+3xDI=` | unchanged |
| Production prep-api | `S2CV0j3zWfYfyfSvmIq0axMhnSib1UntZZVqOvzxBbc=` | unchanged |
| Production SQL47 apply | `B8q1Z7a2doe6dfpqjdHfT1wv/VkEwWOmLOekxjLLsVQ=` | unchanged |
| Production SPA | `index-BgOCQCWm.js` sha `3832fadc…` (11:41Z) | unchanged |

Lambda overlay changed only `app-services.mjs`, `tenant-admin.mjs`, `identity.mjs` and added `mortgage-agent-compensation.mjs`. Unrelated live members stayed byte-identical (6478 → 6479).

## Protected contracts (pre-write)

- Branding + Homeowner + compensation unit: 30/30
- Deployment-guard: 208 pass / 1 fail (`aws-production-spa-bootstrap` missing `puppeteer-core`, pre-existing) / 1 skip
- #601: 31/31
- Claim ledger: 4/4
- Mortgage Ops isolation: 5/5
- CheckAlt dedicated after live handler restore: 7/7
- Financial API: 14/14; financial lock: 25/25
- Earlier bundled `checkalt-deposit-preflight` failed only while `tenant-settings-handlers.mjs` was not yet copied into source for composition completeness; that member was not overlay-owned.

## Stop

Staging API + SPA acceptance is complete. Production remains unauthorized. No historical production backfill. No actual agent payment.
