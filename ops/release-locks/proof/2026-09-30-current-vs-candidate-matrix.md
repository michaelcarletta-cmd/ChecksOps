# Current live vs additive recovery candidate

Read-only. **No production deploy. No Lambda write. Unknown checks not mutated.**
Stop for approval. This file is not an apply receipt.

Live HTTPS **2026-09-30T22:57Z**: still `/assets/index-DSbVZXu8.js`
(index sha256 `e93fe548…`, S3 `Jc2Nyp5T…`).

Candidate: fresh `npm run build:aws` on
`cursor/compose-qdji-dsb-recovery-f477` → `/assets/index-CvCKsSsX.js`
sha256 `cd55efcde625c03ab8bba60decec3c4d6b3bb53e3a8e45dd6a4c2b9991065007`.
**Not uploaded.**

Source compose: `82460c8c2` (live settlement + hostname-guard) +
`9afb57fe` WalletOps + `b97a8dc6` branding/Insured Name + `84ba11f4`
Moov badges / billing persist / admin billing.

Compiled QDJi vs DSb compare:
`ops/release-locks/proof/2026-09-30-qdji-vs-dsb-compiled-comparison.md`.

---

## Capability matrix

| Capability | QDJiUFF1 | Live DSbVZXu8 | Candidate CvCKsSsX | Verdict |
|---|---|---|---|---|
| WalletOps `environmentReady` / wallet-first funding | yes (×3) | **lost** | **restored** (×3) | Regression → restore |
| `Payment wallet environment is required` | yes | lost | restored | Regression → restore |
| Moov `Bank verified` / `Provider linked` / `Bank pending` | yes | **lost** | **restored** | Regression → restore |
| Billing `save-tenant-billing-account` + no-collection guard | yes | **lost** | **restored** | Regression → restore |
| ChecksOps billing / `monthly_subscription` | yes | **lost** | **restored** | Regression → restore |
| Deposits `groupDepositsBySubmissionDate` | yes | **lost** (cleared_at fallback) | **restored** + Insured Name | Regression → restore intended grouping |
| Branding persist / tenant-logos save path | yes | reduced / old company-branding | `#584` `/branding/logo/` ×3 | Regression + accepted #584 add |
| `tenantLogoUrl` symbol | neither | neither | minified; route `/branding/logo/` present | #584 add |
| Settlement `save_claim_settlement_breakdown` | no | **yes** | **kept** | Intentional later → keep |
| Hostname `checksops-production-host` | in HTML | in HTML | in HTML ×2 | Keep |
| Delete Check | yes | yes | yes (`delete_check` ×2) | Preserve |
| Signature Requests | yes | yes | yes (`signature` ×261) | Preserve |
| OCR / MICR / payee / issue date | yes | yes | yes | Preserve |
| Endorsing `new_stage` (SPA marker) | ×3 | ×3 | ×3 | Preserve; live Lambda `workflow.mjs` not applied here |
| WalletOps inline Default payout speed | no | yes (duplicate of treasury panel) | **absent string**; **Manage sweeps → MoovTreasuryPanel** still writes `pushRail` | Equivalent replacement; see capability trace |
| DKIM / sending-subdomain | no | UI present; SES flag **false** (503) | platform sender + persist-safe branding | Live form is disabled; not a working capability |
| Invoice letterhead upload | no | `#invoice-letterhead-upload` | **independent invoice logo → `invoice_letterhead_url`** | Equivalent replacement (renamed control) |
| Unknown Date unknown deposits | client regroup | client regroup | same ids, submitted_at grouper | Existing records; **do not delete** |

---

## Acceptance (required)

A later apply workstream may promote this candidate only if immediately-before
live pins still match DSbVZXu8 / `e93fe548…` / S3 `Jc2Nyp5T…` and Lambda
`jN5d0C34…`, and a signed guard receipt exists. Official
`production-spa-upload.mjs` only. Per-object put. No `s3 sync --delete`.

Must remain true after apply:

1. UI shows **Bank verified** vs **Provider linked** (not conflated).
2. Freedom logo GET still 200 PNG sha256 `8fe8caf1…17c6801f` (or newer operator upload) and header renders it.
3. WalletOps uses production operating wallet (`environmentReady`).
4. Billing save persists without starting a collection.
5. Bank Deposits group by `submitted_at`; Date unknown rows keep the same deposit ids.
6. Settlement save, hostname-guard, Delete Check, signatures, OCR/MICR remain.

Lambda members are in this source tree for a later overlay evaluator only.
This task did not write `checksops-production-prep-api`.

---

## Tests

| Suite | Result |
|---|---|
| `unknown-check-spa-relabel.test.mjs` | pass (existing ids regrouped; deposit query select-only) |
| `insured-name-branding.test.mjs` | pass |
| `manager-bank-deposits-partners.test.mjs` | pass |
| `checkalt-pending-sync.test.mjs` | pass |
| `moov-stakeholder-status.test.mjs` | pass |
| `qdji-dsb-recovery-candidate-artifacts.test.mjs` | pass against fresh `dist/` |

`persistableLogoField` is present in source and minified out of the bundle;
compiled proof is `/branding/logo/` ×3.

DSb-absent strings (payout speed / DKIM / letterhead) traced in
`ops/release-locks/proof/2026-09-30-dsb-absent-capability-trace.md`.
None required a compose add or rebuild.

Fingerprints:
`ops/deployment-guard/2026-09-30-qdji-dsb-recovery-candidate-fingerprints.json`.
