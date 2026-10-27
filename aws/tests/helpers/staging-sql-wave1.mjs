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
  sql98: Object.freeze({ wave: 3, approved: '2026-10-18', run: '39083278136', live: '296c3d6a274e10f66005fb9eaecf93fa17b81bd8db3607037ca07698fddd3275', apply_run: '39085677318' }),
});

/** A pending copy of a staging pin (no recorded pre-state, not executable), for refusal tests. */
export const pendingPin = (pin) => Object.freeze({
  ...pin,
  ...(Object.hasOwn(pin, 'execute') ? { authorization: 'pending', execute: false } : {}),
  expected_live_definition_sha256: null,
});

/**
 * The committed staging pin's apply state: waves 1-21 recorded and approved, wave 6 approved with
 * its read-live still to record (pending until then), wave 18 (SQL 117) retired, the rest pending.
 */
export function assertStagingPinState(assert, key, pin) {
  const wave = STAGING_WAVE1[key];
  if (!wave || wave.run == null) {
    assert.equal(pin.expected_live_definition_sha256, null, key);
    if (Object.hasOwn(pin, 'execute')) {
      assert.equal(pin.execute, false, key);
      assert.equal(pin.authorization, 'pending', key);
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
