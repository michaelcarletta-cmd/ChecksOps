# Release 2026-10-17: release-lock and overlay-plan pin deltas

**Status: the locks and pins below are applied in this branch** (owner-approved 2026-10-17, "approve the
release lock and pin PR"; see section 0). Nothing is deployed, live or verified: no deploy, workflow run,
inspect or AWS call was made to produce this file or the lock/pin commit. Sections 1-7 and the appendices
are the original delta inventory (branch `claude/release-2026-10-17`, base `origin/main` 307417cbe, ten
merged feature branches plus merge glue); section 0 records what was applied and what differs from it; section 0b records the live-only
reconciliation (S11/S14 and the 2026-10-11 live snapshot) applied after it.

## 0. Applied in this branch

- **Release locks** (`ops/release-locks/locked-components.json`): the nine `source.tree_hash` values were set
  to the branch values; `node scripts/validate-release-locks.mjs` passes (append-only vs trusted base
  307417cbe). Two differ from the section 1 table because this change edits files in their groups:
  `delete-check-contract` is `b487c1a75f9ae7d5f54861951a7187f442c71bfac7013ed85d120edd39ab4be2` (the contract's
  `admin_only` invariant is now `tenant_members_only`: any member of the check's tenant may delete;
  partner/shared, terminal financial and dependent financial/provider blocks remain) and
  `production-release` is `2bb158a7782967bf8a77cda530f10c81967e37b1b465a9c3c8c6199773c8b10b` (plan, workflow,
  pins). The other seven equal the section 1 actual values.
- **Overlay plan** (`ops/deployment-guard/production-api-overlay-plan.json`, 82 members): the 16 section 2
  members take the branch bytes; 46 files become members (13 ADD, 33 REPLACE), all under the new manifest
  `aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json` (earlier manifests are unchanged
  evidence). The workflow `guarded-production-lambda-overlay.yml` member choices follow the plan order.
  - Four branch hashes differ from the section 2/3 tables (the last branch commit 56786e59d changed them):
    `auth-financial-totp.mjs` `ccfe06bb…`, `admin-reset-totp.mjs` `9e85ae9a…`, `providers/onboarding/handlers.mjs`
    `708cb33e…`, `providers/onboarding/moov-sync.mjs` `1352cd5a…`. `ingest-shared-check.mjs` is not deleted:
    it is the 410 stub `a4149a0f…` (REPLACE).
  - expected_live_sha256: the previous planned bytes where they are recorded live or were earlier in the
    guarded order than a recorded apply (workflow.mjs, workflow-transitions.mjs, auth-financial-totp.mjs,
    checkalt-approve/submit/authz.mjs, providers.mjs); the existing planned live value where no apply is
    recorded (workflow-rpc.mjs, parity/checkalt-functions.mjs, homeowner.mjs, write-signature.mjs,
    email-branding.mjs, esign.mjs, app-services.mjs, write-allowlist.mjs, write-check-workflow.mjs); the
    2026-10-11 live snapshot (f78e16d99) for members new to the plan. Every value needs a read-only production
    inspect before any apply; several new REPLACE members' live bytes differ from main and need a source review.
  - Order: section 5 plus Appendix A, with one change: `admin-reset-totp.mjs` goes before
    `auth-financial-totp.mjs` (the new auth-financial-totp reads `TEAM_RESET_TOTP_ACTION` through a destructured
    dynamic import, which the overlay link check now enforces, so the reviewer's order would be refused).
  - Not overlay members (`do_not_overlay`): `package.json`, `package-lock.json` (full rebuilt ZIP), and
    `invoice-actions.mjs`, `tenant-collection-v2-uat.mjs`, `tenant-maintenance-payments-catalog-inspect.mjs`
    (absent from the live bundle; only `index.mjs`, never overlaid, and `public-invoice.mjs` import them).
  - sql_before: SQL 90 (tenant-admin.mjs, workflow-rpc.mjs), SQL 91 (providers/onboarding/*), SQL 93
    (write-allowlist.mjs, write-app-metadata.mjs), SQL 94 (library members), SQL 96 (billing members); each is in
    `sql_prerequisites` with `verified_live: false`.
- **SQL pins:** pending production pins `ops/deployment-guard/sql90-…` to `sql97-…-production-apply.json`
  (`authorization: "pending"`, `execute: false`, `expected_live_definition_sha256: null`) and pending staging
  pins `AUTHORIZED_SQL90_…` to `AUTHORIZED_SQL97_…` (`RELEASE_2026_10_17_PENDING_SQL_PINS`) in
  `scripts/deployment-guard/lib/sql-executor-auth.mjs`. They are not in the staging executor `MIGRATIONS` map or
  the `guarded-staging-sql-executor.yml` choices: no executor handler exists for them, so a choice could not run.
- **Accepted-features registry:** inventory-only invariants for delete-check, signature-requests and
  mortgage-ops; Branding's accepted contract is unchanged (notes only).

Tooling still needed before any SQL 90-97 pin can be execute-authorized (none exists; each pin's
`tooling.status` is `missing` and `intended_replacement_sha256` is null):

| SQL | Needed |
|---|---|
| 90 users-only tenant roles | production-apply tool with `--inspect`, staging executor handler + workflow choice, intended-state fingerprint, one-shot entry, runbook, PG16 tests |
| 91 Moov onboarding | same (tables, RLS, outbox CHECK); plus `aws/template.yaml` KMS/VPC endpoint and a full ZIP rebuild for the Lambdas |
| 92 signature link grant | same (column grant inspect, like SQL 77/89) |
| 93 tenant company info | same (columns + member column guard trigger); must refuse a re-run after SQL 96 |
| 94 document library restore | same (the file says its tooling is a follow-up to SQL 29/30's) |
| 95 Freedom Claims bridge removal | same (drop-only: inspect must prove no other callers) |
| 96 platform-owner tenant pricing | same (columns, audit table, setter, replaced column guard) |
| 97 financial_stepup_log server writer | same (grant + BEFORE INSERT guard); ordered after the step-6 Lambdas |

## 0b. Live-only reconciliation (applied in this branch, 2026-10-17)

The 2026-10-11 live bundle snapshot (`origin/claude/production-api-live-snapshot` f78e16d99) carries behaviour
that never reached `origin/main`: S11 (#473, remaining-balance partial disbursement) and S14 (#474/#475,
deposited `payee_line` lock), both overlaid to production on 2026-09-25, plus other live-only changes. This
release changes the same files, so its accepted bytes would have removed them. Same owner approval as section 0
(lock and pin update); `expected_live_sha256` values and earlier manifests are unchanged.

**Ported** (branch bytes now carry the live behaviour on top of the release's own changes):

| File | Live-only behaviour ported | New branch sha256 | Plan |
|---|---|---|---|
| `financial.mjs` | S11: `parseRequestedPartialCents`, `lockCheckMoney`, `disbursement_sequence`, sequence / remaining-draw replay, 23505 race replay, `remaining` in responses, `summarizeCheckMoney` re-export (3-way merge of main to live onto the release; the release's users-only membership roles and no platform `user_roles` merge are kept; `FINANCIAL_ROLES` stays in `financial-authz.mjs`) | `d94dd79fac8075627cb3775264dcdddffc31436c59267607d7087e2768cc54ef` | accepted re-pinned |
| `financial-idempotency.mjs` | S11 `disbursementSequence` key distinguisher | `14c6ca7a4bd5ea18b681d1cb83921b83b1a933255d0ef1a60546ad1fffe2f96e` (= live) | not a member (equals live) |
| `identity.mjs` | `mortgageAgentStatus` in `/identity/me` (reads `mortgage_agent_accounts`; release `isPrivilegedIdentity` kept) | `36797f5fa77d2171b2ad3f451d071cbafbca2c82bfb68ab9102783ff3c6551af` | accepted re-pinned |
| `tenant-admin.mjs` | invite binds the production Cognito lock (`bindProductionCognitoLock`, inside the release's invite savepoint; failure -> `failInvite`); hire marks `mortgage_agent_accounts` active (now in a savepoint) | `be053c68517050621b621d0cc8ba2d86c1a4b109bf8d33f8679727b99ce678ab` | accepted re-pinned |
| `identity-env.mjs` | `bindProductionCognitoLock` and the production lock SQL (needed by tenant-admin) | `e814546feded3a323461b3a7a8369e3d8a09f9a5d306d68973e15389b871f443` (= live) | not a member (equals live) |
| `ocr-descriptive-persist.mjs` | S14 `resolveWritablePayeeLine` only (exact #475 bytes) | `2152c7c252d1156825ff87a2fa4bd1f512d26d6ab71f1ab3c4bbe016fb1aff5a` | not a member; must not become one (see below) |

Tests ported: `aws/tests/financial-remaining.test.mjs`, `aws/tests/check-deposited.test.mjs` (new), the S11 cases
in `api-financial.test.mjs`, the S14 cases in `api-write.test.mjs`, `ocr-descriptive-persist.test.mjs` and
`ocr-intake-staging.test.mjs`. Audit records: `aws/audit/S11_PRODUCTION_PROMOTION.md`,
`aws/audit/S14_PRODUCTION_PROMOTION.md`. The S14 ingest guard (`guardIngestPlanPayeeLine`) has no home:
`ingest-shared-check.mjs` is the 410 stub and writes nothing. The remaining payee_line writers all apply the lock:
`write-check-workflow.mjs` (check_intake_items and claim_checks review edits, already on the release) and
`ocr-descriptive-persist.mjs` in the repository; `ocr.mjs` in production only. `ocr.mjs` stays on main's bytes
(`2e69e2ea…`) on purpose: it is `keep_live` / `do_not_overlay`, and the 2026-10-08 reconciliation proof pins the
repository file to main's bytes without the `check-deposited.mjs` import
(`aws/tests/production-lambda-source-reconciliation.test.mjs`), so production keeps its live S14 bytes
(`ecd3b253…`) through the overlay. A full ZIP rebuild from the repository would drop the OCR payee_line lock
(owner item 5 below).

Release lock re-set (same rule as section 0): `financial-ledger`
`be39d79b1ae2c316dc70c7d6b4113acc44629c8f4ea15ce9c44339a139a8d3a6` (financial.mjs, financial-idempotency.mjs). The
other locks are unchanged (`ocr-azure` too: ocr.mjs is not changed).

**Live vs main for every API file the release changes** (snapshot vs `origin/main`; "older" means the live bytes
are an earlier main version or lack later main changes, so the release loses nothing):

| File | Live vs main | Disposition |
|---|---|---|
| `admin-reset-totp.mjs`, `financial-authz.mjs`, `mortgage-library-doc-types.mjs`, `mortgage-library-docs.mjs`, `ops-readiness.mjs`, `privileged-auth.mjs`, `package.json`, `package-lock.json`, `providers/parity/{caller,db,moov-client,moov-money,moov-onboard}.mjs`, `providers/webhooks.mjs`, `tax-profiles.mjs`, `tax-secrets.mjs`, `tenant-billing-engine.mjs`, `tenant-billing-handlers.mjs`, `tenant-email-domain.mjs`, `tenant-settings-handlers.mjs` | same | nothing to reconcile |
| `app-services.mjs` | older (no homeowner-ledger endorse/document-sign link routes) | release keeps everything |
| `auth-financial-totp.mjs`, `email-branding.mjs`, `providers/catalog.mjs`, `providers/parity/checkalt-functions.mjs`, `providers/production/checkalt-{approve,authz,submit}.mjs`, `storage-write-auth.mjs`, `storage-write.mjs`, `workflow-transitions.mjs` | live = an earlier main version | release keeps everything |
| `check-endorsement.mjs` | live-only endorsement changes | already synced; only persist-diagnostic labels differ |
| `documents.mjs` | live-only document changes | already synced; only the release's retry-pdf refactor differs |
| `endorsement-composite.mjs` | live-only | release bytes equal live |
| `esign.mjs`, `homeowner.mjs`, `workflow.mjs`, `workflow-rpc.mjs`, `write-allowlist.mjs`, `write-signature.mjs` | older (live lacks main's actor/claim/path checks, `mark_manual_deposit`, Review-only amount edits, stakeholder tables) | release keeps the newer main behaviour |
| `storage.mjs` | older (suffix `LIKE` path match; main's exact `storedPathSql` fixed a cross-tenant read) | release keeps the fix |
| `financial.mjs` | live-only S11 | **ported** |
| `identity.mjs` | live-only `mortgageAgentStatus` | **ported** |
| `tenant-admin.mjs` | live-only production Cognito lock bind, `mortgage_agent_accounts` on hire, `identity_accounts` fallback lookup and loud identity/membership failures | **ported** the first two; the last two are superseded by the release's SQL 90 `aws_invite_create_user_identity` + savepoint `failInvite` |
| `tenant-check-user.mjs` | live membership-only move rule | release has the same rule (comment differs) |
| `write-app-metadata.mjs` | live-only `tenants` insert (`executeTenantsCreate`) | release has it (platform-owner gate) |
| `write-check-workflow.mjs` | live S11/S14 payee_line lock, material payee invalidation; older otherwise | release has all of it |
| `ingest-shared-check.mjs` | live S14 ingest guard | dropped with the route (410 stub, no writes) |
| `providers.mjs` | snapshot older (no moov-wallet-sync; runs 31/33 since) | release keeps everything |
| `providers/parity/moov-functions.mjs` | **live-only Platform Finance wrapper** (`platform-finance.mjs`, a live-only module) | **not ported: owner decision** (below) |
| `providers/webhook-apply.mjs` | **live-only billing settlement call** (`applyBillingProviderEvent` on every transfer webhook) | **not ported: owner decision** (below) |
| `invoice-actions.mjs`, `tenant-collection-v2-uat.mjs`, `tenant-maintenance-payments-catalog-inspect.mjs`, `workflow-delete-check.mjs` | absent from live | `do_not_overlay` |
| `ocr-descriptive-persist.mjs`, `financial-idempotency.mjs`, `identity-env.mjs` (changed by this reconciliation) | live-only S14 / S11 / Cognito lock | ported (table above); `ocr-descriptive-persist.mjs` only partly |
| `ocr.mjs` (not changed by the release) | live-only S14 lock | stays on main's bytes by the pinned keep_live contract; production keeps live bytes |

**Left for the owner** (not ported; each would change behaviour beyond restoring S11/S14):

1. `providers/parity/moov-functions.mjs` (plan member): live wraps `moov-platform-bank` and `platform-treasury` in
   `wrapPlatformFinance` with `platformFinanceBank` / `platformFinanceTreasury` from the live-only
   `providers/parity/platform-finance.mjs` (production facilitator read model, writes blocked, owner-email gate). The
   release instead serves them from `moov-onboard.mjs` `platformBank` / `platformTreasury` with `platformOwnerOnly`.
   Overlaying the release bytes switches production to the release's handlers. Keep the live wrapper (add
   `platform-finance.mjs` from the snapshot and merge the wrapper) or accept the switch.
2. `providers/webhook-apply.mjs` (plan member): live calls `tenant-billing-engine.mjs` `applyBillingProviderEvent`
   for every transfer webhook (records `tenant_maintenance_payments`). Main and the release settle billing through
   `providers/webhooks.mjs` -> `tenant-collection-v2-settlement.mjs` `applyCollectionV2ProviderCompletion` instead.
   Porting the live call could settle twice; dropping it changes which path settles live maintenance payments.
3. `ocr-descriptive-persist.mjs` (not a plan member, live bytes stay under overlay): live also persists the OCR
   amount through `public.ocr_persist_extracted_amount` (SQL not in the repository), rejects bank/disclaimer carrier
   names, clears bad carriers and cleans payee lines, using `ocr-parse.mjs` exports that only the live bundle has
   (`cleanPayeeLine`, `looksLikeBankName`, `looksLikeSecurityDisclaimer`, `matchKnownCarrier`, `normalizeAmount`,
   `sanitizeCarrierName`). Do not add this file to the plan with the branch bytes: that would remove those
   behaviours from production.
4. Not reviewed here: files outside this release's file set whose live bytes differ from main and are not an
   earlier main version. They stay live under the overlay but a full ZIP rebuild (which Moov onboarding needs)
   would replace them with main's bytes: `ocr-parse.mjs`, `check-ocr-provider.mjs`, `data.mjs`, `index.mjs`,
   `provider-flags.mjs`, `scheduled.mjs`, `write.mjs`, `admin-override-check-status.mjs`, `allowed-tables.json`,
   `tenant-collection-v2.mjs`, `tenant-email-domain-handlers.mjs`, and the live-only modules
   `providers/parity/platform-finance.mjs`, `providers/parity/tenant-receivables.mjs`,
   `providers/parity/moov-stakeholder-status.mjs`, `tenant-collection-contract-v2.mjs`.
5. `ocr.mjs`: the repository file lacks the S14 lock that production carries (see above). Porting it means
   changing the protected `ocr-azure` path and the 2026-10-08 reconciliation contract
   (`production-lambda-reconciliation-2026-10-08.json` `repo_sha256`, and the test that forbids the
   `check-deposited.mjs` import), which this change does not do.

The original inventory follows.

Values were computed on the branch tree with `node scripts/validate-release-locks.mjs` (locks) and
sha256 of the branch bytes under `aws/functions/api/` (plan members). Lock tree hashes do not
include this report (it is outside every ownership group).

## 1. Release locks whose recorded hash differs from the branch

`ops/release-locks/locked-components.json` `components.<id>.source.tree_hash`:

| Component | Recorded tree_hash | Actual tree_hash (branch) |
|---|---|---|
| `delete-check-contract` | `68c6e436c9bdf32102c46b5bf9a8314a0373d411322461311df301d6a977fc10` | `e57e9f5b3624d9fed1144921b87093e7439f6743eb7fac26a3f40ba8f111e64b` |
| `moov-webhooks` | `38f606278d8270390eee04cf1a2c4adf77975915a72a1ae323342cb85add1764` | `1064cd0b284bd942ca4538b0c3fe0361a72ba282ba6764bda19d51196cee4599` |
| `checkalt-submission` | `5e14fc4efdcd34cae497e8e2c3d175d8acabbbb7a3a5fd4540088d53fa8697ed` | `09275f18a575cfd2f0fc3c33d461eed2c7891b5ba1ef9011d4c96b63cdf7e599` |
| `financial-ledger` | `7d2f72fb0d09ee8aaadaf8f7fc8cba6d659c4474d0c959ee27af6aa84ecf1936` | `1603bb084d89ce413c47d5de00885378462404ae47c31b643e648a4c64368391` |
| `tenant-email` | `ba67f886fecc7bf93a158f19e594a88e324a7222cfd3be00d9e18901d1cec428` | `d42d37156d2978fbca1cfcc6e03340aa1b1b434174c824b1bb556486bbc73f7f` |
| `partner-sharing` | `6c803165b0833f9a3f20b37f76663bae2cfba529b71628eadb54a3437b6839d2` | `0ab1c642cc90fa269da6295573ff4f1c3a148d34df99e2dd770322fe8c7d1d9e` |
| `mortgage-ops` | `0837905420fbcc381bf03c81bd12c35e611883797b9ba1124dd070852bc15b20` | `044b605f7b1fb3f11c6596727cb3056ba7614d9e784f4fb4c04030c31005e2cd` |
| `database-rls` | `0d925c1d19ccf7e9a5013b6d614c8c8555af96cd5d8d0f1370d221f83b662230` | `3e9813863d551575c3844e5b7f2d54edb3f5f587ef98ddc095ffe6718a3ca3f7` |
| `production-release` | `3a439b8af5514eecf76f12ad4f00db68a9ad31f360a733def3b417af62ea43c7` | `6ecb5d8ca850f777be42b09ed7ecb72f84fbcc86aa6f662fd78ffb8cd11b0f43` |

All other components (including `production-spa`, PRODUCTION_LOCKED) match. `production-spa` stays
locked to the live SPA; a new SPA build from this branch needs its own guarded SPA promote.

## 2. Overlay plan members whose accepted_sha256 differs from the branch bytes

`ops/deployment-guard/production-api-overlay-plan.json` `members.<file>.accepted_sha256` (paths relative
to `aws/functions/api/`). On `origin/main` every one of these equals its accepted_sha256; the branch changes them.

| Member | Operation | Old accepted_sha256 | New (branch bytes) |
|---|---|---|---|
| `workflow.mjs` | replace | `ecd6f716d6a2203a05446afd24eb1bf9e5849e70e49a0ee86bde708fd36c1968` | `753ae14a0d04ded5782c653bd67c308067311f4fcebf835c0aac4e6659188138` |
| `workflow-transitions.mjs` | replace | `fc14b76734efa2ccd16db85f3f1c6f1ea58bf7e4f4058af574f077a621535f62` | `f11206b4ac7239b6d75eb62e739d3c83f3dc8c568aa5c6d2be98f8335166c350` |
| `auth-financial-totp.mjs` | replace | `c625e8c2b0efa5a5093c983bcd89f3660f017e22d8143bd6a2b4d88df9ab4c4d` | `0c2cabf9328ceef50035914a2affcb9a1e0ab3ba554b6db8f8081568bf1f5a39` |
| `providers/production/checkalt-approve.mjs` | replace | `4f19b9a7d582fd4132e7a9b6f65180268ccf41100e733ec63ba7bcf761f331ba` | `d2aec271955373ec24cace5bf3b08116b26511aed30810499e5e15d439f9b161` |
| `providers/production/checkalt-submit.mjs` | replace | `dd164667b1968cd487cf82b908ac3b8f2763152e700c649b53620e70425388d2` | `68b0b9a8406ac1ea6ee39641eefc4fc3522d2ca6f4de0f5d8f2b46f1bff67f7d` |
| `providers.mjs` | replace | `6ad4c7ec0ba58e8906f85fc7f8d8fef21194920fc53f253ddfed6e46bf006b9c` | `2c769fffd293deb9ad7c4d85511eb1d3847a91d091635c7886d5c51db463c0dd` |
| `workflow-rpc.mjs` | replace | `37cab8d6aac8ee1d9af70481b29dcda1e108904b68a2bc8e525d444e60ddf907` | `9eda29f177a97896d6b0d564e4ceac1aa24f9ba2c41ae7f90621c470852221f7` |
| `providers/production/checkalt-authz.mjs` | replace | `77fe337d047bfea5e0432258d0a6a4ca7ae0742dd7113fbc5bc69907ffd6ad46` | `259802f8f0af515d75b139f8bf6a4bbe24a9d7b9ae12b11b3eeae879b7107c71` |
| `providers/parity/checkalt-functions.mjs` | replace | `31e08908e587aa21552f2f6dd1a2a7bbacca88e08d4febbaf64f3368f3511357` | `cea9a31157ec2a084e6538c8454bb7b094b15111e5f5f8a05d14ebc1ce7f48ee` |
| `homeowner.mjs` | replace | `0cb700f158e01e8bf8ef5d02808fd8dd96c3710a2eebcee650db01dcc6717a95` | `c51ea27a37a72b18aed7881ae349212257b790e6ff400cbe675949574504a80c` |
| `write-signature.mjs` | replace | `867ab4e06cb1cda29802f1463f9af6c731898738e42d748da14b1780f7ad8b9c` | `14340acadf5af027646acbd636f7bde5efaae9d7ae337ffd2e4f2c17aaaf68bc` |
| `email-branding.mjs` | replace | `f248bc3fa04fdaa5221275c5812567dd701c19fd5b834e6ea391e84655d49fc0` | `fea68bc0c3f42193a13f5daaa60cfb831dce926ec150bd7b97df6675f0430b22` |
| `esign.mjs` | replace | `953ef45cb9f79e4cec5309feb971490162ac23df1b5721c025da6f7a63f40b83` | `5e2c5f48913d12b0b1916aec63d6bf9a209e5bd516ec61c5ceba01ca4754ca70` |
| `app-services.mjs` | replace | `51b2b4dc86b009dac49fc24ecbb412fe66a6e470f0173b4e5249fb3eaf7907fa` | `ca922af81aee9cd2c2d9c3d5c932cbd2ddf441de188b41d79198f76e3d789c88` |
| `write-allowlist.mjs` | replace | `9fdce9c64e5750de88a0dc2360a1383168c3f79fe20c90312689d9f74ed655b7` | `9a2fae181b33fea46eb8c99a9ba4fdade3af05044f114662b65dc01a2d226ec1` |
| `write-check-workflow.mjs` | replace | `1f5e9444afc2bf193110e48c05447af4a26346d69445abc8f96e8e1e29be787d` | `fa2c6aef0e4e6c8713f60a24804309b4cf7f9e4b9d69a379498ef9acaf621fc2` |

## 3. Files that would need to become plan members

Lambda files under `aws/functions/api/` changed by the branch that are not plan members today. New
files would be ADD members; modified files would be REPLACE members (with their live bytes as
expected_live_sha256, read by a read-only inspect). Deleted files need a plan decision (remove from
the ZIP or keep live bytes until the route is gone).

| File | Change | Branch sha256 |
|---|---|---|
| `admin-reset-totp.mjs` | modified (REPLACE) | `9e5cc04e143730d4b1752eae3801359ad73d03e24b4168041309a50b4368fe88` |
| `check-endorsement.mjs` | modified (REPLACE) | `85f4bec43620e574498a289e6d245ddd02301603fd6698a1d6bacb915e922677` |
| `documents.mjs` | modified (REPLACE) | `7cc8dd90241cffef3466117357cc47c8e3387e14869568a3411d4cad64bf795c` |
| `endorsement-composite.mjs` | modified (REPLACE) | `9fc79f57dbbbcba134fd8e0c7d7936415fd6c1c83f98fcf18bf50e73def25a80` |
| `financial-authz.mjs` | modified (REPLACE) | `0f7873199bb3a815e9afdad494d4d1afa0bc7a70454b1e04a1c36f4fecd039a8` |
| `financial.mjs` | modified (REPLACE) | `d94dd79fac8075627cb3775264dcdddffc31436c59267607d7087e2768cc54ef` (0b; was `332da536…`) |
| `identity.mjs` | modified (REPLACE) | `36797f5fa77d2171b2ad3f451d071cbafbca2c82bfb68ab9102783ff3c6551af` (0b; was `0a5ad4c0…`) |
| `ingest-shared-check.mjs` | DELETED on the branch | `a4149a0fff4b4770867da317605a35e3167b1f9daf6aafa477d79cffb17c5634` |
| `invoice-actions.mjs` | modified (REPLACE) | `866032c6f972a1d02a1c3e9649b21990d91ba62b6a5a49ac4e1f1274e2045507` |
| `mortgage-library-doc-types.mjs` | modified (REPLACE) | `8e31c5c906c1a2f05012297296a4f14be788d7462a5fd9dfb0d5c47f0f381c7a` |
| `mortgage-library-docs.mjs` | modified (REPLACE) | `16204986c7ca7b3f533bafb2e6f72f9600a5d986e41c1c260d8c310ab9dd044c` |
| `ops-readiness.mjs` | modified (REPLACE) | `2785381cd8a9e0f23f50453c81ad905e259eac0299b98790776d629cc442de6d` |
| `package-lock.json` | modified (REPLACE) | `0f901adbe95830e228a5d515c37f9e2607c0627ed9551b6de6101b85c9abc6e5` |
| `package.json` | modified (REPLACE) | `d03dd31c3ad0b915438281380593caab92bdd1a82544c0cdff6c9a81b3e88ac2` |
| `platform-announcements.mjs` | ADD (new file) | `8141775a7e75a1d2b28426f250da6e5b81eb6d33a1baea55c248a87c38b4e76c` |
| `privileged-auth.mjs` | modified (REPLACE) | `55d079a7c59f29a42c3cd5d8a03a191cbd54e28826339dcb87e2ea444e910b9b` |
| `providers/catalog.mjs` | modified (REPLACE) | `6a3bf4e5dd8a2a23efd6e2c92a601aad96c4ebac43055da7af25b53608bdc7d8` |
| `providers/onboarding/context.mjs` | ADD (new file) | `ba7315e03d55e92d4c78e838ab3486f004240337c6e527a280c9ff32d1d65189` |
| `providers/onboarding/crypto.mjs` | ADD (new file) | `2fb63cb012cb1b21213fc7d29d2770845bc2f2b5788ff3379596d2b116426e90` |
| `providers/onboarding/documents.mjs` | ADD (new file) | `231028fb19592d0cc677f8d365d1375a8c6493d905e97682267de7017fcc68ac` |
| `providers/onboarding/flags.mjs` | ADD (new file) | `723644138c363c17b08008ec267644fed4d50b8ecc1821903fb3a20672229121` |
| `providers/onboarding/handlers.mjs` | ADD (new file) | `b09a0826fd288075e1333d473bfbad27a35d8e0c2621b723e81861080f87ff89` |
| `providers/onboarding/moov-sync.mjs` | ADD (new file) | `a7eafaa161096dce88b244466bd874214952accabaa73df9369870d97adf2d28` |
| `providers/onboarding/redact.mjs` | ADD (new file) | `962017211bd33f7af8a53423f84f5bbef45cbd2c71dbbde3e2299ecca20a4cf9` |
| `providers/onboarding/store.mjs` | ADD (new file) | `56961c0affbece63d924fdf51e7e64045bd05f808fd4d25e885a420d7e9807ed` |
| `providers/onboarding/webhook-status.mjs` | ADD (new file) | `45ac151c468ade3ed161ddd279545ffd58dd4b7dbe52f6769137f8fc51b4237f` |
| `providers/parity/caller.mjs` | modified (REPLACE) | `15ba09643b5b4b77189d944c3069eabe0b9c5b7a8b453aed8e5872222d851d30` |
| `providers/parity/db.mjs` | modified (REPLACE) | `d23eefb5ee34477ac918ae5be1a892202ee16e71be2fd7570c23f53b1d552512` |
| `providers/parity/moov-client.mjs` | modified (REPLACE) | `56928d66128c4a60141ef6d7392749ebad5211acef9bce6516411f1a2420612a` |
| `providers/parity/moov-functions.mjs` | modified (REPLACE) | `7b0cde12ff969f7bfc5d83204cde77e2f322e42fe67399ca1a1e4a867eea6e75` |
| `providers/parity/moov-money.mjs` | modified (REPLACE) | `b35beaa7fe50d25941dc277056c133a67f9393e1a249e1027c32f16ec60f5e37` |
| `providers/parity/moov-onboard.mjs` | modified (REPLACE) | `bf79153ce392881101293d2c7de5625f64493e13ac8cb8c87b5d1653ee642a1e` |
| `providers/webhook-apply.mjs` | modified (REPLACE) | `28e9d27f14e9c1bd1de43b3f893705fa44b74dc0071eaa3b1895120438cd5300` |
| `providers/webhooks.mjs` | modified (REPLACE) | `3420ef809a2b7e07eb786afe311962d3472a0f027bb4a06a882841b8763df9c5` |
| `signature-library-source.mjs` | ADD (new file) | `f4eccc99e4c3af3d3b6b6b229f0d2408da682fc9176695acffa0e53486c7970f` |
| `storage-write-auth.mjs` | modified (REPLACE) | `593afcd11f9bcd50d0cef9ee5abdec5dea2ec9493d81e514aad46cfd19e461b8` |
| `storage-write.mjs` | modified (REPLACE) | `c397c52202b564917cd9d2b62853566c765b92aa6a8cd2304b6a09e74a3ed73f` |
| `storage.mjs` | modified (REPLACE) | `d92f34ca0dbba5b7b5b4c406d1a7cdf4b2e9c0a900ceddd1217dbebf3cd017d1` |
| `tax-profiles.mjs` | modified (REPLACE) | `cb49cc567d017dbf732ed6743ee57c71ba12541b161fa927eb8bf8763e518a42` |
| `tax-secrets.mjs` | modified (REPLACE) | `4a44531115a2789a5d6a921633d759143fceaa258156402585c25b1d64098d4d` |
| `tenant-admin.mjs` | modified (REPLACE) | `be053c68517050621b621d0cc8ba2d86c1a4b109bf8d33f8679727b99ce678ab` (0b; was `348e4fef…`) |
| `tenant-billing-engine.mjs` | modified (REPLACE) | `3397c65d89122f706b182970d12e83b98de461b72acba5c32c8e8d1e60944557` |
| `tenant-billing-handlers.mjs` | modified (REPLACE) | `2866356c3bf82a04d04c834fadbf94faed026a7f119e73bd8cc6f42dc2098298` |
| `tenant-check-user.mjs` | modified (REPLACE) | `f25e165ea08312ddbde6e67d5f522171368043be43a7875926e859f7c15931df` |
| `tenant-collection-v2-uat.mjs` | modified (REPLACE) | `7a0c9bc1a7e23647a9834ab7b5735e7323fcd16a7911624f8f45fb967bdb1d49` |
| `tenant-email-domain.mjs` | modified (REPLACE) | `ec57a360830347ede87d35e247397da41711d00c94252dd4cbd78b9288421dc4` |
| `tenant-library-rules.mjs` | ADD (new file) | `43abcf433458e296872dca92fc674053f3131e1dafe9278d1f76126625684d98` |
| `tenant-library.mjs` | ADD (new file) | `c9b1219b4f327f2c5ebaa6b505906b11051a0141f54b10b22dc0b816852ff7d5` |
| `tenant-maintenance-payments-catalog-inspect.mjs` | modified (REPLACE) | `c7b83fed089ceec3656de2a4976a3e084fa7305c5cd7275ee26cc17c03da78fe` |
| `tenant-settings-handlers.mjs` | modified (REPLACE) | `9766306dfccffbb515c6dd1f0a329b91a407f53eb97c1ed148c9dcc5b9f24717` |
| `workflow-delete-check.mjs` | modified (REPLACE) | `bdfd5f3a380a81bc192959b59541a6cf98c82da5b04dd64b670cb8166e0ada9f` |
| `write-app-metadata.mjs` | modified (REPLACE) | `32b805080a38f222ad99b8d558b16ce05795f6eb3a6d7a86b60d9fe2493766d5` |

Notes:
- `workflow-delete-check.mjs` is in `do_not_overlay` (Delete Check is served from `workflow.mjs`); its
  change (users-only membership gate) reaches production only if that decision changes.
- `package.json` / `package-lock.json` add the Moov onboarding KMS client dependency; the Lambda ZIP must be
  rebuilt from these, never from an old build.
- `providers/onboarding/*.mjs` also need `aws/template.yaml` (KMS keys, VPC endpoint, env flags with
  `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED="false"`); the template is not a plan member.

## 4. New pending SQL pins

None of these files has a pin yet (no `AUTHORIZED_SQL9x_*` entry in
`scripts/deployment-guard/lib/sql-executor-auth.mjs`, no `ops/deployment-guard/sql9x-*-production-apply.json`,
no `applied-migrations.ledger.json` entry, no overlay-plan `sql_prerequisites` entry). Each needs a reviewed
staging pin (source_sha256 below, expected live / intended state from a read-only inspect), a staging
apply and acceptance, then a production pin.

| SQL file | source_sha256 (branch) |
|---|---|
| `aws/workflows/sql/90_users_only_tenant_roles.sql` | `1ee9c1d12b3ad71a58ecec30ee223f8ab660be74d162d9ada9482c5640c26d86` |
| `aws/workflows/sql/91_moov_onboarding.sql` | `199bfa1a528d219a8683b61ae6264d84dd5b08caa74564691374c8c6c42b71e3` |
| `aws/workflows/sql/92_signature_request_check_files_link_grant.sql` | `ceef6482271f5572db20f5a6db3b4bbcf77e29ada2290f03f53af7fb6e725e17` |
| `aws/workflows/sql/93_tenant_company_info.sql` | `d90ec7f9ef14ca60b805e94337021259c8f9ce9ec80ed9781a47c64dbd6f8cfa` |
| `aws/workflows/sql/94_document_library_restore.sql` | `ef865f65c8ccdfda51e1b6f65a828f9d6bed16bdbd1879a1a85cf4ba30a990a2` |
| `aws/workflows/sql/95_remove_freedom_claims_bridge.sql` | `0cf0dafdcd06afc5d6993d06668fb8d56b5812ad6c1aa0bfda437a1bcb8f4137` |
| `aws/workflows/sql/96_platform_owner_tenant_pricing.sql` | `18109fed72bf8446dbe0c9560507ae6ed1fed1eb49f972142e78112479e257b6` |
| `aws/workflows/sql/97_financial_stepup_log_server_writer.sql` | `e3c8fd413f1d60030dd65192bb8696387229a4fd33fc2ae234cd61e52fbb79db` |

Already pinned by the document-library-restore branch (unchanged here, bytes match their pins):
`aws/rls/sql/29_mortgage_ops_library_parity.sql` (`e8d416a5...`, ops/deployment-guard/sql29-...-production-apply.json)
and `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql` (`d30c7caf...`, sql30-...-production-apply.json).

SQL 93 was changed on the release branch (merge glue): it no longer creates
`aws_member_update_tenant_branding`; it requires SQL 90 and adds the `aws_tenants_member_column_guard`
BEFORE UPDATE trigger. Any pin taken from the branding-missing-fixes branch bytes is stale.

Numbering on the branch is unique for 90-97 (90 users-only, 91 Moov onboarding, 92 signature link grant,
93 tenant company info, 94 document library, 95 Freedom Claims bridge removal, 96 platform-owner tenant pricing,
97 financial_stepup_log server writer). The older duplicate
prefixes 67, 68, 70 and 76 exist on `origin/main` already and are not touched.

## 5. Required deploy order (reviewer's corrected order, verified against the branch import graph)

Every Lambda file can now be overlaid alone: the files main's live modules import from keep compatibility
exports (`privileged-auth.mjs` `isPrivilegedRoleList` (always false), `parity/caller.mjs` `isPlatformAdmin`
(delegates to `is_platform_owner()`), `financial-authz.mjs` `FINANCIAL_ROLES` (unused by the new code),
`tenant-settings-handlers.mjs` `handleSaveTenantCompanyBranding` (410), and a 410 stub `ingest-shared-check.mjs`
(delete in a later release)). `aws/tests/release-reverse-imports.test.mjs` checks every export main's API files
import (566 edges, fixture `aws/tests/fixtures/main-api-import-edges.json`) still exists on the branch. The overlay
guard (`classifyLive` → `linkProblems`) already refused a member whose new bytes drop a name a live file imports
statically; it now also checks destructured dynamic imports (`const { x } = await import('./y.mjs')`) in both
directions. Remaining order constraints are the forward ones in the import graph (Appendix A) plus SQL.

Staging first for every step, with a staging acceptance reference before the matching production step.

1. **Guarded SQL executor Lambda first** (`aws/write-path/guarded-sql-executor/index.mjs`): the SQL 29/30 support
   (and the pins the later SQL steps need) live there. Deploy it through its reviewed path before any SQL below.
2. **SQL:** 29 → 30 → 90 → 93 / 94 (91 and 92 any time before their Lambdas) → 96. SQL 97 is NOT in this step:
   it goes after `auth-financial-totp.mjs` and `admin-reset-totp.mjs` (step 6). Do not re-run SQL 93 after SQL 96.
   SQL before Lambda: SQL 90 before `tenant-admin.mjs` / `workflow-rpc.mjs` and the member-only RLS users; SQL 91
   before `providers/onboarding/*`; SQL 92 before `esign.mjs` (soft: the link is skipped without it); SQL 93 before
   `write-allowlist.mjs` / `write-app-metadata.mjs` company columns; SQL 94 before the library Lambdas (step 7);
   SQL 96 before the billing Lambdas; SQL 95 after `app-services.mjs` (step 8); SQL 97 after step 6's step-up writers.
3. **`privileged-auth.mjs` → `identity.mjs`** (identity imports the new `isPrivilegedIdentity`). Independent of the
   rest thanks to the `isPrivilegedRoleList` shim.
4. **`workflow-transitions.mjs` → `workflow.mjs`** (workflow imports the new `TENANT_MEMBER_SQL`).
   `workflow-delete-check.mjs` stays `do_not_overlay`.
5. **The parity files** (`providers/parity/checkalt-functions.mjs`, `db.mjs`, `moov-functions.mjs`, `moov-money.mjs`,
   `moov-onboard.mjs`, `moov-client.mjs`) **→ `providers/parity/caller.mjs`** (any order works with the
   `isPlatformAdmin` shim; this keeps the old callers on the shim for the shortest time).
6. **Step-up and authorization**, right after SQL 90 (invites break between SQL 90 and the new tenant-admin):
   `write-allowlist.mjs` FIRST (final position: before `auth-financial-totp.mjs` / `checkalt-authz.mjs`; it removes
   the client `financial_stepup_log` insert and allowlists SQL 93's company columns, which exist after step 2) →
   `auth-financial-totp.mjs` → `providers/production/checkalt-submit.mjs` / `checkalt-approve.mjs` →
   `providers/production/checkalt-authz.mjs` → `financial-authz.mjs` / `financial.mjs` → `admin-reset-totp.mjs` /
   `tenant-admin.mjs` → **SQL 97** (needs both Lambdas that set `app.stepup_writer`).
   Soft dependency: `auth-financial-totp.mjs` reads `TEAM_RESET_TOTP_ACTION` from `admin-reset-totp.mjs` at run
   time; until the new admin-reset-totp is live it is undefined, so a `team.reset_totp` step-up is refused
   (`action_mismatch`) — nothing crashes, teammate 2FA reset is simply unavailable in that gap.
7. **Library:** `mortgage-library-doc-types.mjs` → ADD `tenant-library-rules.mjs` / `tenant-library.mjs` /
   `signature-library-source.mjs` / `platform-announcements.mjs` → `mortgage-library-docs.mjs` /
   `write-app-metadata.mjs` / `storage-write-auth.mjs` / `storage-write.mjs` / `storage.mjs`.
8. **Branding, e-sign, routes:** `email-branding.mjs` / `write-signature.mjs` / `esign.mjs` → `documents.mjs`
   (imports the new `requireSignatureRequestActor` from esign) → `homeowner.mjs` (imports `tenant-library.mjs`) →
   `app-services.mjs` (imports the library and announcements handlers) → `tenant-settings-handlers.mjs` → the
   `ingest-shared-check.mjs` stub → **SQL 95**.
   Staging: `app-services.mjs` needs the `tenant-management-v2` route reconciliation first — the staging live
   router (84a8e9e7) carries a `tenant-management-v2` route these bytes do not (see the plan notes); do not overlay
   app-services.mjs in staging until that is reconciled.
9. **Onboarding and providers:** after SQL 91 and the `aws/template.yaml` KMS keys / VPC endpoint / env
   (`AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED="false"`): ADD `providers/onboarding/*` (flags, crypto, redact → store →
   context → documents / moov-sync / webhook-status → handlers) → `providers/catalog.mjs` /
   `providers/webhook-apply.mjs` / `providers/webhooks.mjs` → `write-check-workflow.mjs` (held for SQL 89, already
   live) → `providers.mjs` last. `@aws-sdk/client-kms` (new in `aws/functions/api/package.json`) is not in the live
   ZIP: production onboarding needs a full rebuilt ZIP, not an overlay, before `AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED`
   is turned on.
   Billing: `tenant-billing-engine.mjs` / `tenant-billing-handlers.mjs` after SQL 96 (pricing saves call the SQL 96
   setter; without it they answer 503 `pricing_setter_missing`).
10. **One SPA build and promote** from this branch, after the Lambdas its screens call.

## 6. Retirements on the release branch (owner-approved)

- `supabase/functions/partner-shared-checks/` and its `supabase/config.toml` entry are deleted (the old
  unauthenticated Supabase partner-code check lookup; nothing called it). AWS partner sharing
  (connect_partner_by_code / share_check_with_partner, aws/rls/sql/32) is unchanged.
- `tenant-company-branding-save` is retired: `app-services.mjs` (a plan member) answers it with 410
  `route_retired`, and its handler is removed from `tenant-settings-handlers.mjs`. SQL 93's member column
  guard therefore no longer allows `business_address`, `business_phone` or `email_reply_to`.

## 7a. SQL 89 tooling after SQL 95

SQL 95 drops SQL 70's `aws_ingest_shared_check`. The SQL 89 precondition `sql70_ingest_function_security_definer`
(`scripts/deployment-guard/lib/sql-executor-auth.mjs`) is now skipped once SQL 89 is `already_applied`, so a later
read-live of SQL 89 (applied in staging and production) does not report a collision. A pre-apply SQL 89 run still
requires the ingest function; nothing else in the SQL 89 rules changed.

## 7. Platform-owner tenant pricing (SQL 96, owner decision 2026-10-17)

- Pricing columns on `tenants` (platform owner only, audited in the new `tenant_pricing_audit`):
  monthly_rate_cents, referral_discount_cents, is_founding_partner, per_check_billing_enabled,
  per_check_rate_cents, next_day_rate_cents, same_day_rate_cents, mortgage_ops_initial_rate_cents,
  mortgage_ops_additional_rate_cents. `platform_fee_schedules` writes become platform owner only (members read).
- New Lambda bytes: `tenant-billing-engine.mjs`, `tenant-billing-handlers.mjs`, `providers/parity/moov-onboard.mjs`
  (fee schedule upsert/cancel platform owner only) and `providers/parity/moov-money.mjs` (browser
  `platform_fee_cents` ignored) are listed in section 3 with their branch sha256.
- `tenant_billing_settings` (billing_enabled, billing_day_of_month) is written only by the platform-owner
  billing admin; it has no RLS policy in `aws/rls/sql`, so SQL 96 does not change it.

## Appendix A. Import graph of the changed API files (branch)

Each changed or added file under `aws/functions/api/` with its imports of other changed files. `[needs new: ...]`
lists names main's version of that module does not export, i.e. a forward order constraint (the importer goes
after the target). Imports without it link against main's live bytes.

```
A platform-announcements.mjs -> (no changed imports)
A providers/onboarding/context.mjs -> providers/parity/caller.mjs; providers/parity/moov-client.mjs; providers/onboarding/flags.mjs [needs new: onboardingDeployment]
A providers/onboarding/crypto.mjs -> (no changed imports)
A providers/onboarding/documents.mjs -> providers/parity/moov-client.mjs; providers/onboarding/crypto.mjs [needs new: OnboardingError]; providers/onboarding/redact.mjs [needs new: isNetworkError, moovErrorCode, onboardingLog]; providers/onboarding/store.mjs [needs new: completeOutbox, enqueueOutbox, failOutboxAttempt, loadAccount, publicDocument]
A providers/onboarding/flags.mjs -> (no changed imports)
A providers/onboarding/handlers.mjs -> providers/parity/moov-client.mjs; providers/parity/caller.mjs; providers/parity/db.mjs; providers/onboarding/crypto.mjs [needs new: OnboardingError]; providers/onboarding/context.mjs [needs new: isUuid, loadOnboardingMoovContext, resolveOnboardingAccess, resolveOnboardingEnvironment]; providers/onboarding/documents.mjs [needs new: createUploadUrl, finalizeDocument, viewUrl]; providers/onboarding/flags.mjs [needs new: onboardingDeployment]; providers/onboarding/moov-sync.mjs [needs new: ensureMoovAccount, syncOnboardingToMoov]; providers/onboarding/redact.mjs [needs new: isNetworkError, moovErrorCode, onboardingLog, redact]; providers/onboarding/store.mjs [needs new: buildOnboardingView, decryptProfileEin, enqueueOutbox, loadAccount, loadDocument, loadDocuments, loadDueOutbox, loadProfile, loadRepresentatives, lockTenantOnboarding, maskLast4, publicRepresentative, removeRepresentative, upsertProfile, upsertRepresentative, validateBusiness, validateRepresentatives]
A providers/onboarding/moov-sync.mjs -> providers/parity/moov-client.mjs; providers/parity/db.mjs; providers/onboarding/crypto.mjs [needs new: OnboardingError]; providers/onboarding/redact.mjs [needs new: isNetworkError, moovErrorCode, onboardingLog]; providers/onboarding/store.mjs [needs new: completeOutbox, decryptProfileEin, decryptRepresentativeDob, failOutboxAttempt, loadAccount, loadProfile, loadRepresentatives, markRepresentativeSsnResubmit, markRepresentativeSynced, moovAddress, setProfileSyncState]
A providers/onboarding/redact.mjs -> (no changed imports)
A providers/onboarding/store.mjs -> providers/onboarding/crypto.mjs [needs new: OnboardingError, decryptPii, encryptPii]
A providers/onboarding/webhook-status.mjs -> providers/parity/moov-client.mjs
A signature-library-source.mjs -> write-signature.mjs; tenant-library-rules.mjs [needs new: LIBRARY_BUCKET, LIBRARY_MAX_BYTES, normalizeContentType]; tenant-library.mjs [needs new: claimBelongsToTenant, isTenantMember, shareableLibraryDocument]; write-allowlist.mjs
A tenant-library-rules.mjs -> mortgage-library-doc-types.mjs [needs new: LIBRARY_CATEGORIES, libraryCategoryOf]
A tenant-library.mjs -> mortgage-library-doc-types.mjs [needs new: libraryCategoryOf]; tenant-library-rules.mjs [needs new: LIBRARY_BUCKET, isLibraryContentType, isLibrarySize, libraryObjectPath, normalizeContentType]; write-allowlist.mjs
M admin-reset-totp.mjs -> (no changed imports)
M app-services.mjs -> homeowner.mjs; documents.mjs; tenant-admin.mjs; esign.mjs; check-endorsement.mjs; admin-reset-totp.mjs; tax-profiles.mjs; tenant-settings-handlers.mjs; tenant-billing-handlers.mjs; tenant-library.mjs [needs new: handleClaimLibraryDocuments, handleHomeownerRevokeLibraryDocument, handleHomeownerShareLibraryDocument, handleHomeownerSharedDocumentUrl, handleTenantLibraryDocumentCreate]; signature-library-source.mjs [needs new: handleSignatureLibraryDocumentCopy]; platform-announcements.mjs [needs new: handlePlatformAnnouncements]
M auth-financial-totp.mjs -> ops-readiness.mjs; privileged-auth.mjs; identity.mjs; providers/production/checkalt-authz.mjs; admin-reset-totp.mjs [needs new: TEAM_RESET_TOTP_ACTION]
M check-endorsement.mjs -> email-branding.mjs; endorsement-composite.mjs
M documents.mjs -> esign.mjs [needs new: requireSignatureRequestActor]; endorsement-composite.mjs
M email-branding.mjs -> (no changed imports)
M endorsement-composite.mjs -> (no changed imports)
M esign.mjs -> email-branding.mjs [needs new: resolveTenantDocumentBranding]; write-signature.mjs
M financial-authz.mjs -> (no changed imports)
M financial-idempotency.mjs -> (no changed imports)
M financial.mjs -> identity.mjs; financial-authz.mjs; privileged-auth.mjs; financial-idempotency.mjs (0b: equals live)
M homeowner.mjs -> email-branding.mjs; tenant-library.mjs [needs new: loadSharedDocumentsSafely]
M identity-env.mjs -> (no changed imports)
M identity.mjs -> privileged-auth.mjs [needs new: isPrivilegedIdentity]
M invoice-actions.mjs -> providers/parity/caller.mjs
M mortgage-library-doc-types.mjs -> (no changed imports)
M mortgage-library-docs.mjs -> mortgage-library-doc-types.mjs
M ocr-descriptive-persist.mjs -> (no changed imports)
M ops-readiness.mjs -> (no changed imports)
M privileged-auth.mjs -> ops-readiness.mjs
M providers.mjs -> identity.mjs; providers/catalog.mjs; providers/webhooks.mjs; providers/onboarding/handlers.mjs [needs new: handleMoovOnboarding, isOnboardingFunction]; providers/onboarding/flags.mjs [needs new: moovOnboardingProductionEnabled]; app-services.mjs
M providers/catalog.mjs -> (no changed imports)
M providers/parity/caller.mjs -> identity.mjs; providers/parity/moov-client.mjs
M providers/parity/checkalt-functions.mjs -> providers/parity/caller.mjs; providers/production/checkalt-authz.mjs
M providers/parity/db.mjs -> (no changed imports)
M providers/parity/moov-client.mjs -> (no changed imports)
M providers/parity/moov-functions.mjs -> providers/parity/moov-client.mjs; providers/parity/caller.mjs; providers/parity/db.mjs; providers/parity/moov-money.mjs; providers/parity/moov-onboard.mjs
M providers/parity/moov-money.mjs -> providers/parity/moov-client.mjs; providers/parity/caller.mjs; providers/parity/db.mjs
M providers/parity/moov-onboard.mjs -> providers/parity/moov-client.mjs; providers/parity/caller.mjs; email-branding.mjs; providers/parity/db.mjs
M providers/production/checkalt-approve.mjs -> identity.mjs; providers/production/checkalt-authz.mjs
M providers/production/checkalt-authz.mjs -> (no changed imports)
M providers/production/checkalt-submit.mjs -> identity.mjs; providers/production/checkalt-authz.mjs
M providers/webhook-apply.mjs -> providers/parity/moov-client.mjs; providers/parity/db.mjs; providers/onboarding/webhook-status.mjs [needs new: applyOnboardingWebhookStatus]
M providers/webhooks.mjs -> providers/webhook-apply.mjs; providers/onboarding/flags.mjs [needs new: productionOnboardingWebhookApplyEnabled]; providers/onboarding/webhook-status.mjs [needs new: applyProductionOnboardingWebhook]
M storage-write-auth.mjs -> mortgage-library-docs.mjs; tenant-library-rules.mjs [needs new: libraryObjectPath]
M storage-write.mjs -> storage.mjs; storage-write-auth.mjs; tenant-library-rules.mjs [needs new: LIBRARY_BUCKET, isLibraryContentType, isLibrarySize]; write-allowlist.mjs
M storage.mjs -> mortgage-library-docs.mjs
M tax-profiles.mjs -> tax-secrets.mjs
M tax-secrets.mjs -> (no changed imports)
M tenant-admin.mjs -> email-branding.mjs; identity-env.mjs [needs new: bindProductionCognitoLock] (0b: live identity-env.mjs exports it)
M tenant-billing-engine.mjs -> providers/parity/moov-client.mjs
M tenant-billing-handlers.mjs -> tenant-billing-engine.mjs
M tenant-check-user.mjs -> (no changed imports)
M tenant-collection-v2-uat.mjs -> (no changed imports)
M tenant-email-domain.mjs -> email-branding.mjs
M tenant-maintenance-payments-catalog-inspect.mjs -> identity.mjs
M tenant-settings-handlers.mjs -> tenant-email-domain.mjs
M workflow-delete-check.mjs -> write-allowlist.mjs; workflow-transitions.mjs [needs new: TENANT_MEMBER_SQL]
M workflow-rpc.mjs -> identity.mjs; write-allowlist.mjs
M workflow-transitions.mjs -> (no changed imports)
M workflow.mjs -> identity.mjs; write-allowlist.mjs; workflow-transitions.mjs [needs new: TENANT_MEMBER_SQL]
M write-allowlist.mjs -> (no changed imports)
M write-app-metadata.mjs -> mortgage-library-doc-types.mjs; mortgage-library-docs.mjs; tenant-library-rules.mjs [needs new: isLibraryContentType, isLibrarySize, libraryFolderFor, libraryObjectPath]
M write-check-workflow.mjs -> write-allowlist.mjs; write-signature.mjs; write-app-metadata.mjs
M write-signature.mjs -> (no changed imports)
```

Forward constraints:

```
app-services.mjs after platform-announcements.mjs (handlePlatformAnnouncements)
app-services.mjs after signature-library-source.mjs (handleSignatureLibraryDocumentCopy)
app-services.mjs after tenant-library.mjs (handleClaimLibraryDocuments, handleHomeownerRevokeLibraryDocument, handleHomeownerShareLibraryDocument, handleHomeownerSharedDocumentUrl, handleTenantLibraryDocumentCreate)
auth-financial-totp.mjs after admin-reset-totp.mjs (TEAM_RESET_TOTP_ACTION)
documents.mjs after esign.mjs (requireSignatureRequestActor)
esign.mjs after email-branding.mjs (resolveTenantDocumentBranding)
homeowner.mjs after tenant-library.mjs (loadSharedDocumentsSafely)
identity.mjs after privileged-auth.mjs (isPrivilegedIdentity)
providers.mjs after providers/onboarding/flags.mjs (moovOnboardingProductionEnabled)
providers.mjs after providers/onboarding/handlers.mjs (handleMoovOnboarding, isOnboardingFunction)
providers/onboarding/context.mjs after providers/onboarding/flags.mjs (onboardingDeployment)
providers/onboarding/documents.mjs after providers/onboarding/crypto.mjs (OnboardingError)
providers/onboarding/documents.mjs after providers/onboarding/redact.mjs (isNetworkError, moovErrorCode, onboardingLog)
providers/onboarding/documents.mjs after providers/onboarding/store.mjs (completeOutbox, enqueueOutbox, failOutboxAttempt, loadAccount, publicDocument)
providers/onboarding/handlers.mjs after providers/onboarding/context.mjs (isUuid, loadOnboardingMoovContext, resolveOnboardingAccess, resolveOnboardingEnvironment)
providers/onboarding/handlers.mjs after providers/onboarding/crypto.mjs (OnboardingError)
providers/onboarding/handlers.mjs after providers/onboarding/documents.mjs (createUploadUrl, finalizeDocument, viewUrl)
providers/onboarding/handlers.mjs after providers/onboarding/flags.mjs (onboardingDeployment)
providers/onboarding/handlers.mjs after providers/onboarding/moov-sync.mjs (ensureMoovAccount, syncOnboardingToMoov)
providers/onboarding/handlers.mjs after providers/onboarding/redact.mjs (isNetworkError, moovErrorCode, onboardingLog, redact)
providers/onboarding/handlers.mjs after providers/onboarding/store.mjs (buildOnboardingView, decryptProfileEin, enqueueOutbox, loadAccount, loadDocument, loadDocuments, loadDueOutbox, loadProfile, loadRepresentatives, lockTenantOnboarding, maskLast4, publicRepresentative, removeRepresentative, upsertProfile, upsertRepresentative, validateBusiness, validateRepresentatives)
providers/onboarding/moov-sync.mjs after providers/onboarding/crypto.mjs (OnboardingError)
providers/onboarding/moov-sync.mjs after providers/onboarding/redact.mjs (isNetworkError, moovErrorCode, onboardingLog)
providers/onboarding/moov-sync.mjs after providers/onboarding/store.mjs (completeOutbox, decryptProfileEin, decryptRepresentativeDob, failOutboxAttempt, loadAccount, loadProfile, loadRepresentatives, markRepresentativeSsnResubmit, markRepresentativeSynced, moovAddress, setProfileSyncState)
providers/onboarding/store.mjs after providers/onboarding/crypto.mjs (OnboardingError, decryptPii, encryptPii)
providers/webhook-apply.mjs after providers/onboarding/webhook-status.mjs (applyOnboardingWebhookStatus)
providers/webhooks.mjs after providers/onboarding/flags.mjs (productionOnboardingWebhookApplyEnabled)
providers/webhooks.mjs after providers/onboarding/webhook-status.mjs (applyProductionOnboardingWebhook)
signature-library-source.mjs after tenant-library-rules.mjs (LIBRARY_BUCKET, LIBRARY_MAX_BYTES, normalizeContentType)
signature-library-source.mjs after tenant-library.mjs (claimBelongsToTenant, isTenantMember, shareableLibraryDocument)
storage-write-auth.mjs after tenant-library-rules.mjs (libraryObjectPath)
storage-write.mjs after tenant-library-rules.mjs (LIBRARY_BUCKET, isLibraryContentType, isLibrarySize)
tenant-library-rules.mjs after mortgage-library-doc-types.mjs (LIBRARY_CATEGORIES, libraryCategoryOf)
tenant-library.mjs after mortgage-library-doc-types.mjs (libraryCategoryOf)
tenant-library.mjs after tenant-library-rules.mjs (LIBRARY_BUCKET, isLibraryContentType, isLibrarySize, libraryObjectPath, normalizeContentType)
workflow-delete-check.mjs after workflow-transitions.mjs (TENANT_MEMBER_SQL)
workflow.mjs after workflow-transitions.mjs (TENANT_MEMBER_SQL)
write-app-metadata.mjs after tenant-library-rules.mjs (isLibraryContentType, isLibrarySize, libraryFolderFor, libraryObjectPath)
```

## Appendix B. Listed, not changed

- `src/pages/payments/InvoicesTab.tsx:216` still falls back to `/freedom` for the settings link outside white-label
  routes (left as is on request).
