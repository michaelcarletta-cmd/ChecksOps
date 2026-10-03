# Mortgage Agent Management — current-state review (no deploy)

Date: 2026-10-03T19:32:00Z
Production: unauthorized
This note is review only. No staging or production write was performed.

## Fresh authority

| Item | Value |
| --- | --- |
| `origin/main` | `7c64dae2dee6c78dd296c946c04ea6ccaa793aef` (unchanged) |
| Accepted MAC source | `c5facdae7e88d400848ee8b009e59a22906de82d` tree `6dc79d8add4bb4526820b21e20626ee4901172fc` |
| Newest Branding compose | `origin/cursor/branding-preview-logo-embed-ff98` `2e94556303ee7933d42738df02f1bc9c8ee2c668` tree `e0b158fb6d714512c74f2c8e48220746822f8c19` (PR #640). Already contains Mortgage Agents tab. |
| Live staging SPA | `/assets/index-BMa1WD6y.js` index sha `2ced2b30e7ebced14a832a20fe8c2030689e4bdd80f3d5b7a301856500953474` Last-Modified 2026-10-03T19:04:34Z |
| Live chunks | `AdminTenants-CtjQ_ubb.js`, `MortgageAgentsPanel-whlXY-ar.js`, `HomeownerLedger-Cm0vPbI5.js` |
| Staging Lambda (PR #640 last read) | `I+u0Z80Fov6w81Ho6DZETeRDgHMdHlQp/SUsd6ofzYw=` Rev `8ae6edfd-…` — Branding did not overlay API |
| Production SPA | `/assets/index-BgOCQCWm.js` sha `3832fadc…` |

Do **not** restore `/assets/index-BmT-cuwB.js`. Branding advanced the shared SPA. Live index still has Email Branding, Email Brand Color, Application Sidebar Logo, `showSendingDomain`, `/h/ledger`. Live AdminTenants chunk still has Mortgage Agents.

`AdminTenants.tsx` on #640 matches the MAC additive tab. The only Branding delta vs `c5facdae7` in shared settings is `EmailSenderSettings.tsx`.

## What already works (do not regress)

Accepted staging behavior remains the authority:

- SQL 47 earn-on-Complete, $10/$5 rates, identity ≠ `tenant_users`
- Duplicate Complete / approve / pay are idempotent
- Deactivate does not delete role, history, or in-progress assignment
- Inactive agents cannot Accept new work (`tg_reject_inactive_mortgage_agent_accept`)
- Agents cannot call compensation admin (403)
- Hire writes `identity_accounts` + `profiles` + `user_roles.mortgage_agent` + `mortgage_agent_accounts` only. No `tenant_users` insert. Cognito temp password is suppressed and not returned.
- Bookkeeping only. No Moov/ACH payout
- Freedom `5b20db20-13e1-4919-9528-06388d8661d2` stays excluded / untouched

Live Tenant Management already hosts the Mortgage Agents tab and panel (`Hire`, roster, deactivate, monthly totals, approve, mark paid, reconciliation).

## Reassignment / cancellation / correction (inspect)

| Case | Current behavior | Safe? |
| --- | --- | --- |
| Agent A Accepts, then someone else should finish | Accept RPC only assigns when `status=requested` and `assigned_employee_id IS NULL`. There is **no** reassign RPC. Historical AdminMortgageOps unassign UI was replaced by a Mortgage Agents alias. | **Not implemented.** Do not raw-UPDATE `assigned_employee_id`. |
| Agent A deactivated while in progress | `set_mortgage_agent_account_status` only flips roster status. Work stays assigned. Complete still earns to `assigned_employee_id`. New Accepts by that agent fail. | Yes, as designed. |
| Cancel before Complete | `update_mortgage_handling_request_status` can set `cancelled`. Earn trigger runs only on `completed` + `completed_at`. No payable. | Yes. |
| Admin Complete | Same RPC allows `admin` **or** the assignee. `assigned_employee_id` is not rewritten. Earn goes to the assignee. Unassigned + admin Complete → no payable (`assigned_employee_id IS NULL`). | Yes for entitled assignee. Unassigned admin Complete is a no-earn edge. |
| Duplicate Complete | Existing non-voided parent row is returned. Unique violation swallowed. | Yes. |
| Correction after earn (unpaid) | Fact columns are immutable. Status may move earned→approved→paid. **No void/adjust RPC** is exposed. `parent_entry_id` exists in the table but is unused by the API. | Gap. |
| Paid requiring correction | Paid rows cannot change status or be deleted. Re-mark-paid is `updated=0`. | Correct immutability. **No** adjustment workflow yet. |

Admin can also Complete→Cancelled on an already-completed row (no from-status guard). That would leave a payable on a cancelled request. Do not use that path. Do not invent a DB cleanup.

### Smallest controlled reassignment (proposal only — not authorized to apply)

Do not improvise a one-off UPDATE.

Later, if authorized, add one platform-owner RPC, for example `return_mortgage_handling_request(p_request_id)`:

1. Allowed only when `status = in_progress` and `completed_at IS NULL`
2. No compensation row exists (or only if we separately void unpaid earn — not needed if return is pre-Complete)
3. Sets `assigned_employee_id = NULL`, `status = requested`, `accepted_at = NULL`
4. Does **not** delete or rewrite `check_billing_events` from the first Accept
5. Agent B then uses the existing Accept RPC
6. Complete still earns to whoever is assigned at Complete
7. If a payable already exists, refuse return; use a later adjustment child row instead of rewriting paid facts
8. Never operate on Freedom `5b20db20-…`

Paid correction, if later authorized: insert a child `mortgage_agent_compensation_entries` (`parent_entry_id` = paid row, signed cents, `earned`) plus audit. Do not UPDATE the paid parent. Monthly totals would need to net children (today they exclude `parent_entry_id IS NOT NULL`).

## Remaining production-readiness gaps

1. **Platform-owner UI acceptance** of the populated Mortgage Agents tab as `checksopsadmin@gmail.com` is still pending. This agent will not manufacture that session.
2. **Files drilldown is incomplete in the UI.** API already returns claim/check ids, accepted_at, payment date/ref/note, mortgage company. The table shows agent, tenant, loan/company, class, amount, tenant event, status, completed only. It does **not** show homeowner, claim, check, accepted date, or payment bookkeeping columns. `homeowner_name` is not selected in `handleEntries`.
3. **Hire dialog** still has an optional password field. Staging hire is passwordless; the API does not return `temp_password`. Hide the password field on AWS staging so operators do not think password auth was added.
4. **`/admin/tenants?tab=mortgage-agents`** is not wired. `AdminTenants` uses `defaultValue="tenants"`. The `/admin/mortgage-ops` alias already mounts the same panel. Prefer the alias over replacing `AdminTenants.tsx`.
5. **Reassignment** is not safely implemented (see above).
6. **Unpaid/paid corrections** are not implemented (schema ready, API not).

## Exact proposed changes (next implementation only)

Do not deploy until the user authorizes after this review.

**Base:** new branch from `2e94556303ee7933d42738df02f1bc9c8ee2c668` (`cursor/branding-preview-logo-embed-ff98`). Forward-compose. Do not take older `AdminTenants.tsx` from `c5facdae7`. Do not reapply SQL 47. Do not overlay Lambda unless an entries SELECT add is approved. Do not restore `index-BmT-cuwB.js`.

| File | Change |
| --- | --- |
| `src/components/admin/MortgageAgentsPanel.tsx` | Expand Files rows/detail: homeowner, claim id, check id, accepted_at, payment date, reference, note. Hide hire password on `isAwsStaging()`. Keep bookkeeping-only copy. |
| `aws/functions/api/mortgage-agent-compensation.mjs` | Additive `r.homeowner_name` (and claim number if already joinable) on `entries` SELECT only. |
| Tests | Panel/API unit coverage for the new columns; Branding/Homeowner/hire-lock contracts unchanged. |
| `AdminTenants.tsx` | **Do not replace.** No Branding/Email/sidebar edits. |
| SQL 47 | **No change.** |
| Reassignment / paid correction | Separate later authorization. Not in this UI completeness patch. |

## Safety

- No production writes
- No real payouts
- No Cognito/RLS broadening
- No Freedom `5b20db20-…` cleanup
- No historical SPA/Lambda restore
