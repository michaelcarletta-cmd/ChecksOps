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
  sql98: Object.freeze({ wave: 3, approved: '2026-10-18', run: '39083278136', live: '296c3d6a274e10f66005fb9eaecf93fa17b81bd8db3607037ca07698fddd3275', apply_run: '39085677318' }),
});

/** A pending copy of a staging pin (no recorded pre-state, not executable), for refusal tests. */
export const pendingPin = (pin) => Object.freeze({
  ...pin,
  ...(Object.hasOwn(pin, 'execute') ? { authorization: 'pending', execute: false } : {}),
  expected_live_definition_sha256: null,
});

/**
 * The committed staging pin's apply state: waves 1-7 recorded and approved, wave 6 approved with
 * its read-live still to record (pending until then), the rest pending.
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
  if (Object.hasOwn(pin, 'execute')) {
    assert.equal(pin.execute, true, key);
    assert.equal(pin.authorization, `Owner approved ${wave.approved || '2026-10-17'}: staging apply (wave ${wave.wave || 1}) from staging read-live run ${wave.run}`, key);
  }
}
