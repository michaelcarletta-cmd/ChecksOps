# Release 2026-10-17: release-lock and overlay-plan pin deltas

Documentation only. Nothing in `ops/release-locks/` or `ops/deployment-guard/production-api-overlay-plan.json`
is edited by the release branch `claude/release-2026-10-17` (base `origin/main` 307417cbe, ten merged
feature branches plus merge glue). Every value below must be reviewed and recorded through the
reviewed release-lock / overlay-plan process before any guarded staging or production run.
No deploy, workflow run or AWS call was made to produce this file.

Values were computed on the branch tree with `node scripts/validate-release-locks.mjs` (locks) and
sha256 of the branch bytes under `aws/functions/api/` (plan members). Lock tree hashes do not
include this report (it is outside every ownership group).

## 1. Release locks whose recorded hash differs from the branch

`ops/release-locks/locked-components.json` `components.<id>.source.tree_hash`:

| Component | Recorded tree_hash | Actual tree_hash (branch) |
|---|---|---|
| `delete-check-contract` | `68c6e436c9bdf32102c46b5bf9a8314a0373d411322461311df301d6a977fc10` | `e57e9f5b3624d9fed1144921b87093e7439f6743eb7fac26a3f40ba8f111e64b` |
| `moov-webhooks` | `38f606278d8270390eee04cf1a2c4adf77975915a72a1ae323342cb85add1764` | `718e28495a4e0d1f72112b0f3b8dc2bf30426c29c306b1d9549390549a9dc42c` |
| `checkalt-submission` | `5e14fc4efdcd34cae497e8e2c3d175d8acabbbb7a3a5fd4540088d53fa8697ed` | `09275f18a575cfd2f0fc3c33d461eed2c7891b5ba1ef9011d4c96b63cdf7e599` |
| `financial-ledger` | `7d2f72fb0d09ee8aaadaf8f7fc8cba6d659c4474d0c959ee27af6aa84ecf1936` | `ec0fc59c51e9643e63dd1c53b35c9f38e7819e4c036e2bd4edc521259323b6c0` |
| `tenant-email` | `ba67f886fecc7bf93a158f19e594a88e324a7222cfd3be00d9e18901d1cec428` | `d42d37156d2978fbca1cfcc6e03340aa1b1b434174c824b1bb556486bbc73f7f` |
| `partner-sharing` | `6c803165b0833f9a3f20b37f76663bae2cfba529b71628eadb54a3437b6839d2` | `0ab1c642cc90fa269da6295573ff4f1c3a148d34df99e2dd770322fe8c7d1d9e` |
| `mortgage-ops` | `0837905420fbcc381bf03c81bd12c35e611883797b9ba1124dd070852bc15b20` | `044b605f7b1fb3f11c6596727cb3056ba7614d9e784f4fb4c04030c31005e2cd` |
| `database-rls` | `0d925c1d19ccf7e9a5013b6d614c8c8555af96cd5d8d0f1370d221f83b662230` | `25acdd10dc4598c78fafda9ee77b3c8679225c9003e0a36de5e42b2824756630` |
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
| `auth-financial-totp.mjs` | replace | `c625e8c2b0efa5a5093c983bcd89f3660f017e22d8143bd6a2b4d88df9ab4c4d` | `b0bf0b4f4502a160f9134d6c9fd6b19176017e2b5ef77f68232c250dcf575dc5` |
| `providers/production/checkalt-approve.mjs` | replace | `4f19b9a7d582fd4132e7a9b6f65180268ccf41100e733ec63ba7bcf761f331ba` | `d2aec271955373ec24cace5bf3b08116b26511aed30810499e5e15d439f9b161` |
| `providers/production/checkalt-submit.mjs` | replace | `dd164667b1968cd487cf82b908ac3b8f2763152e700c649b53620e70425388d2` | `68b0b9a8406ac1ea6ee39641eefc4fc3522d2ca6f4de0f5d8f2b46f1bff67f7d` |
| `providers.mjs` | replace | `6ad4c7ec0ba58e8906f85fc7f8d8fef21194920fc53f253ddfed6e46bf006b9c` | `2c769fffd293deb9ad7c4d85511eb1d3847a91d091635c7886d5c51db463c0dd` |
| `workflow-rpc.mjs` | replace | `37cab8d6aac8ee1d9af70481b29dcda1e108904b68a2bc8e525d444e60ddf907` | `862c9acdde2135e35ecc0d5592eb6f547cc44a75425d368ee39692cb7627517b` |
| `providers/production/checkalt-authz.mjs` | replace | `77fe337d047bfea5e0432258d0a6a4ca7ae0742dd7113fbc5bc69907ffd6ad46` | `259802f8f0af515d75b139f8bf6a4bbe24a9d7b9ae12b11b3eeae879b7107c71` |
| `providers/parity/checkalt-functions.mjs` | replace | `31e08908e587aa21552f2f6dd1a2a7bbacca88e08d4febbaf64f3368f3511357` | `42ea2659194eee844e0e50a7997fa63381be8f5744a9d9dcef58d840f613870d` |
| `homeowner.mjs` | replace | `0cb700f158e01e8bf8ef5d02808fd8dd96c3710a2eebcee650db01dcc6717a95` | `c51ea27a37a72b18aed7881ae349212257b790e6ff400cbe675949574504a80c` |
| `write-signature.mjs` | replace | `867ab4e06cb1cda29802f1463f9af6c731898738e42d748da14b1780f7ad8b9c` | `14340acadf5af027646acbd636f7bde5efaae9d7ae337ffd2e4f2c17aaaf68bc` |
| `email-branding.mjs` | replace | `f248bc3fa04fdaa5221275c5812567dd701c19fd5b834e6ea391e84655d49fc0` | `fea68bc0c3f42193a13f5daaa60cfb831dce926ec150bd7b97df6675f0430b22` |
| `esign.mjs` | replace | `953ef45cb9f79e4cec5309feb971490162ac23df1b5721c025da6f7a63f40b83` | `e4f02745f6b9e1e78871a7290d8b5556146e92b90a6a986c328871801d791c07` |
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
| `admin-reset-totp.mjs` | modified (REPLACE) | `4f5c0332fffe961bda618b1f69cd93138d6d8180effe5b65c032c224c0996e14` |
| `check-endorsement.mjs` | modified (REPLACE) | `85f4bec43620e574498a289e6d245ddd02301603fd6698a1d6bacb915e922677` |
| `documents.mjs` | modified (REPLACE) | `2f98678e4a019c604bc58821f01aa9cfc8de467ce46a0b04121c8fbdf1faba3f` |
| `endorsement-composite.mjs` | modified (REPLACE) | `9fc79f57dbbbcba134fd8e0c7d7936415fd6c1c83f98fcf18bf50e73def25a80` |
| `financial-authz.mjs` | modified (REPLACE) | `1f3dca0e31053264cdebe8bb3fd5b6668ec375f988ae0dde27732bf221edff55` |
| `financial.mjs` | modified (REPLACE) | `332da536c8225c343f73df0275798e7d0621344d512b71f24691c5a0bf0627bb` |
| `identity.mjs` | modified (REPLACE) | `0a5ad4c00b258102da38db83722615dae328f80e4d363cb140579f2db5381d7c` |
| `ingest-shared-check.mjs` | DELETED on the branch | (absent) |
| `invoice-actions.mjs` | modified (REPLACE) | `866032c6f972a1d02a1c3e9649b21990d91ba62b6a5a49ac4e1f1274e2045507` |
| `mortgage-library-doc-types.mjs` | modified (REPLACE) | `8e31c5c906c1a2f05012297296a4f14be788d7462a5fd9dfb0d5c47f0f381c7a` |
| `mortgage-library-docs.mjs` | modified (REPLACE) | `16204986c7ca7b3f533bafb2e6f72f9600a5d986e41c1c260d8c310ab9dd044c` |
| `ops-readiness.mjs` | modified (REPLACE) | `2785381cd8a9e0f23f50453c81ad905e259eac0299b98790776d629cc442de6d` |
| `package-lock.json` | modified (REPLACE) | `0f901adbe95830e228a5d515c37f9e2607c0627ed9551b6de6101b85c9abc6e5` |
| `package.json` | modified (REPLACE) | `d03dd31c3ad0b915438281380593caab92bdd1a82544c0cdff6c9a81b3e88ac2` |
| `platform-announcements.mjs` | ADD (new file) | `8141775a7e75a1d2b28426f250da6e5b81eb6d33a1baea55c248a87c38b4e76c` |
| `privileged-auth.mjs` | modified (REPLACE) | `22d52e0662a53a2dae3cf1c23e9bbf37e31ba7bd45f38c262345e6426b23110e` |
| `providers/catalog.mjs` | modified (REPLACE) | `8ab3531f631655ed00c5fe6fcc70640e2990eb996d470c51231e896d16ae503f` |
| `providers/onboarding/context.mjs` | ADD (new file) | `ba7315e03d55e92d4c78e838ab3486f004240337c6e527a280c9ff32d1d65189` |
| `providers/onboarding/crypto.mjs` | ADD (new file) | `2fb63cb012cb1b21213fc7d29d2770845bc2f2b5788ff3379596d2b116426e90` |
| `providers/onboarding/documents.mjs` | ADD (new file) | `231028fb19592d0cc677f8d365d1375a8c6493d905e97682267de7017fcc68ac` |
| `providers/onboarding/flags.mjs` | ADD (new file) | `723644138c363c17b08008ec267644fed4d50b8ecc1821903fb3a20672229121` |
| `providers/onboarding/handlers.mjs` | ADD (new file) | `b4e250e07181a507d9badba1e2422bad40d92e1137331a5b7d28fbf5f8965d39` |
| `providers/onboarding/moov-sync.mjs` | ADD (new file) | `a7eafaa161096dce88b244466bd874214952accabaa73df9369870d97adf2d28` |
| `providers/onboarding/redact.mjs` | ADD (new file) | `50731d7554466be3b51a540d871085f5789abec01af8326c4ee68b99d8e6b463` |
| `providers/onboarding/store.mjs` | ADD (new file) | `56961c0affbece63d924fdf51e7e64045bd05f808fd4d25e885a420d7e9807ed` |
| `providers/onboarding/webhook-status.mjs` | ADD (new file) | `45ac151c468ade3ed161ddd279545ffd58dd4b7dbe52f6769137f8fc51b4237f` |
| `providers/parity/caller.mjs` | modified (REPLACE) | `3bdda56066ca8d2f00345afb3e0675af3a42599aa9f07eac351e84d7b0a063ed` |
| `providers/parity/db.mjs` | modified (REPLACE) | `d23eefb5ee34477ac918ae5be1a892202ee16e71be2fd7570c23f53b1d552512` |
| `providers/parity/moov-client.mjs` | modified (REPLACE) | `56928d66128c4a60141ef6d7392749ebad5211acef9bce6516411f1a2420612a` |
| `providers/parity/moov-functions.mjs` | modified (REPLACE) | `7b0cde12ff969f7bfc5d83204cde77e2f322e42fe67399ca1a1e4a867eea6e75` |
| `providers/parity/moov-money.mjs` | modified (REPLACE) | `b35beaa7fe50d25941dc277056c133a67f9393e1a249e1027c32f16ec60f5e37` |
| `providers/parity/moov-onboard.mjs` | modified (REPLACE) | `228e10616e69aeb8ffadd433516a038669a4c802cdf657ca17c3881879344d56` |
| `providers/webhook-apply.mjs` | modified (REPLACE) | `8b86c7b10db7db27e94aa152bc417252dc1cf3fe9667c2d32791c0e41f2c191e` |
| `providers/webhooks.mjs` | modified (REPLACE) | `3420ef809a2b7e07eb786afe311962d3472a0f027bb4a06a882841b8763df9c5` |
| `signature-library-source.mjs` | ADD (new file) | `f4eccc99e4c3af3d3b6b6b229f0d2408da682fc9176695acffa0e53486c7970f` |
| `storage-write-auth.mjs` | modified (REPLACE) | `593afcd11f9bcd50d0cef9ee5abdec5dea2ec9493d81e514aad46cfd19e461b8` |
| `storage-write.mjs` | modified (REPLACE) | `c397c52202b564917cd9d2b62853566c765b92aa6a8cd2304b6a09e74a3ed73f` |
| `storage.mjs` | modified (REPLACE) | `d92f34ca0dbba5b7b5b4c406d1a7cdf4b2e9c0a900ceddd1217dbebf3cd017d1` |
| `tax-profiles.mjs` | modified (REPLACE) | `cb49cc567d017dbf732ed6743ee57c71ba12541b161fa927eb8bf8763e518a42` |
| `tax-secrets.mjs` | modified (REPLACE) | `4a44531115a2789a5d6a921633d759143fceaa258156402585c25b1d64098d4d` |
| `tenant-admin.mjs` | modified (REPLACE) | `de8c400e05f597202d2170fc80608aa0fe28f9c48cf5f482220a3f3567384642` |
| `tenant-billing-engine.mjs` | modified (REPLACE) | `3397c65d89122f706b182970d12e83b98de461b72acba5c32c8e8d1e60944557` |
| `tenant-billing-handlers.mjs` | modified (REPLACE) | `2866356c3bf82a04d04c834fadbf94faed026a7f119e73bd8cc6f42dc2098298` |
| `tenant-check-user.mjs` | modified (REPLACE) | `f25e165ea08312ddbde6e67d5f522171368043be43a7875926e859f7c15931df` |
| `tenant-collection-v2-uat.mjs` | modified (REPLACE) | `7a0c9bc1a7e23647a9834ab7b5735e7323fcd16a7911624f8f45fb967bdb1d49` |
| `tenant-email-domain.mjs` | modified (REPLACE) | `ec57a360830347ede87d35e247397da41711d00c94252dd4cbd78b9288421dc4` |
| `tenant-library-rules.mjs` | ADD (new file) | `43abcf433458e296872dca92fc674053f3131e1dafe9278d1f76126625684d98` |
| `tenant-library.mjs` | ADD (new file) | `c9b1219b4f327f2c5ebaa6b505906b11051a0141f54b10b22dc0b816852ff7d5` |
| `tenant-maintenance-payments-catalog-inspect.mjs` | modified (REPLACE) | `c7b83fed089ceec3656de2a4976a3e084fa7305c5cd7275ee26cc17c03da78fe` |
| `tenant-settings-handlers.mjs` | modified (REPLACE) | `e07dd50fbac217388b654e23ca424d9bbfdd3de7f512f9c0683c0ab535b749f7` |
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
| `aws/workflows/sql/90_users_only_tenant_roles.sql` | `edd1113234abaa32dc7f079ba9d17591a13572fe4ebbe281f59153598491b41d` |
| `aws/workflows/sql/91_moov_onboarding.sql` | `f6bd83a2fe5c9e3ba54dec3234b0222e3c6464ecc68aab69cea5fbe95cfd9b00` |
| `aws/workflows/sql/92_signature_request_check_files_link_grant.sql` | `ceef6482271f5572db20f5a6db3b4bbcf77e29ada2290f03f53af7fb6e725e17` |
| `aws/workflows/sql/93_tenant_company_info.sql` | `d90ec7f9ef14ca60b805e94337021259c8f9ce9ec80ed9781a47c64dbd6f8cfa` |
| `aws/workflows/sql/94_document_library_restore.sql` | `ef865f65c8ccdfda51e1b6f65a828f9d6bed16bdbd1879a1a85cf4ba30a990a2` |
| `aws/workflows/sql/95_remove_freedom_claims_bridge.sql` | `0cf0dafdcd06afc5d6993d06668fb8d56b5812ad6c1aa0bfda437a1bcb8f4137` |
| `aws/workflows/sql/96_platform_owner_tenant_pricing.sql` | `18109fed72bf8446dbe0c9560507ae6ed1fed1eb49f972142e78112479e257b6` |

Already pinned by the document-library-restore branch (unchanged here, bytes match their pins):
`aws/rls/sql/29_mortgage_ops_library_parity.sql` (`e8d416a5...`, ops/deployment-guard/sql29-...-production-apply.json)
and `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql` (`d30c7caf...`, sql30-...-production-apply.json).

SQL 93 was changed on the release branch (merge glue): it no longer creates
`aws_member_update_tenant_branding`; it requires SQL 90 and adds the `aws_tenants_member_column_guard`
BEFORE UPDATE trigger. Any pin taken from the branding-missing-fixes branch bytes is stale.

Numbering on the branch is unique for 90-96 (90 users-only, 91 Moov onboarding, 92 signature link grant,
93 tenant company info, 94 document library, 95 Freedom Claims bridge removal, 96 platform-owner tenant pricing). The older duplicate
prefixes 67, 68, 70 and 76 exist on `origin/main` already and are not touched.

## 5. Required deploy order

Collected from the SQL headers, the branch commit messages, `ops/production-sql-29-30-apply.md`, the
sql29/sql30 apply JSON `order_note`s and the code dependencies. Staging first for every step, with a
staging acceptance reference before the matching production step.

SQL order:
1. **SQL 29** (`aws/rls/sql/29_mortgage_ops_library_parity.sql`) **before SQL 90**. The tools refuse SQL 29
   (`sql90_not_applied`) once SQL 90's `aws_is_tenant_member(uuid)` exists.
2. **SQL 30** (`aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql`) **before SQL 94** (SQL 94 accepts
   SQL 30's CHECK as its predecessor; SQL 30 refuses SQL 94's).
3. **SQL 90** (`90_users_only_tenant_roles.sql`) after SQL 29 and SQL 80/35/24 (it refuses with
   `sql90_prerequisite_missing` otherwise).
4. **SQL 93** after SQL 90 (refuses with `sql93_prerequisite_missing` without `aws_is_tenant_member` and
   `aws_write_tenants`).
5. **SQL 94** after SQL 90 and SQL 30.
6. **SQL 96** (`96_platform_owner_tenant_pricing.sql`) after SQL 90 and SQL 93 (refuses with
   `sql96_prerequisite_missing` otherwise). It replaces SQL 93's `aws_tenants_member_column_guard`: do not
   re-run SQL 93 after SQL 96 (that restores the member-only guard and blocks the platform owner's pricing
   setter until SQL 96 is re-run).
7. **SQL 91** and **SQL 92** are independent of the others. **SQL 95** is independent of the other SQL
   but must follow the Lambda change below.

SQL before Lambda:
- **SQL 90 before** `tenant-admin.mjs` (calls `aws_invite_create_user_identity` / first-invite RLS) and
  `workflow-rpc.mjs` (`aws_create_deposit_batch_for_item`), and before the users-only members that rely on
  members-only RLS (`write-app-metadata.mjs` tenants insert/update, `admin-reset-totp.mjs`, `tax-*.mjs`,
  `storage-write-auth.mjs`).
- **SQL 91 before** `providers/onboarding/*.mjs`, `providers.mjs`, `providers/catalog.mjs`,
  `providers/webhooks.mjs` and `providers/webhook-apply.mjs` (onboarding tables, `aws_moov_onboarding_*`).
  The `aws/template.yaml` KMS keys / env must be in place before the onboarding handlers too.
- **SQL 92 before** `esign.mjs` for the check_files link to be recorded (without it the link is skipped
  inside a savepoint; the request still succeeds).
- **SQL 93 before** `write-app-metadata.mjs` / `write-allowlist.mjs` company-info columns are useful; the
  SPA saves core fields first and `email-branding.mjs` tolerates missing columns, so this is soft.
- **SQL 94 before** `tenant-library.mjs`, `signature-library-source.mjs`, `app-services.mjs` (library routes)
  and `homeowner.mjs` (shared documents reader; returns [] without SQL 94).
- **SQL 96 before** `tenant-billing-engine.mjs` / `tenant-billing-handlers.mjs` (pricing saves call
  `aws_platform_owner_set_tenant_pricing`; without SQL 96 they return 503 `pricing_setter_missing`).
  `providers/parity/moov-onboard.mjs` and `moov-money.mjs` are independent of SQL 96. The SPA
  (AdminTenants pricing through tenant-billing-admin) goes after SQL 96 and the billing Lambdas.
- **SQL 95 after** `app-services.mjs` without the `ingest-shared-check` route is live (SQL 95 drops
  `aws_ingest_shared_check`, which the old route calls).

Lambda order (Check Alt / step-up):
- **`auth-financial-totp.mjs` before `checkalt-*`**: the session-bound `loadSessionCheckAltStepUp` only
  accepts rows with `metadata.source = 'app_financial_totp'` and `metadata.login_session`, which only the
  new auth-financial-totp writes; it also keeps old checkalt-authz working during the gap.
- **`checkalt-submit.mjs` and `checkalt-approve.mjs` before `checkalt-authz.mjs`**: the new authz needs the
  caller's `claims` to bind the login; the existing plan order already lists approve, submit, then authz.
- `providers.mjs` last, as in the existing plan.
- `write-allowlist.mjs` (drops `financial_stepup_log`) after the SPA that no longer writes it; the AWS SPA
  never used that write (it is the legacy Supabase branch).

SPA: one combined SPA build from this branch (users-only, Moov onboarding, document library, branding,
signature repairs, announcements, Inter font, Freedom removal) after the Lambda members its screens call.

## 6. Retirements on the release branch (owner-approved)

- `supabase/functions/partner-shared-checks/` and its `supabase/config.toml` entry are deleted (the old
  unauthenticated Supabase partner-code check lookup; nothing called it). AWS partner sharing
  (connect_partner_by_code / share_check_with_partner, aws/rls/sql/32) is unchanged.
- `tenant-company-branding-save` is retired: `app-services.mjs` (a plan member) answers it with 410
  `route_retired`, and its handler is removed from `tenant-settings-handlers.mjs`. SQL 93's member column
  guard therefore no longer allows `business_address`, `business_phone` or `email_reply_to`.

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
