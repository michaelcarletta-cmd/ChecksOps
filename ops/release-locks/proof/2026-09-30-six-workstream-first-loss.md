# Six-workstream first-loss and additive recovery

Read-only. **No deploy, revert, restore, merge, or production modify.**

Scope is only these six workstreams (screenshot 2026-09-30 ~22:32 UTC).
This recovery-plan agent is excluded. Everything **before** these six is
protected known-good and must not be rebuilt from `main` or restored as a
wholesale SPA/Lambda.

| Workstream | Agent | Production-touching PRs |
|---|---|---|
| Deployment build safeguards | `bc-5e70b10c-280d-453c-ae28-6fe4dd6a771b` | #579 source only |
| ChecksOps delete check | `bc-d61f3d7d-7e9b-4253-8392-bbafef85fb87` | #585/#586 source + lock only |
| Checksops issues | `bc-c413824f-1040-4e4b-90c5-70d2053051c8` | #581 prod apply; #584 staging only |
| Check view, claim number save | `bc-5f3c64b4-4a2f-4663-9dc6-8626cebaa2a4` | #582 prod Lambda + SPA |
| Moov general availability | `bc-f8b0cb28-9f1a-4ac4-bf5e-3e6649f72d41` | #575 accepted WalletOps SPA (before the others wrote) |
| Endorsing confirmation fix deployment | `bc-0f07b8bb-0093-466e-b94e-c64db1520fb6` | #576 Lambda overlay of `workflow.mjs` only |

Live re-read **2026-09-30T22:33:14Z** (HTTPS only): still
`/assets/index-DSbVZXu8.js`, index sha256
`e93fe5488c013aed91626da1ee608978f702796a24e08350306ccb4c3163e75f`,
S3 `Jc2Nyp5THf1j30gf21cQHeMoApSs8uDw`, Last-Modified
`Wed, 30 Sep 2026 21:20:11 GMT`. Unchanged since the first-loss write.

---

## Verdict

**First workstream that lost previously working production composition:**

`Check view, claim number save` (`bc-5f3c64b4`) **PR #582** production SPA
promote of `/assets/index-DSbVZXu8.js` at **2026-09-30T21:20:11Z**.

Writer: official `production-spa-upload.mjs` via
`ChecksOpsProductionSpaDeploy`, CloudFront invalidation
`ICJ7PG1IS6CFP3I4BGR2ZQE6E`. Source commit `82460c8c2` — PR body:
“fresh clean build” from “current production/main hostname-guard +
settlement RPC intercept only.” Immediately-before matched `QDJiUFF1`,
so there was no `DEPLOYMENT_COLLISION`. The **source tree was not** the
live settings+WalletOps compose.

That is the first write among the six that **dropped** accepted, already-live
functionality. Earlier writes in this set were additive or source-only.

---

## Why the other five are not first-loss

### Endorsing confirmation (`bc-0f07b8bb`, #576) — 19:56 UTC

Narrow live overlay: only `workflow.mjs` →
`bd18db71ab9277eea74add41f99ed5324841a163815a756578f60cfd50bf7bab`.
SPA untouched. Adds `new_stage` onto known-good live `workflow.mjs`
(not `main`). **Additive. Protected.**

### Moov general availability (`bc-f8b0cb28`, #575) — 19:47 UTC

Accepted WalletOps activity-recovery SPA `index-DbYbvb6d.js` composed onto
known-good funding SPA `C_fh5VBD`. Lambda unchanged. **Additive onto
protected WalletOps/funding. Protected once accepted.**

### Checksops issues (`bc-c413824f`, #581) — 20:31–20:35 UTC

Composed settings items 1/2/5 onto live `DbYbvb6d` / `RaFQKBA`.
Production SPA `QDJiUFF1` still carried WalletOps recovery
(`environmentReady` in entry; chunk `WalletOps-D5mOeN7Q.js`) and banner
hide. Lambda overlay of five settings members recorded endorsing
`workflow.mjs` `bd18db71…` unchanged. **Additive. Lost later, not here.**

PR #584 later composed Insured Name/branding onto `DSbVZXu8` for
**staging only**. It did not write production and is not first-loss.

### Deployment build safeguards (`bc-5e70b10c`, #579)

Source-only collector/guard. Zero AWS writes. **Not a composition write.**

### ChecksOps delete check (`bc-d61f3d7d`, #585/#586)

Source + release-lock refresh. Latest commits through `a3bda9242` (22:30)
are tests/locks/revert of extra scope. Live SPA last-modified still 21:20.
**Not a production composition write.**

---

## Composition timeline (these six only)

```
known-good (before these six)
    │
    ├─ #576 endorsing   Lambda RaFQKBA     ADD workflow.mjs new_stage
    ├─ #575 WalletOps   SPA DbYbvb6d       ADD recovery onto C_fh5VBD
    ├─ #581 settings    SPA QDJiUFF1       ADD items 1/2/5 onto DbYbvb6d
    │                   Lambda JlChQag     ADD 5 settings members
    ├─ #582 settlement  Lambda jN5d0C34    ADD settlement writer (~21:11)
    └─ #582 settlement  SPA DSbVZXu8       REPLACE QDJiUFF1 (21:20)  ← FIRST LOSS
         clean hostname-guard + settlement; drops WalletOps recovery + settings 1/2/5
```

Immediately before the 21:20 SPA put, working production SPA was
`QDJiUFF1` (WalletOps recovery + settings 1/2/5 + banner hide).
Settlement Lambda `jN5d0C34` was already live and must be kept.

---

## Exact additive recovery (do not apply in this task)

Base = **current live**, not `main`, not `DbYbvb6d`, not `QDJiUFF1`.

### SPA

Start source: `82460c8c2` (`cursor/claim-settlement-amount-writer-a2a4`,
PR #582) — this **is** the live `DSbVZXu8` tree (hostname-guard +
settlement intercept).

Overlay these files from later/earlier accepted commits. Do not replace
unlisted live files.

**Keep from live `82460c8c2` (do not revert):**

- `index.html` hostname-guard / banner hide
- `src/integrations/aws/client.ts` settlement RPC intercept
- `src/components/payments/ClaimLedgerCard.tsx`
- `aws/functions/api/write-claim-settlement.mjs`
- `aws/functions/api/workflow-rpc.mjs` (settlement case + prior claim-number)
- `aws/functions/api/workflow.mjs` — live patched endorsing file only;
  never `main`

**Add WalletOps recovery from `9afb57fe52a42c0a84e4e07b3a7618c20c0d815c`
(PR #575):**

- `src/pages/WalletOps.tsx`
- `src/hooks/useWalletOps.ts`
- `src/hooks/usePaymentProviderEligibility.ts`
- `src/lib/payments/wallets.ts`
- `src/lib/payments/selectPaymentWallet.ts`
- `src/lib/payments/reconcileWalletFundingTransfer.ts`
- `src/lib/payments/walletRelativeTransfers.ts`

**Add settings/Insured Name/branding from `b97a8dc6de16305c11b9e52e92ea167abdfabc8d`
(PR #584 HEAD, already based on `82460c8c2`):**

- `src/lib/tenantLogoUrl.ts`
- `src/components/branding/TenantLogo.tsx`
- `src/components/deposit-ops/BankDepositReconciliation.tsx`
- `src/components/settings/CompanyBrandingSettings.tsx`
- `src/components/settings/EmailSenderSettings.tsx`
- `src/components/white-label/WhiteLabelLogin.tsx`
- `src/components/white-label/WhiteLabelCheckCenter.tsx`
- `src/components/white-label/WhiteLabelSettings.tsx`
- `src/pages/PublicInvoicePage.tsx`
- `src/pages/payments/InvoicesTab.tsx`

**Add settings files that #584 did not carry, from
`84ba11f4c5fbc5a98652768dc72cb1e58757ea14` (PR #581):**

- `src/components/settings/TenantBillingAccountPanel.tsx` (item #1)
- `src/components/disbursement/StakeholderAccountSettings.tsx`

Practical shortcut: take PR #584 tree (`b97a8dc6`) as the DSb+branding
base, then copy the seven WalletOps files from `9afb57fe` and the two
#581-only UI files above. Fresh Vite build. **Do not upload** staging
`index-C8adM6cZ.js` or historical `QDJiUFF1` / `DbYbvb6d`.

**Candidate must contain all of:**

| Marker | Proves |
|---|---|
| `save_claim_settlement_breakdown` | live settlement (#582) kept |
| `checksops-production-host` | hostname-guard kept |
| `environmentReady` | WalletOps recovery (#575) restored |
| `tenantLogoUrl` | branding (#584) restored |
| Insured Name / `submitted_at` grouping, not `payee_line` | deposits #5 + #584 |
| billing consent persist path | item #1 from #581 |

If any marker is missing: `SOURCE_COMPOSITION_REQUIRED`. Do not promote.

### Lambda

Re-read live `checksops-production-prep-api` member SHA256s (official
verify-live / trusted collector). This task did not.

Expected live ZIP is `jN5d0C34…` built from `JlChQag…` plus settlement.
If that is true, settings five members and endorsing `workflow.mjs`
`bd18db71…` are still present.

Overlay **only** members whose live hash drifted:

| Member | Source if missing | Do not replace with |
|---|---|---|
| `write-claim-settlement.mjs` | `38e659b46` / `82460c8c2` | — |
| `workflow-rpc.mjs` | live `jN5d0C34` copy unless settlement/claim-number missing | thin `main` |
| `workflow.mjs` | PR #576 live patch `bd18db71…` | `main` `workflow.mjs` |
| `tenant-settings-handlers.mjs` | `b97a8dc6` (#584 persist-safe) | — |
| `tenant-email-domain-handlers.mjs` | `b97a8dc6` | — |
| `app-services.mjs` | `84ba11f4` (#581) | — |
| `providers/parity/moov-functions.mjs` | `84ba11f4` | — |
| `providers/parity/moov-stakeholder-status.mjs` | `84ba11f4` | — |

Fresh-download live ZIP. RevisionId CAS. Overlay-only. No wholesale
replace.

### Apply gates (later reviewed workstream only)

1. Immediately-before live pins still `DSbVZXu8` /
   `e93fe548…` / S3 `Jc2Nyp5T…` and Lambda `jN5d0C34…` / `a37c1225-…`,
   or stop and recompose (`DEPLOYMENT_COLLISION`).
2. Exclusive lease + signed receipt. Official
   `production-spa-upload.mjs` + `production-lambda-apply.mjs` only.
3. Per-object SPA put. No `s3 sync --delete`. No old dist reuse.
4. Do not merge #579, #581, #582, #584, #575, or #586 as the recovery
   artifact. Compose first, then a new apply PR.

### Explicitly refuse

- Restore `index-DSbVZXu8.js`’s predecessors as the live entry
- Promote #581 `QDJiUFF1`, #575 `DbYbvb6d`, #584 staging `C8adM6cZ`,
  or #579 safeguard source
- Rebuild from `origin/main`
- Treat delete-check lock refresh as a SPA identity

This file is not an apply receipt.
