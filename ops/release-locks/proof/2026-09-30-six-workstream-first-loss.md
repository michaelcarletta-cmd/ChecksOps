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
| `Bank verified` and `Provider linked` | Moov account status (#581 `StakeholderAccountSettings.tsx`) |
| `tenantLogoUrl` / `TenantLogo` | branding (#584) restored |
| Freedom logo GET still 200 PNG sha256 `8fe8caf1…17c6801f` (or newer operator upload) | tenant logo bytes not deleted |
| Insured Name / `submitted_at` grouping, not `payee_line` | deposits #5 + #584 |
| billing consent persist path | item #1 from #581 |
| Same `checkalt_deposits.id` set; no intake insert | unknown checks are existing rows |

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
- Delete, update, hide, or re-OCR any check / `checkalt_deposits` row
  while investigating “unknown” checks

---

## Reported-symptom acceptance (required)

A recovered candidate is **not** accepted on bundle hashes alone. It must
restore the two user-reported surfaces below, and the “unknown” checks
must be classified read-only as existing vs new. **Do not delete or
modify any checks** during that classification or during apply.

### A. Correct Moov account status

Live `DSbVZXu8` / current `main` `StakeholderAccountSettings.tsx` uses a
single badge (`Not verified` / `Failed` / …) and does **not** emit
`Bank verified` or `Provider linked`. `QDJiUFF1` (PR #581) does.

Accepted #581 rule (`84ba11f4` `StakeholderAccountSettings.tsx`):

- `verification_status === "verified"` → **Bank verified**
- Moov `provider_account_id` present and bank not verified → **Provider
  linked**, tooltip: “A Moov account exists. This is not bank
  verification.”
- Do not treat provider-linked as bank-verified
- WalletOps recovery (`9afb57fe`) must also select the
  environment-specific operating wallet (`environmentReady` /
  `selectPaymentWallet`)

Acceptance checks (read-only, no association writes):

1. Candidate SPA contains `Bank verified` and `Provider linked`.
2. For one known Freedom stakeholder with a Moov id and unverified bank:
   UI shows **Provider linked** and **not** Bank verified.
3. For a bank-verified stakeholder: **Bank verified** regardless of Moov
   id.
4. WalletOps activity uses the production operating wallet, not a
   sandbox/other-env wallet.

PR #584 already recorded that homeowner
`2ad87468-15cd-437c-ba9c-c4a896dc5365` has no provider account. Do not
associate any of the four `M*** C***` Moov accounts as part of
acceptance.

### B. Tenant logo

Live `DSbVZXu8` entry has **zero** `tenantLogoUrl`. Logo **bytes were not
deleted**. Read-only GET
`https://checksops.com/prep/branding/logo/2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`
at 2026-09-30T22:40:49Z returned HTTP 200 `image/png` 796240 bytes,
PNG 3000×599, sha256
`8fe8caf15f55d20f6c7a6b71f14dd6e1b80d6b0fa384bb10a1e581fc17c6801f`.
Re-read 2026-09-30T22:43:37Z: same 200 PNG and sha256. Historical
`index-QDJiUFF1.js` (sha256 `19ae149d…afd92c7`) still HTTPS-200 and
contains `Bank verified` + `Provider linked`; live `index-DSbVZXu8.js`
contains neither and has zero `tenantLogoUrl`.

Acceptance checks:

1. Candidate includes `src/lib/tenantLogoUrl.ts` and `TenantLogo` from
   `b97a8dc6` (PR #584). Login/header/invoices resolve
   `/prep/branding/logo/{tenantId}`, not a raw `/storage/public` hop as
   the primary display URL.
2. Repeat the same GET: still 200 PNG with the same sha256 (or a newer
   operator-uploaded logo). Storage must not have been cleared.
3. Authenticated render (when a session exists): Freedom tenant header
   shows that PNG.
4. Blank branding save must not persist `logo_url=null`
   (`persistableLogoField` / #584 handlers).

### C. Newly visible “unknown” checks — existing vs new (read-only)

**Do not DELETE/UPDATE `check_intake_items` or `checkalt_deposits`.**

Two SPA strings exist. Classify both.

#### C1. Bank Deposits group `Date unknown` (primary)

`bankDepositDayKey(null)` returns `"unknown"`; UI label **Date unknown**.

| SPA | Grouping key | When a row is “unknown” |
|---|---|---|
| Live `DSbVZXu8` / `82460c8c2` | `cleared_at ?? submitted_at` | both timestamps null / unparseable |
| #581 `QDJiUFF1` / #584 recover | `submitted_at` only | `submitted_at` null even if `cleared_at` exists |

None of the six workstreams insert `check_intake_items` except a unit-test
fixture in `ocr-rerun-stability.test.ts`. The deposit query is
`.from("checkalt_deposits").select(...).limit(1000)` — **read of existing
rows**. The unknown bucket is a **client regroup**, not a create.

Read-only classification (later apply workstream / operator):

```sql
-- evaluate-only; do not apply from this file
SELECT d.id AS deposit_id,
       d.check_intake_item_id,
       d.status,
       d.submitted_at,
       d.cleared_at,
       d.created_at,
       i.created_at AS check_created_at,
       i.check_number
  FROM checkalt_deposits d
  LEFT JOIN check_intake_items i ON i.id = d.check_intake_item_id
 WHERE d.tenant_id = :tenant
   AND d.status NOT IN ('rejected','returned','error','declined')
   AND d.submitted_at IS NULL
 ORDER BY d.created_at;
```

| If | Meaning |
|---|---|
| `d.created_at` and `i.created_at` both `< 2026-09-30 20:15 UTC` | **Existing records** exposed/mislabeled by the submission-date grouper |
| `i.created_at >= 2026-09-30 20:15 UTC` | Treat as a **genuinely new check**; these six workstreams have **no** production insert path — investigate outside this compose |
| Row exists only after a user upload in the window | New intake, not a compose bug; **do not delete** |

**Verdict (read-only, no SQL write, no check mutate):** these are
**existing records exposed or mislabeled by the SPA**, not genuinely new
intake created by the six workstreams.

HTTPS re-read **2026-09-30T22:43:34Z** (still `DSbVZXu8` / S3
`Jc2Nyp5T…`):

| Artifact | SHA256 | Query | Grouper | insert/upsert/delete |
|---|---|---|---|---|
| Live `BankDepositReconciliation-5yI_j5mi.js` | `f70b1830dc9a7ce76e55ca9a7c332b092f7a6d907390e053d1da1f75c58f3a38` | `.from("checkalt_deposits").select(...)` | `cleared_at ?? submitted_at` | **0** |
| Historical `BankDepositReconciliation-CNd9vt9D.js` (QDJi) | `d494d87c3fd2c31908402660228b069eaa25ab1f8fd5649dbe508259c968a718` | same select | `submitted_at` only (`groupDepositsBySubmissionDate`) | **0** |

Same three existing fixture ids (`aws/tests/unknown-check-spa-relabel.test.mjs`):

| Deposit id | submitted_at | cleared_at | Live DSb label | #581/#584 recover label |
|---|---|---|---|---|
| `dep-existing-both-dates` | set | set | dated | dated |
| `dep-existing-cleared-only` | null | set | dated (cleared day) | **Date unknown** |
| `dep-existing-neither-date` | null | null | **Date unknown** | **Date unknown** |

#581 is the first SPA that **moved already-persisted deposits** into
**Date unknown** whenever `submitted_at` is null. Live #582 put the
cleared-day fallback back. Neither chunk creates rows. The recovered
candidate **will still show Date unknown** for null `submitted_at`. That
is correct grouping of the **same ids**, not a reason to delete.

Operator SELECT above confirms `created_at` if a session exists. It is
not required to classify the six-workstream writes: they have no
production insert path. **Do not delete.**

#### C2. Check Command Center `Unknown insured`

Live `CheckCommandCenter-CEe5Z_6a.js` and `QDJi` `…BdkfEkL_.js` both
contain **4** `Unknown insured` strings (fallback when
`policyholder_name`, insured payee, and `extractInsuredName(payee_line)`
are empty). Chunk sizes 451128 vs 451156 — not a query rewrite.

If a file band says **Unknown insured**, it is the same fallback on both
sides of the #582 SPA replace. It is a **label**, not a new row. Confirm
with the check’s `id` / `created_at` (read-only). Do not delete.

This file is not an apply receipt.
