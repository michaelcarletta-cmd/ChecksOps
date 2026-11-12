/**
 * Staging apply wave 1 (owner approved 2026-10-17): the staging read-live pre-states recorded in
 * the staging pins. Every other release / library staging pin stays pending: SQL 29 and SQL 92 are
 * already applied in staging (read-live already_applied true), SQL 98 follows SQL 96 (shared
 * objects; wave 3), and SQL 95 / 97 follow their Lambdas (runbook steps 7-8; wave 4).
 */
export const STAGING_WAVE1 = Object.freeze({
  sql30: Object.freeze({ run: '39075094721', live: '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504', apply_run: '39080001060' }),
  sql90: Object.freeze({ run: '39078340362', live: '1af4b3ac3d933fa3e05e938853d93edc196d89c5e2f0b82bbd98a1843d65781c', apply_run: '39080157856' }),
  sql91: Object.freeze({ run: '39075362413', live: 'bdbc697f75e7a9c57c91c9ce12956800e92417a93acfbbaa0c2d1cf69542972e', apply_run: '39080306273' }),
  sql93: Object.freeze({ run: '39075623166', live: 'ef2ce6baec304517f50b063a3d11048492ae69d34122e26020063f0c53413eb9', apply_run: '39080438659' }),
  sql99: Object.freeze({ run: '39076376639', live: '4d174e86d8c9f0940a0d38da3e432676143dc34946e8d1619cfc36d8a9a834e9', apply_run: '39080577323' }),
  sql100: Object.freeze({ run: '39076502355', live: 'bdfc6b25d3f9f946e8261c3a8a1f873e7e00e84793f7c145f12eb1b9f78a6af3', apply_run: '39080713230' }),
  // Wave 2: re-read after all six wave-1 applies (main c8a79d554); applied 2026-10-18 at main 02fb97d5a.
  sql94: Object.freeze({ wave: 2, run: '39080904425', live: '724115983687d882d8240e8d06e4670bc6e24dbb16540d3134cc1ccc47d66af1', apply_run: '39082817752' }),
  sql96: Object.freeze({ wave: 2, run: '39081015501', live: '275400ff40caf1ff9d036e62f8bab687f82e9302622afef91f77a314c0f40f7f', apply_run: '39082957003' }),
  // Wave 3 (owner approved 2026-10-18): re-read after SQL 96 was applied (main 02fb97d5a); applied at main 2176f73ae.
  // Wave 4 (owner approved 2026-10-18): after their Lambdas went live on staging (auth-financial-totp /
  // admin-reset-totp for SQL 97; the ingest-shared-check 410 stub for SQL 95), re-read at main 23953055.
  sql97: Object.freeze({ wave: 4, approved: '2026-10-18', run: '39121540941', live: '80bbcae1bea54fd57035fa802ecf6940314681f0ce73f2bfd9a5d8514f8986f5' }),
  sql95: Object.freeze({ wave: 4, approved: '2026-10-18', run: '39121392809', live: '4e8f37453b8d6678ed067b8b24bf6b200c5000700742e62871941b2748ba1588' }),
  // Wave 5 (owner approved 2026-10-18): SQL 101 fixes SQL 90's invite insert order
  // (profiles_id_identity_fkey); re-read at main 0d4a7b8a8 after the executor carried it.
  sql101: Object.freeze({ wave: 5, approved: '2026-10-18', run: '39142701783', live: '1c7e1d52a88e4ddb93b751ec972eebfe17600a156d6e56968c9026aa41425c1a' }),
  // Wave 6 (owner approved 2026-10-18): SQL 102 replaces SQL 98's column guard (platform owner
  // tenant profile and member removal). No staging read-live yet (the executor must carry it
  // first): run and live stay null and the pin stays pending until a reviewed change records the
  // read-live run and pre-state here and in the pin (execute true), as wave 5 did for SQL 101.
  sql102: Object.freeze({ wave: 6, approved: '2026-10-18', run: '39161620576', live: 'd3b2cd30d9b06347c4a08febac3fce49732bd0babcacfeea0a2b49dbdc9cb752', apply_run: '39162625974' }),
  // Wave 7 (owner approved 2026-10-19, "do the SQL 104 staging pin"): SQL 104 grants
  // payment_idempotency_keys to checksops and authenticated (the grant SQL 91 omitted). Read at
  // main 4e7c78905 after the executor carried it: only checksops SELECT was held, so not applied.
  sql104: Object.freeze({ wave: 7, approved: '2026-10-19', run: '39296513948', live: '22b2d47df43b9fc831143e018022d0e94790cbd1e0406f0ab03443cd14652577' }),
  // Wave 8 (owner approved 2026-10-20, "approve SQL 105 staging"): SQL 105 grants the four
  // onboarding payment tables to checksops and authenticated (the grants SQL 91 omitted). Read at
  // main 4c13059bb after the executor carried it: checksops INSERT was missing on three tables.
  sql105: Object.freeze({ wave: 8, approved: '2026-10-20', run: '39429083380', live: 'fbbdae18762d3d8e2cbd43c070720cf5b04ef6344b5a956ee0fb1c3b4c1fc27a' }),
  // Wave 9 (owner approved 2026-10-21, "apply SQL 108 in production then ..."): SQL 108 lets
  // check_intake_items_funds_type_check accept the nine SPA funds_type values. Read at main
  // 20059c9d3 after the executor carried it: the Supabase five-value constraint, validated.
  sql108: Object.freeze({ wave: 9, approved: '2026-10-21', run: '39657370816', live: 'c83dcc9b97b84d294a743063adb0c1f5231f5c37ade2f00d65dc134a1d55cf00' }),
  // Wave 10 (owner approved 2026-10-21, "apply SQL 109 in production"): SQL 109 adds the Moov
  // transfer webhook writer. Read at main c92fe457b after the executor carried it: the function
  // absent, SQL 91 applied, the definer able to write both tables.
  sql109: Object.freeze({ wave: 10, approved: '2026-10-21', run: '39663914111', live: 'e0f02501f167f4bee2bbb8bc32c1e19b23deb5425a650c63102030531aa9a077' }),
  // Wave 11 (owner approved 2026-10-22, "Apply SQL 110 to staging"): SQL 110 adds the DELETE grant
  // on homeowner_ledger_tokens and the public homeowner upload writer. Read at main 6cf4c2f6b after
  // the executor carried it: the writer absent, no DELETE grant, the definer able to write all three tables.
  // Applied by the guarded staging executor run 39838878110 (receipt 3fdbb3d3… -> ae039876…).
  sql110: Object.freeze({ wave: 11, approved: '2026-10-22', run: '39836749684', live: '3fdbb3d323c1c0edab0c2ee7e4a6c1b08aa30c1a021c7d81899e95a616f186fd', apply_run: '39838878110' }),
  // Wave 12 (owner approved 2026-10-22, "Owner approved the SQL 111 staging apply on 2026-10-22"):
  // SQL 111 adds the five tenant referral functions. Read at main 323206af2 after the executor
  // carried it: the functions absent, the definer able to write referral_events and tenants.
  // Applied by the guarded staging executor run 39877945144 (receipt b78704b4… -> 0ca62915…).
  sql111: Object.freeze({ wave: 12, approved: '2026-10-22', run: '39874593011', live: 'b78704b4d46b3ca88146d8368e09c630ead8930d3717e89287bf07bb46b86978', apply_run: '39877945144' }),
  // Wave 13 (owner approved 2026-10-23, "applying SQL 112 for parity."): SQL 112 grants the Moov
  // invoice tables to checksops and authenticated. Read at main c74e7264c after the executor
  // carried it: checksops SELECT only on both tables, authenticated none of the pinned lines.
  // Applied by the guarded staging executor run 39967007467 (receipt c606d5ed… -> 7caba5ba…).
  sql112: Object.freeze({ wave: 13, approved: '2026-10-23', run: '39963348904', live: 'c606d5eda318a2336d5885b3675339ee98aed761c3aa620a7ced759b3c5eeb89', apply_run: '39967007467' }),
  // Wave 14 (owner approved 2026-10-23, "Apply SQL 113 to staging"): SQL 113 production payee
  // setup. Read at main ac2860a5a after the executor carried it: the six functions and seven payee
  // columns absent, checksops SELECT and UPDATE on external_payment_recipients.
  // Applied by the guarded staging executor run 40022413642 (receipt 88787a89… -> 5984d321…).
  sql113: Object.freeze({ wave: 14, approved: '2026-10-23', run: '40018316361', live: '88787a89c85585f25c18ea31d60740a6526522377a1b0d7b02e7902fe18970c1', apply_run: '40022413642' }),
  // Wave 15 (owner approved 2026-10-25, "approve SQL 114 staging apply"): SQL 114 grants UPDATE on
  // six stakeholder_accounts columns to checksops and authenticated. Read at main cfc0829e5 after the
  // executor carried it (deploy run 40152534378): no column grant on any of the six.
  // Applied by the guarded staging executor run 40154043207 (receipt 8b5d1d4d… -> 809eba9b…).
  sql114: Object.freeze({ wave: 15, approved: '2026-10-25', run: '40152706123', live: '8b5d1d4d49188412317a60036a392c27727852b246a1d59a9c2807cb17186e00', apply_run: '40154043207' }),
  // Wave 16 (owner approved 2026-10-25, "Approve SQL 115 staging apply"): SQL 115 replaces
  // sync_provider_stakeholder_account(uuid) so a tenant keeps one active partner payout. Read at
  // main f5cc9ec after the executor carried it (deploy run 40240193453): the restored supabase
  // body, EXECUTE to PUBLIC and the owner.
  sql115: Object.freeze({ wave: 16, approved: '2026-10-25', run: '40240434651', live: '6dbf58792a5eb0f9863ac0a6e88265de6ec9931a9e7a31bac21d7b71f643bba0' }),
  // Wave 17 (owner approved 2026-10-26, "Approve SQL 116 staging apply and merge when green"): SQL 116
  // adds moov_onboarding_profiles.industry. Read at main d8d4e3b after the executor carried it
  // (deploy run 40335727438): no industry column, SQL 91 in place.
  // Applied by the guarded staging executor run 40339373370 (receipt d145c18e… -> c99fc953…).
  sql116: Object.freeze({ wave: 17, approved: '2026-10-26', run: '40336144625', live: 'd145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd', apply_run: '40339373370' }),
  // Wave 18 (owner approved 2026-10-27, "SQL 117 to production" and "Go"): SQL 117 adds
  // tenant_deactivations and the platform-owner tenant lifecycle functions. Read at main 9d6f164
  // after the executor carried it (deploy run 40431581944): the table and the six functions absent.
  // Retired 2026-10-27: the staging apply (run 40434533070) rolled back (UNRELATED_MUTATION
  // intended_state: the new table kept default-privilege grants); SQL 118 replaces it.
  sql117: Object.freeze({ wave: 18, approved: '2026-10-27', run: '40431777849', live: 'dcfcb810a7d016f63451a3cf6ec00982be2f555fae087871885e49cc4b501956', retired: 'Retired 2026-10-27: superseded by SQL 118 after staging apply run 40434533070 rolled back; never applied' }),
  // Wave 19 (owner approved 2026-10-27, "Start the SQL 118 tooling PR" and "Go"): SQL 118 replaces
  // the retired SQL 117 (tenant_deactivations with every non-owner grant revoked, and the
  // platform-owner tenant lifecycle functions). Read at main 7cd3272 after the executor carried it
  // (deploy run 40436720850): the table and the six functions absent.
  // Applied by the guarded staging executor run 40438147297 (receipt 1b5eec31… -> 6f9e2ef3…).
  sql118: Object.freeze({ wave: 19, approved: '2026-10-27', run: '40436888477', live: '1b5eec31635d869abbabc9d4584674ee5852a27689629d9c199627d7c8653cde', apply_run: '40438147297' }),
  // Wave 20 (owner approved 2026-10-27, "Deploy SQL 120 to staging"): SQL 120, usage events at
  // Check Alt approval and at send time. Read at main 6505198 after the executor carried it (deploy
  // run 40544852676): the five functions and two triggers absent, a unique index already covering
  // check_billing_events (payment_transfer_id, event_type).
  sql120: Object.freeze({ wave: 20, approved: '2026-10-27', run: '40545376358', live: 'f3c1dd26888ac9fce91721cad698d39ee99cdca80c4a7888f9cfea9043171e9d', apply_run: '40547527832' }),
  // Wave 21 (owner approved 2026-10-27, "start the SQL 121 and 122 staging applies"): SQL 121, the
  // cash-job grants and the Check Alt cash-job payment trigger, and SQL 122, the Mortgage Desk return
  // to the tenant. Read at main d20d599 after the executor carried both (deploy run 40587866121).
  // SQL 121: the new function and its trigger absent, checksops already holding SELECT / INSERT /
  // UPDATE / DELETE on the three cash-job tables, sync_cash_job_check_payment() with the reviewed body
  // but not SECURITY DEFINER and EXECUTE to PUBLIC. SQL 122: the six functions and
  // mortgage_handling_requests.return_emailed_at absent.
  sql121: Object.freeze({ wave: 21, approved: '2026-10-27', run: '40588277757', live: '084deae36bb533c91124d12698b1adb29e5fa7b9ff53932aa293537bc573e76e', apply_run: '40591140684' }),
  sql122: Object.freeze({ wave: 21, approved: '2026-10-27', run: '40588288300', live: 'e13856d7a75483b5785b6e791fd83fbe9da9a1b09f6c819480cee54388a62609', apply_run: '40591701699' }),
  // Wave 22 (owner approved 2026-10-28, "Yes open both PRs"): SQL 123, a Check Alt deposit moves its
  // check to Deposited (Returned when rejected after approval). Read at main 6a7270f after the
  // executor carried it (deploy run 40714754418): the two functions and the trigger absent, no
  // approved check left to move.
  sql123: Object.freeze({ wave: 22, approved: '2026-10-28', run: '40717225525', live: 'b584e1cd4352837eb5515cd07e76900e055637d11c29214db036f912e6b6f6b9' }),
  // Wave 23 (owner approved 2026-10-28, "start the SQL 124 staging apply"): SQL 124, Mortgage Desk
  // send-for-signature, reads and timeline. Read at main 3606348 after the executor carried it (deploy
  // run 40754334967): the eight functions absent, every prerequisite present, the definer writes possible.
  sql124: Object.freeze({ wave: 23, approved: '2026-10-28', run: '40754712957', live: '59fe6907e23de341e97d4aec548203d0cd7f7cf320b009e0e440d247d82a4db2' }),
  // Wave 24 (owner approved 2026-10-29, "open the SQL 125 staging pin PR"): SQL 125, security_invoker
  // on the four deposit views (security audit). Read at main a0c5c51 after the executor carried it
  // (deploy run 40885862573): the four views present with the reviewed definitions and no options.
  // Applied by run 40892707444 (main 4f26c14, executor deploy run 40892051066): receipt 9b31cf5d ->
  // a041efa5 (intended); read-live run 40893116553 at the intended fingerprint.
  sql125: Object.freeze({ wave: 24, approved: '2026-10-29', run: '40886747687', live: '9b31cf5dad3f82bf69fcddd03e0c26c0dc0fdd5ff6bd40137d1af316f1fd6541', apply_run: '40892707444' }),
  // Wave 25 (owner approved 2026-10-29, "start SQL 126 on staging"): SQL 126, the thirteen Supabase-era
  // SECURITY DEFINER reads check their caller (security audit finding 4). Read at main 7d33d5c after the
  // executor carried it (deploy run 40917101622): the supabase bodies, EXECUTE PUBLIC and the owner.
  // Applied by run 40921170890 (main 7422c69, executor deploy run 40920738142): receipt 04106521 ->
  // 3aebf853 (intended); read-live run 40921576727 at the intended fingerprint.
  sql126: Object.freeze({ wave: 25, approved: '2026-10-29', run: '40917478177', live: '04106521263eeeb423ac2c0dfbf5e1f1af5a52c89501b63ac742d6b25c5e1612', apply_run: '40921170890' }),
  // Wave 26 (owner approved 2026-10-29, "start the SQL 127 staging apply"): SQL 127, homeowners sign
  // their checks and documents from the claim portal. Read at main f0264d9 after the executor carried it
  // (deploy run 40947474906): SQL 83's endorse capability and pending_signatures bodies, the portal
  // signer absent, every prerequisite present, the definer writes possible.
  sql127: Object.freeze({ wave: 26, approved: '2026-10-29', run: '40947834848', live: '4b4af399a73a25e191d2f914cc074a3744c84fffbc8ce3e55f2adec2cf93dfe0' }),
  // Wave 27 (owner approved 2026-10-30, "start SQL 128 staging"): SQL 128, contractor verification reads
  // the Compliance & Docs uploads. Read at main add2bbfc9 after the executor carried it (deploy run
  // 41041668169): the restored supabase contractor_verification_status (state different) and the orphan
  // _trg_recompute_contractor_tier_from_docs() present, every prerequisite present.
  sql128: Object.freeze({ wave: 27, approved: '2026-10-30', run: '41042517205', live: '8bd6b42d189ff05b77e19d178ddba0229a0d2b6bca0a2d1d98221774fa8fbc5f' }),
  // SQL 129: retired before any approval (owner 2026-10-30, "New combined fix"). Its read-live (run
  // 41081764481, main f2bb55b1) read the function without PUBLIC EXECUTE, which the file keeps and its
  // fingerprint names, so the apply would roll back; SQL 130 replaces it. No pre-state was recorded.
  sql129: Object.freeze({ run: null, retired: 'Retired 2026-10-30: superseded by SQL 130 after staging read-live run 41081764481 found no PUBLIC EXECUTE; never applied' }),
  // Wave 28 (owner approved 2026-10-30, "continue with SQL 130 staging"): SQL 130, the financial TOTP
  // rate limit accepts code_check and PUBLIC EXECUTE is revoked. Read at main 81b188b97 after the
  // executor carried it (deploy run 41087238803): the proposed file's body with EXECUTE for checksops
  // and the owner only (state different), the same state SQL 129's read-live run 41081764481 read.
  sql130: Object.freeze({ wave: 28, approved: '2026-10-30', run: '41087643551', live: 'cb2fd65bb580f9338cab728c2507a32b7589aee5e702d117c31e1862f98a5a19' }),
  // SQL 131: no wave; its staging read-live (run 41107844336) found the intended state already (already_applied
  // true), so no staging apply was authorized and its staging pin stays pending.
  // Wave 29 (owner approved 2026-10-30, "continue with SQL 132 staging"): SQL 132, the financial TOTP
  // code-check lockout counter. Read at main 546dd7cb8 after the executor carried it (deploy run
  // 41113385981): financial_totp_count_code_check(uuid) absent, every prerequisite present,
  // predecessors.sql130 true, the definer write ok (the pre-state the executor test derives).
  sql132: Object.freeze({ wave: 29, approved: '2026-10-30', run: '41113777003', live: 'e1a1d4edb115e3fa0881112e6759c2d7ee1e9d8c6b3e24a7611b655dcf75741f' }),
  // Wave 30 (owner approved 2026-10-30, "continue with SQL 133 staging"): SQL 133, the financial TOTP
  // teammate reset. Read at main 564b7baee after the executor carried it (deploy run 41129102846):
  // financial_totp_admin_reset_enrollment(uuid, uuid) absent, every prerequisite present, no predecessor,
  sql133: Object.freeze({ wave: 30, approved: '2026-10-30', run: '41129536538', live: 'f3b1671e8617df78a20600b43fcfc6636739d78f235ef78d1cc7d1d68f2f909d' }),
  // Wave 30 (owner approved 2026-10-30, "start the SQL 134 staging apply"): SQL 134, the Loss Draft
  // escrow and draw column grants. Read at main 564b7baee with the executor current (inspect run 41130389562):
  // none of the fourteen columns granted, every prerequisite present (the pre-state the executor test derives).
  sql134: Object.freeze({ wave: 30, approved: '2026-10-30', run: '41130749260', live: '7827f4c87e5bc9e7bd0def01d5f201a0a1fc26365480921896aa452e1403466d' }),
  // Wave 31 (owner approved 2026-10-31, "the SQL 135 staging pin", then "apply SQL 135 in staging"): SQL 135,
  // the check create INSERT grant. Read at main c92da0bc5 after the executor carried it (deploy run
  // 41214086396): SQL 50's authenticated and checksops INSERT on its twenty columns, SQL 89's checksops
  // UPDATE on seventeen, claim_id and the cash-job columns ungranted (SQL 51 never run in staging; the
  // pre-state the executor test derives), every prerequisite present, no predecessor.
  sql135: Object.freeze({ wave: 31, approved: '2026-10-31', run: '41214330222', live: '4dac49398757060deee5d636f193059e30cbe1ffdb33890122f79f026d144f33' }),
  // Wave 32 (owner approved 2026-10-31, "record the SQL 137 staging pin"): SQL 137, the platform owner from
  // the identity account only. Read at main 7d845915e after the executor carried it (deploy run 41234041020):
  // is_platform_owner() with EXECUTE for PUBLIC, authenticated, checksops and the owner, checksops UPDATE on
  // identity_accounts, every prerequisite present, no predecessor. NOT the pre-state the executor test derives
  // (7349393d..., aws/rls/sql/10's body with those grants): the grants match, the live function definition does not.
  sql137: Object.freeze({ wave: 32, approved: '2026-10-31', run: '41234275408', live: 'a2c2d856a21c52d47544fad05e0f0275a24a093421c8a7a7fbeea0e4bb329dfc' }),
  // Wave 33 (owner approved 2026-10-31, "record the SQL 138 staging pin"): SQL 138, the payee setup link
  // closed once the payee is verified. Read at main ca7de0ab9 after the executor carried it (deploy run
  // 41239673718): aws_public_payee_record(text, text, jsonb) with EXECUTE for checksops and the owner,
  // predecessors.sql113 true, no successor applied, every prerequisite present, both definer writes ok
  // (the pre-state the executor test derives).
  sql138: Object.freeze({ wave: 33, approved: '2026-10-31', run: '41239902526', live: 'ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c' }),
  // Wave 34 (owner approved 2026-11-01, "record the SQL 136 staging pin"): SQL 136, the money-table RESTRICTIVE
  // write gate. Read at main 0e7488263 after #1498's API was live in staging (rebuild run 41313204838) and the
  // executor carried it (deploy run 41313488374): the gate function and 72 policies absent, every prerequisite
  // present, the four catalog counts 0 (the pre-state the executor test derives).
  sql136: Object.freeze({ wave: 34, approved: '2026-11-01', run: '41313668204', live: '6b404964de5ee203e126bc3ce78395c9a9e2fbf3a1e41eb0b5ccd8fa3e3ea150' }),
  // Wave 35 (owner approved 2026-11-02, "record the SQL 139 staging pin"): SQL 139, the billing account write
  // policy back to SQL 24's tenant-write contract. Read at main 383f8a89 after the executor carried it (deploy run
  // 41367591449): already_applied false, every prerequisite present, the three catalog counts 1. The live drifted
  // policy, whose text is unknown: NOT derivable, recorded as the read-live reported it.
  sql139: Object.freeze({ wave: 35, approved: '2026-11-02', run: '41367825238', live: '8727ecb1f834f9623c1ea7f568621f64a4212dadf3d28a5a7741a6a542cdb22f' }),
  // Wave 36 (owner approved 2026-11-02, "record the SQL 140 staging pin"): SQL 140, the automatic funding settings
  // write grants. Read at main d2b7fb756 after the executor carried it (deploy run 41451778243): already_applied
  // false, every prerequisite present, all thirteen columns without a column grant. Equal to the derived pre-state.
  sql140: Object.freeze({ wave: 36, approved: '2026-11-02', run: '41452217978', live: 'fa08a3db73806391d757885c9165d0f1bf56a4571a22b1a32e2e63c73578952d' }),
  // Wave 37 (owner approved 2026-11-04, "record the SQL 142 staging pin"): SQL 142, tenant admins may add and edit
  // the shared mortgage company directory. Read at main 7e17ab760 after the executor carried it (deploy run
  // 41926865597): already_applied false, every prerequisite present, both policies absent. Equal to the derived
  // pre-state.
  sql142: Object.freeze({ wave: 37, approved: '2026-11-04', run: '41927312617', live: 'ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3' }),
  // Wave 38 (owner approved 2026-11-05, "record the SQL 143 staging pin"): SQL 143, any member or active mortgage
  // desk agent may add, edit and delete unused mortgage companies. Read at main 6498b1fb0 after the executor carried
  // it (deploy run 42019363178): already_applied false, precondition_failures [], SQL 142's two policies present.
  // Equal to the derived pre-state.
  sql143: Object.freeze({ wave: 38, approved: '2026-11-05', run: '42020037212', live: 'c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d', apply_run: '42023495275' }),
  // Wave 39 (owner approved 2026-11-06, "record the SQL 144 staging pin"): SQL 144, an organization reads the send legs
  // another organization addressed to it (get_tenant_incoming_transfers). Read at main b5912204f after the executor
  // carried it (deploy run 42303787295): already_applied false, precondition_failures [], the function absent.
  // Equal to the derived pre-state.
  sql144: Object.freeze({ wave: 39, approved: '2026-11-06', run: '42304378701', live: '428d394e88ce45840806f7a6c93ed63d40178c0376c8a70843197bf28dccb88e' }),
  // Wave 40 (owner approved 2026-11-07, "record the SQL 145 staging pin"): SQL 145, the platform owner's fee
  // collection saves its payment_transfers leg (aws_platform_owner_insert_billing_collection_leg). Read at main
  // ddb8b1d50 after the executor carried it (deploy run 42330773622): already_applied false, precondition_failures [],
  // the function absent. Equal to the derived pre-state.
  sql145: Object.freeze({ wave: 40, approved: '2026-11-07', run: '42331198486', live: 'c622469dcfbfc0ad8f54c0bb038457b9eb3247a17ee0c855390ddc709ee1d594' }),
  // Wave 41 (owner approved 2026-11-07, "record the SQL 146 staging pin"): SQL 146, the Moov status catch-up locks its
  // rows and writes a fee leg's status (aws_moov_catch_up_lock_rows, aws_moov_apply_collection_leg_status). Read at
  // main 73610863c after the executor carried it (deploy run 42402669624): already_applied false,
  // precondition_failures [], both functions absent. Equal to the derived pre-state.
  sql146: Object.freeze({ wave: 41, approved: '2026-11-07', run: '42403055167', live: '1ef789645da5ce865cbb095bea1eff6775a4bedc87251e8152f41a771e659c40' }),
  // Wave 42 (owner approved 2026-11-10, "record the SQL 147 staging pin"): SQL 147, a payment made outside ChecksOps is
  // recorded as a completed batch and settled external_check splits (aws_record_external_disbursement). Read at main
  // 3fe023b75 after the executor carried it (deploy run 42830157593): already_applied false,
  // precondition_failures [], the function absent. Equal to the derived pre-state.
  sql147: Object.freeze({ wave: 42, approved: '2026-11-10', run: '42833250784', live: 'a60b06089007f083007ac7b24ae41cdd1cd33b0cbd04c63985c09faa9b666286' }),
  // Wave 43 (owner approved 2026-11-10, "record the SQL 148 staging pin and merge it when green"): SQL 148, a 2nd
  // mortgagee can be sent to the Mortgage Desk while the 1st request is open (the per-check open-request index re-keyed
  // on the endorsement order; aws_link_second_mortgagee). Read at main 952c4139e after the executor carried it (deploy
  // run 42900220555): already_applied false, precondition_failures [], the function absent and the index at the
  // Supabase definition (supabase_20260715110727). Equal to the derived pre-state.
  sql148: Object.freeze({ wave: 43, approved: '2026-11-10', run: '42901109448', live: '508588e6cd7d48ca74411aba8e0220842e0490bde69a881d362966f77e54d862' }),
  // Wave 44 (owner approved 2026-11-11, "record the SQL 150 staging pin and merge it when green"): SQL 150, a payment
  // made outside ChecksOps can be recorded up to the check amount (aws_record_external_disbursement without the PA fee).
  // Read at main 1ecbe3452 after the executor carried it (deploy run 42927303051): already_applied false,
  // precondition_failures [], the function exactly as SQL 147 left it. Equal to the derived pre-state.
  sql150: Object.freeze({ wave: 44, approved: '2026-11-11', run: '42928033292', live: '650ad0d486b5eebdf647e4c25a56c8776ed7a412d8735cfc83aad1d449b959fa' }),
  // Wave 45 (owner approved 2026-11-11, "record the SQL 152 staging pin and merge it when green"): SQL 152, the $0.30
  // invoice fee and $2.00 failed deposit fee recorded as usage events (SQL 149 plus the revoke of every non-owner grant
  // on its new table). Read at main 6d19dad33 after the executor carried it (deploy run 42945571224): already_applied
  // false, precondition_failures [], everything absent. Equal to the derived pre-state.
  sql152: Object.freeze({ wave: 45, approved: '2026-11-11', run: '42945948226', live: '99c391367eaf941dae2a89cf78d72ae87fff5559d2fc3c26ad7acc691f1a4a5e' }),
  // Wave 46 (owner approved 2026-11-11, "Record the SQL 154 staging pin and merge it when green"): SQL 154, the optional
  // Starter Package (SQL 151, never applied, plus EXECUTE on aws_starter_package_checks_used for checksops). Read at main
  // a21972a85 after the executor carried it (deploy run 43032760894): already_applied false, precondition_failures [],
  // prerequisites_missing [], SQL 102's guard and everything else absent. Equal to the derived pre-state.
  sql154: Object.freeze({ wave: 46, approved: '2026-11-11', run: '43033279908', live: '05fb0b9959f677fb828ee1efaf7ffce3513ea83e6d5ed071417a7511be3231ca' }),
  // Wave 47 (owner approved 2026-11-11, "Record the SQL 155 staging pin and merge it when green"): SQL 155, the claim
  // owner stamp production already runs (adopted from the unmerged PR #429). Read at main d0548d4af after the executor
  // carried it (deploy run 43076433402): already_applied false, precondition_failures [], prerequisites_missing [], both
  // functions and the trigger absent. Equal to the derived everything-absent state.
  sql155: Object.freeze({ wave: 47, approved: '2026-11-11', run: '43077253195', live: 'd63969e2ef8e5c809f2e107c41b61d87b3bedba5fe7a059b2dabb66f65604f54' }),
  // Wave 48 (owner approved 2026-11-11, "Record the SQL 156 staging pin and merge it when green, then apply SQL 156 in
  // staging"): SQL 156, the Mortgage Desk's shared-check library reads. Read at main 79e55a79a after the executor carried it
  // (deploy run 43106587111): already_applied false, precondition_failures [], prerequisites_missing [], both functions
  // absent. Equal to the derived everything-absent state.
  sql156: Object.freeze({ wave: 48, approved: '2026-11-11', run: '43107339208', live: '44259316206f9f591ce8f3a6d63b8627add30153669f612acf539e3eec6cda12' }),
  // Wave 49 (owner approved 2026-11-11, "record the SQL 153 staging pin" and "merge it when green"): SQL 153, the 2nd
  // mortgage company fee's index and invoice columns. Read at main 830cc142c with the executor current (deploy run
  // 43113284610): already_applied false, precondition_failures [], prerequisites_missing [], event_type_checks 0, the index
  // and both columns absent. Equal to the derived state.
  sql153: Object.freeze({ wave: 49, approved: '2026-11-11', run: '43115484335', live: 'b2bf6d325a5a50683acc8ecdaef39ec763b591f8db9f10e7d6fe02f9525cb0c3' }),
  // Wave 50 (owner approved 2026-11-12, "approve SQL 158", then the staging pin merge and apply): SQL 158, Tenant Management's
  // Mortgage Desk oversight and private agent notes. Read at main bfdb9126c after the executor carried it (deploy run
  // 43221459029): already_applied false, precondition_failures [], prerequisites_missing [], the table and all six functions
  // absent. Equal to the derived everything-absent state.
  sql158: Object.freeze({ wave: 50, approved: '2026-11-12', run: '43221906020', live: 'ed94cf62003c8ef29667a8b79dd081f8e0491bde28cf8ec1acee1154b877e233' }),
  // Wave 52 (owner approved 2026-11-12, "A new SQL 161 that gives staging that one permission, then SQL 160" and "Merging the
  // SQL 161 PR"): SQL 161, EXECUTE for checksops on tg_record_mortgage_handling_billing(), applied before SQL 160's wave 51.
  // Read at main 1681b943 with the executor current (deploy run 43314468325): already_applied false, precondition_failures [],
  // prerequisites_missing [], the ACL PUBLIC and the owner (grantor the owner). Equal to the derived staging pre-state.
  sql161: Object.freeze({ wave: 52, approved: '2026-11-12', run: '43315046187', live: '72031400264a910912cecd832ac0bf8486da7b67acfd036bc66aff6820258448' }),
  sql98: Object.freeze({ wave: 3, approved: '2026-10-18', run: '39083278136', live: '296c3d6a274e10f66005fb9eaecf93fa17b81bd8db3607037ca07698fddd3275', apply_run: '39085677318' }),
});

/** A pending copy of a staging pin (no recorded pre-state, not executable), for refusal tests. */
export const pendingPin = (pin) => Object.freeze({
  ...pin,
  ...(Object.hasOwn(pin, 'execute') ? { authorization: 'pending', execute: false } : {}),
  expected_live_definition_sha256: null,
});

/**
 * The committed staging pin's apply state: waves 1-50 and 52 recorded and approved, wave 6 approved with
 * its read-live still to record (pending until then), wave 18 (SQL 117) retired, SQL 129 retired
 * before any read-live was recorded, the rest pending.
 */
export function assertStagingPinState(assert, key, pin) {
  const wave = STAGING_WAVE1[key];
  if (!wave || wave.run == null) {
    assert.equal(pin.expected_live_definition_sha256, null, key);
    if (Object.hasOwn(pin, 'execute')) {
      assert.equal(pin.execute, false, key);
      // Pending, or retired before a pre-state was ever recorded (SQL 129).
      assert.equal(pin.authorization, wave?.retired || 'pending', key);
    }
    return;
  }
  assert.equal(pin.expected_live_definition_sha256, wave.live, key);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, `${key}: recorded pre-state is not the post-state`);
  if (wave.retired) {
    assert.equal(pin.execute, false, key);
    assert.equal(pin.authorization, wave.retired, key);
    return;
  }
  if (Object.hasOwn(pin, 'execute')) {
    assert.equal(pin.execute, true, key);
    assert.equal(pin.authorization, `Owner approved ${wave.approved || '2026-10-17'}: staging apply (wave ${wave.wave || 1}) from staging read-live run ${wave.run}`, key);
  }
}
