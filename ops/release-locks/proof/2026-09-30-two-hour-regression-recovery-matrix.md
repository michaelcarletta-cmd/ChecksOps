# Two-hour production regression / recovery matrix

Read-only investigation. **No production writes.** This file does not
authorize Lambda, SPA, S3, CloudFront, SQL, IAM, Cognito, env, or Moov
changes.

Window: **2026-09-30 16:15 ET** (`20:15 UTC`) through investigation capture
**22:18 UTC** (18:18 ET).

Method: HTTPS GET of live `checksops.com` / `www.checksops.com` /
`staging.checksops.com`; git / `gh` PR bodies; cloud-agent transcripts for
`bc-c413824f`, `bc-5f3c64b4`, `bc-5e70b10c`, `bc-0f07b8bb`, `bc-d61f3d7d`,
`bc-f8b0cb28`. No AWS management APIs (no Lambda GetFunction, no S3 List,
no CloudFront Get).

Companion JSON: `ops/deployment-guard/2026-09-30-two-hour-regression-fingerprints.json`.

## Hard recovery rules

- Do **not** rebuild from `origin/main` (`e3e4649478a0`).
- Do **not** restore an older SPA entry over current live
  `index-DSbVZXu8.js`.
- Do **not** replace production Lambda or SPA wholesale.
- Recovery must be **additive / compositional** onto whatever is live at
  apply time (today: `DSbVZXu8` + Lambda `jN5d0C34…`).
- An incomplete SPA composition **must not** be promoted.
- Preserve later-window settlement + hostname-guard. Restore only missing
  pre-regression and accepted-but-overwritten code.

Do not restore: `index-BPbQUNFr.js`, `index-C9QrEEkl.js`,
`index-C_fh5VBD.js`, `index-CEKjixtZ.js`, `index-DbYbvb6d.js`,
`index-QDJiUFF1.js`.

---

## 1. Pre-window production fingerprints (~16:15 ET)

Closest proven live read: **20:18:29 UTC** (settings agent post-staging
verify) and immediately-before pins at **20:25:44** / **20:30:09**. Same
identity as 16:15 ET: no production SPA/Lambda write between 20:15 and
20:31.

### Production SPA at ~16:15 ET

| Field | Value |
|---|---|
| Entry | `/assets/index-DbYbvb6d.js` |
| Entry SHA256 | `1dfbe6c4d2a77027b7ac3cf89eece450b4d9b290b829a2d88ff0244332e6e47c` |
| index.html SHA256 | `705f86309699aa6df4e15f12d0e8b0e3c31ff742eed18195859f7cd226e18040` |
| S3 version | `FVo1QSfkEI4csW.r3iuuFu0rds.pzPKN` |
| Last-Modified | `2026-09-30T20:01:34Z` |
| WalletOps chunk | `/assets/WalletOps-j3z9RyZ7.js` (`bf3ccfbe…0760a83`) |
| Banner hide | present (`checksops-production-host`) |

Provenance: WalletOps activity-recovery apply (PR #575,
`50b8a94e4860`, 19:47 UTC) plus an **unattributed** `index.html`-only
rewrite at 20:01:34 that kept the same JS entry and added production
banner-hide CSS. That rewrite is **before** the window; preserve the
banner behavior; do not attribute it to a workstream.

Earlier the same afternoon (not live at 16:15): funding UX
`index-C_fh5VBD.js` (18:06 UTC, PR #566). Sep 27 lock
`index-BPbQUNFr.js` was already historical.

### Production Lambda at ~16:15 ET

| Field | Value |
|---|---|
| Function | `checksops-production-prep-api` |
| CodeSha256 | `RaFQKBA489aj69N8e76eCQdzlJ2ijkA1YFNFPa+D9r4=` |
| RevisionId | `33e3f02d-3a97-4b8e-be31-4e104b7027f3` |
| LastModified | `2026-09-30T19:56:32Z` |
| Changed member | `workflow.mjs` sha256 `bd18db71ab9277eea74add41f99ed5324841a163815a756578f60cfd50bf7bab` |

Provenance: endorsing confirmation overlay (PR #576, 19:56 UTC),
**before** the window. Only `handleCheckTransition` success payload
`new_stage` from saved `check_stage`. Live `workflow.mjs` is **not**
`main` (live still carries delete-check S3 cleanup that `main` lacks).

`origin/main` at window start: `e3e4649478a0` (PR #578 hostname-guard
source merge, 20:02 UTC). Main is **not** the live SPA.

---

## 2. Every change after ~16:15 ET

### Merges to main

| UTC | Event |
|---|---|
| 20:02 | PR #578 merged (hostname-guard **source**). No SPA upload by that PR. |

No other main merges in the window.

### Production writes (shared targets)

| UTC / ET | Writer | What |
|---|---|---|
| 20:31 / 16:31 | `bc-c413824f` PR #581 | Lambda overlay `RaFQKBA…` → `JlChQagI3F26AEcQrFHRPvNsVLRGmO8nR9RKMK7ERJ0=` (5 settings members on a fresh live ZIP) |
| 20:34–20:35 / 16:34–16:35 | same | SPA per-object put `DbYbvb6d` → `QDJiUFF1`; S3 `NNalIXDhhdaOovnqFQwZVSJ99V0BFZz9`; invalidation `IEEF8WPGTAFVCF2ZHV1LGGTRI8` |
| ~21:11 / 17:11 | `bc-5f3c64b4` PR #582 | Lambda overlay → `jN5d0C340DZlKM7/zbxxiZk+atoAqv9CI2quPZq5IG8=` / Rev `a37c1225-1287-4070-9ef5-be5f04f9efe8` |
| 21:20 / 17:20 | same | SPA per-object put `QDJiUFF1` → **`DSbVZXu8`**; S3 `Jc2Nyp5THf1j30gf21cQHeMoApSs8uDw`; invalidation `ICJ7PG1IS6CFP3I4BGR2ZQE6E` |

### Staging writes (not production, listed for collision)

| UTC | Writer | What |
|---|---|---|
| 20:16–20:18 | PR #581 | Staging SPA `QDJiUFF1`; invalidation `I9LK4OKDTFVPSP9MXIRDZFRBTU`; staging Lambda no-op |
| ~20:37 | PR #582 | Staging SPA already `DSbVZXu8` (last-modified 20:37:48) when settings re-read at 21:09 |
| 21:30–21:31 | PR #584 | Staging Lambda + SPA `C8adM6cZ`; invalidation `I1WXK5J3RUO8AWYFEI7WS0FHRE` |

### Source / safeguard only (no production write)

| UTC | PR / branch | What |
|---|---|---|
| 20:02+ | #579 `cursor/preserve-builds-safeguard-771b` | Preserve-builds / deployment-guard source. Last commit `ed1f1f395` 22:11. **Does not deploy.** |
| 20:04 | #580 WalletOps guard-protect | Locks `DbYbvb6d` into guard evidence. 0 writes. |
| 20:10–20:42 | #581 settings compose/lock docs | After apply, lock files still describe `QDJiUFF1` as live (now stale). |
| 20:19–20:27 | #582 settlement source | `38e659b46` writer; `82460c8c2` compose onto hostname-guard. |
| 21:23–21:42 | #583 / #584 | Insured Name + branding compose onto `DSbVZXu8`. Staging only. Production **not authorized**. |
| 21:31 / 22:14 | #585 / #586 | Delete-check source + read-only lock refresh to `DSbVZXu8`. 0 writes. |

### PRs opened in the window (none merged except #578 just before cutoff)

#579, #580, #581, #582, #583, #584, #585, #586. All still open except #578
(merged 20:02). #574 endorsing source merged 19:30 (before window).

Historical Sep 27 lock on `origin/main` (`index-BPbQUNFr.js`) was **not**
updated. Live left that pin days earlier.

---

## 3. Current live production (this task, 22:18 UTC)

HTTPS `GET https://checksops.com/` and `https://www.checksops.com/`:

| Field | Value |
|---|---|
| Entry | `/assets/index-DSbVZXu8.js` |
| Entry SHA256 | `8da351ee4060d065e626b382fec06acf9a7099317184980979b95468e7e4bbe5` |
| index.html SHA256 | `e93fe5488c013aed91626da1ee608978f702796a24e08350306ccb4c3163e75f` |
| S3 version | `Jc2Nyp5THf1j30gf21cQHeMoApSs8uDw` |
| ETag | `f92d3a12bd1f8eec9c200dbe71c05ae3` |
| Last-Modified | `Wed, 30 Sep 2026 21:20:11 GMT` |
| CSS | `/assets/index-DgosuTnh.css` sha256 `ea80f9b7ce0048409157f50638622d8fbe364c5763340e417e15715a74b9968f` |
| Hostname guard | present in `index.html` |
| Settlement RPC string | `save_claim_settlement_breakdown` present in entry |
| `environmentReady` in entry | **absent** (present on `DbYbvb6d` / `QDJiUFF1` entries) |
| `tenantLogoUrl` in entry | **absent** |

Lambda identity is **not** re-read via AWS APIs in this task. Independent
re-reads at 21:21 (PR #582) and 21:24 (PR #584) still showed
`jN5d0C34…` / `a37c1225-…`. Treat that as current unless a later
workstream moved it.

Staging now: `/assets/index-C8adM6cZ.js` (21:31, PR #584). Not a
production recovery candidate.

Orphaned-but-still-reachable historical objects (HTTPS 200, not referenced
by current `index.html`): `QDJiUFF1`, `DbYbvb6d`, `C_fh5VBD`,
`BPbQUNFr`, `WalletOps-D5mOeN7Q.js`, `WalletOps-j3z9RyZ7.js`,
`BankDepositReconciliation-CNd9vt9D.js`. Reachability is **not**
permission to restore them as the live entry.

---

## 4. Component matrix

### A. Production SPA

| Cell | Evidence |
|---|---|
| **~16:15 ET** | `index-DbYbvb6d.js` + banner-hide `index.html` `705f8630…` / S3 `FVo1QSfk…`. Accepted WalletOps recovery (PR #575) on funding-prod `C_fh5VBD` lineage. |
| **Change after** | 20:35 settings compose `QDJiUFF1` (items 1/2/5 on `DbYbvb6d` source). 21:20 settlement/hostname-guard **fresh clean build** `DSbVZXu8` from `82460c8c2` (PR #582). Immediately-before matched `QDJiUFF1` so the guard did not `DEPLOYMENT_COLLISION`; source was **not** the live settings tree. |
| **Current** | `index-DSbVZXu8.js` / `e93fe548…` / S3 `Jc2Nyp5T…` / LM 21:20:11. Hostname-guard + settlement intercept present. |
| **Missing / regressed** | WalletOps activity-recovery markers (`environmentReady` in entry on `DbYbvb6d`/`QDJiUFF1`, absent on `DSbVZXu8`). Settings items #1 billing persist, #2 branding/`tenantLogoUrl`, #5 deposit submission-date grouping. PR #584 diagnosis: live still rendered Payee/`payee_line` and lacked `tenantLogoUrl`. Insured Name compose exists only as **staging** `C8adM6cZ`. |
| **Working source** | WalletOps: `9afb57fe52a42c` / PR #575 / files in `ops/deployment-guard/walletops-activity-recovery-prod-accepted.json`. Settings 1/2/5: `84ba11f4c5fbc5` / `2cd3cd2e7f3667` / PR #581. Insured Name + branding persist: `be29ba391` / PR #584 (must compose onto **current** live, not promote `C8adM6cZ` if live moved). Keep live settlement: `82460c8c2` / `src/integrations/aws/client.ts` intercept + `write-claim-settlement.mjs`. |
| **Minimal recovery** | One new composed SPA from **current live source identity** (`DSbVZXu8` / `82460c8c2`) plus the WalletOps six-file recovery hunks plus settings/Insured Name owned files listed in PR #581/#584 composition JSON. Fresh Vite build. Official `production-spa-upload.mjs` per-object put **only after** a later reviewed apply authorization, exclusive lease, immediately-before TOCTOU vs then-live pins. Never upload `QDJiUFF1` or `DbYbvb6d` as `index.html`. |
| **Collision risk** | **High / `SOURCE_COMPOSITION_REQUIRED`.** Open SPA writers: #581 (stale `QDJiUFF1` lock), #582 (live settlement), #584 (staging compose), #579 (guard source), #580 (stale `DbYbvb6d` protect), #585/#586 (delete-check + lock refresh). Promoting #581, #583, or #584's staging dist over a newer live entry is the incomplete-composition failure mode. |

### B. Production Lambda `checksops-production-prep-api`

| Cell | Evidence |
|---|---|
| **~16:15 ET** | `RaFQKBA…` / `33e3f02d-…`. Only proven delta vs mid-afternoon: endorsing `workflow.mjs` `bd18db71…`. |
| **Change after** | 20:31 settings overlay → `JlChQag…` members `app-services.mjs`, `tenant-settings-handlers.mjs`, `tenant-email-domain-handlers.mjs`, `providers/parity/moov-functions.mjs`, `providers/parity/moov-stakeholder-status.mjs`. Preserved then: `workflow.mjs` `bd18db71…`, `workflow-rpc.mjs` `09bb37e6…`, esign/OCR/signature-submit hashes in PR #581 proof. ~21:11 settlement overlay → `jN5d0C34…`. This task did **not** re-hash live ZIP members. |
| **Current** | Last independent read: `jN5d0C34…` / `a37c1225-…`. Member preservation after the settlement overlay is **unproven** here (no GetFunction). |
| **Missing / regressed** | If the settlement overlay was a thin add of `write-claim-settlement.mjs` + `workflow-rpc.mjs` onto a fresh `JlChQag` ZIP, settings members and endorsing `workflow.mjs` should still be present. If any overlay used `main` `workflow.mjs` or a thin template, endorsing `new_stage` and/or delete-check S3 cleanup would be gone. **Must verify live member SHA256s before any apply** (official verify-live / trusted collector). Do not assume. |
| **Working source** | Endorsing: live-patched `workflow.mjs` from PR #576 (`bd18db71…`), **not** `main`. Settings handlers: PR #581 overlay set / `84ba11f4`. Settlement: `38e659b46` `write-claim-settlement.mjs` + RPC case. Branding handler fixes: PR #584 two-member overlay (staging applied). |
| **Minimal recovery** | Fresh-download live ZIP. Overlay **only** members proven missing vs the accepted set. RevisionId CAS. Never `sam deploy` / wholesale UpdateFunctionCode. If `workflow.mjs` is still `bd18db71…` and settings members still match #581, Lambda recovery may be **none** or only the two branding handlers from #584. |
| **Collision risk** | **High.** Same function written twice in the window. Next overlay without live-member verify can drop endorsing or settings. PR #576's live `workflow.mjs` ≠ main. |

### C. Hostname / staging-banner guard

| Cell | Evidence |
|---|---|
| **~16:15 ET** | Present on live `index.html` (20:01:34 rewrite). Source later merged as PR #578 at 20:02. |
| **Change after** | Carried through `QDJiUFF1` and `DSbVZXu8`. |
| **Current** | Present on live `index.html`. |
| **Missing** | None observed. |
| **Working source** | `e3e4649478a0` / live `index.html` snippet. |
| **Minimal recovery** | Keep current `index.html` guard. Do not restore a pre-guard HTML. |
| **Collision risk** | Low if compose keeps `index.html` from live `DSbVZXu8` source. |

### D. WalletOps activity recovery

| Cell | Evidence |
|---|---|
| **~16:15 ET** | Live (`DbYbvb6d` / `WalletOps-j3z9RyZ7.js`). `environmentReady` in entry. Chunk still HTTPS-200. |
| **Change after** | Settings compose claimed it kept WalletOps files (`WalletOps-D5mOeN7Q.js` on `QDJiUFF1`). Settlement `DSbVZXu8` is a clean hostname-guard + settlement build; entry **lost** `environmentReady`. |
| **Current** | Not the live accepted recovery identity. Nav title `WalletOps` remains. Recovery hunks not evidenced in the live entry. |
| **Missing** | Env-aware `selectPaymentWallet` / `readWallet` / credit = destination-not-source / `environmentReady`. Files: `src/pages/WalletOps.tsx`, `src/hooks/useWalletOps.ts`, `src/hooks/usePaymentProviderEligibility.ts`, `src/lib/payments/wallets.ts`, `src/lib/payments/selectPaymentWallet.ts`, `src/lib/payments/reconcileWalletFundingTransfer.ts` (PR #575). |
| **Working source** | `9afb57fe52a42c` + `50b8a94e4860` on `cursor/walletops-activity-recovery-prod-2d41`. |
| **Minimal recovery** | Hunk-compose those six files onto `82460c8c2` / live `DSbVZXu8` source. Do not promote `DbYbvb6d` or `WalletOps-j3z9RyZ7.js` as the entry. |
| **Collision risk** | #580 still protects `DbYbvb6d` as if live. Next WalletOps promote without recomposition hits `PROTECTED_COMPOSITION_REQUIRED`. |

### E. Settings / billing / branding / deposits (items 1, 2, 5)

| Cell | Evidence |
|---|---|
| **~16:15 ET** | **Not** on production SPA. Live was WalletOps recovery only. Settings existed as source/staging. |
| **Change after** | Applied to production at 20:35 as `QDJiUFF1` + `JlChQag…`. Overwritten at 21:20 by `DSbVZXu8`. |
| **Current** | Settings compose is **not** the live entry. PR #584: Payee/`payee_line`, no `tenantLogoUrl`. |
| **Missing** | #1 monthly billing persist without collection. #2 company/invoice/email branding persist + sending-subdomain UI removal + `tenantLogoUrl`. #5 deposit grouping by `submitted_at`. Later Insured Name column (PR #584) never reached production. |
| **Working source** | `84ba11f4` / `2cd3cd2e` / PR #581 owned files; then `be29ba391` / PR #584 for Insured Name + persist-safe logo handlers. |
| **Minimal recovery** | Compose those owned files onto live `DSbVZXu8` source (PR #584 already started this for staging). Do not promote #581 `QDJiUFF1` or #583 (older dbyb base). |
| **Collision risk** | #581 lock still calls `QDJiUFF1` production-applied. Promoting it now is a **regression** against settlement/hostname-guard. |

### F. Claim Ledger settlement writer

| Cell | Evidence |
|---|---|
| **~16:15 ET** | Not live. |
| **Change after** | Source `38e659b46` / compose `82460c8c2`. Production Lambda ~21:11, SPA 21:20. |
| **Current** | Live SPA contains `save_claim_settlement_breakdown`. Marker J remains `accepted: false`. |
| **Missing** | None vs its own contract. Must **keep**. |
| **Working source** | `82460c8c2` / PR #582. |
| **Minimal recovery** | Leave on the live baseline. Any recovery compose must keep `write-claim-settlement.mjs`, RPC intercept, and `ClaimLedgerCard`. |
| **Collision risk** | A settings or WalletOps wholesale SPA would drop it. That is the incomplete-composition hazard. |

### G. Endorsing confirmation (`new_stage`)

| Cell | Evidence |
|---|---|
| **~16:15 ET** | Live in Lambda `workflow.mjs` `bd18db71…` (applied 19:56). |
| **Change after** | Settings overlay recorded that hash unchanged. Settlement overlay membership **not** re-verified. |
| **Current** | Unknown without live ZIP member hash. |
| **Missing** | Possible if a later overlay replaced `workflow.mjs` with `main`. |
| **Working source** | PR #576 patched live file, not `23c4a0e36` from main alone. |
| **Minimal recovery** | If live `workflow.mjs` ≠ `bd18db71…`, overlay the **live-patched** endorsing site only. Never copy `main` `workflow.mjs`. |
| **Collision risk** | Medium. Same-file `SOURCE_RECONCILIATION_REQUIRED` if another stream also edits `workflow.mjs`. |

### H. Claim-number save / ledger+signature compose

| Cell | Evidence |
|---|---|
| **~16:15 ET** | `detected_claim_number` already in `DbYbvb6d` entry (count 6). Staging overlays #572/#577 were before the window. Production Lambda then was `RaFQKBA` (endorsing-only member change). |
| **Change after** | No dedicated production claim-number write in-window. `detected_claim_number` still count 6 on `DSbVZXu8`. |
| **Current** | Entry still has the string. Live `workflow-rpc.mjs` membership after `jN5d0C34` unproven. |
| **Missing** | Unproven. Verify live `workflow-rpc.mjs` still `09bb37e6…` or later settlement-compatible hash that keeps SQL43/44 + markers A–I. |
| **Working source** | #572 `6812f301a`; #577 `d51e6d6ea` / `e2331d9f6`. |
| **Minimal recovery** | Overlay `workflow-rpc.mjs` only if live dropped peel/SQL44/signature inserts. |
| **Collision risk** | Medium; settlement already touched `workflow-rpc.mjs`. |

### I. Deployment-guard / preserve-builds / release-locks

| Cell | Evidence |
|---|---|
| **~16:15 ET** | `origin/main` still pins Sep 27 `index-BPbQUNFr.js`. Live was already `DbYbvb6d`. |
| **Change after** | #579 source safeguard (observe real artifact hashes, map repo→ZIP/SPA members, fail-closed missing evidence). #580/#581/#586 wrote **stale or sequential** live pins on their branches. None of those lock PRs are merged. |
| **Current** | `origin/main` lock still `BPbQUNFr` (false vs live). #586 branch pins `DSbVZXu8` (closest lock to live). #581 branch pins `QDJiUFF1` (stale). #580 protects `DbYbvb6d` (stale). |
| **Missing** | Authoritative merged lock of **current** live `DSbVZXu8`. Incomplete lock updates must not be used as apply authority. |
| **Working source** | This matrix + #579 collector behavior. Live HTTPS pins above. |
| **Minimal recovery** | After a reviewed **composed** apply (not now): lock the **new** live identity. Until then, record `DSbVZXu8` as live and every older entry as do-not-restore. Do **not** merge #581/#580 locks as if they were current. |
| **Collision risk** | **Highest for a false recovery.** Promoting a safeguard PR or an old lock as the SPA is the incomplete-composition failure the user called out. #579 must stay source-only. |

### J. Delete-check / other

| Cell | Evidence |
|---|---|
| **~16:15 ET** | Live `workflow.mjs` still carried delete-check S3 cleanup (PR #576). |
| **Change after** | #585/#586 source + read-only lock. No production deploy. |
| **Current** | Unchanged by those PRs. |
| **Missing** | Out of this recovery scope unless live `workflow.mjs` was replaced. |
| **Working source** | Live ZIP member, not `main`. |
| **Minimal recovery** | None unless member verify fails. |
| **Collision risk** | Low if they remain source-only. |

### K. Database / IAM / Cognito / env / Moov

No in-window production SQL apply, IAM, Cognito, env, or Moov/provider
writes were evidenced. SQL43/44 were already production-applied earlier
(#577 recorded hashes; not reapplied). **Do not touch.**

---

## 5. Proposed minimal recovery (apply later — not authorized now)

This task **stops here**. A later reviewed release workstream may apply
only if live pins still match or it recomposes.

1. Re-read live SPA (`index.html` + entry SHA256 + S3 version) and live
   Lambda (CodeSha256 + RevisionId + **member SHA256s** for
   `workflow.mjs`, `workflow-rpc.mjs`, settings/branding handlers,
   `write-claim-settlement.mjs`). Stop on drift (`DEPLOYMENT_COLLISION`).
2. Build one composed candidate from **then-live SPA source**
   (`82460c8c2` if still `DSbVZXu8`) plus:
   - WalletOps six-file recovery from `9afb57fe`
   - Settings / Insured Name / branding owned files from `be29ba391`
     (which already sits on `82460c8c2`) plus any #581 files still missing
   - Keep hostname-guard `index.html` and settlement intercept
3. Prove the candidate entry contains: `save_claim_settlement_breakdown`,
   `checksops-production-host`, `environmentReady` (or equivalent recovery
   markers), `tenantLogoUrl`, deposit submission-date grouping / Insured
   Name (not `payee_line`). Fail closed if any accepted marker is absent
   (`SOURCE_COMPOSITION_REQUIRED`).
4. Lambda: overlay only members whose live hashes drifted from the
   accepted set. Fresh live ZIP. Never main `workflow.mjs`.
5. Official guard only: lease + signed receipt + immediately-before
   TOCTOU + per-object SPA put + overlay apply. No `s3 sync --delete`, no
   old dist reuse, no reclaim.
6. Then update release-locks to the **new** live identity. Do not merge
   stale `QDJiUFF1` / `DbYbvb6d` locks.

### Explicitly refuse

- Promote PR #581, #583, #575, #570, or staging `C8adM6cZ` as production
  recovery.
- Rebuild from `main` and upload.
- Restore `DbYbvb6d` or `QDJiUFF1` over `DSbVZXu8`.
- Treat PR #579 as a deployable recovery.
- Infer production approval from this matrix.

---

## 6. Investigation limits

- Lambda current **member** hashes were not collected (user forbade
  touching Lambda/S3/CloudFront management APIs).
- Authenticated UI was not exercised.
- WalletOps / BankDeposit Vite chunks are nested; entry-string absence of
  `WalletOps-*.js` is true for `DbYbvb6d` and `QDJiUFF1` as well. The
  regression signal used here is entry `environmentReady` + PR #584's
  Payee/`tenantLogoUrl` diagnosis + PR #582's own "fresh clean build from
  hostname-guard + settlement only" statement.
- Concurrent delete-check agent (`bc-d61f3d7d`) was still RUNNING during
  capture; #586 is lock-only.

This document is evidence. It is not an apply receipt.
