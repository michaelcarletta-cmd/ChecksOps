/**
 * Staging apply wave 1 (owner approved 2026-10-17): the staging read-live pre-states recorded in
 * the staging pins. Every other release / library staging pin stays pending.
 */
export const STAGING_WAVE1 = Object.freeze({
  sql30: Object.freeze({ run: '39075094721', live: '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504' }),
  sql90: Object.freeze({ run: '39078340362', live: '1af4b3ac3d933fa3e05e938853d93edc196d89c5e2f0b82bbd98a1843d65781c' }),
  sql91: Object.freeze({ run: '39075362413', live: 'bdbc697f75e7a9c57c91c9ce12956800e92417a93acfbbaa0c2d1cf69542972e' }),
  sql93: Object.freeze({ run: '39075623166', live: 'ef2ce6baec304517f50b063a3d11048492ae69d34122e26020063f0c53413eb9' }),
  sql95: Object.freeze({ run: '39075879719', live: '4e8f37453b8d6678ed067b8b24bf6b200c5000700742e62871941b2748ba1588' }),
  sql97: Object.freeze({ run: '39076132740', live: '80bbcae1bea54fd57035fa802ecf6940314681f0ce73f2bfd9a5d8514f8986f5' }),
  sql99: Object.freeze({ run: '39076376639', live: '4d174e86d8c9f0940a0d38da3e432676143dc34946e8d1619cfc36d8a9a834e9' }),
  sql100: Object.freeze({ run: '39076502355', live: 'bdfc6b25d3f9f946e8261c3a8a1f873e7e00e84793f7c145f12eb1b9f78a6af3' }),
});

/** A pending copy of a staging pin (no recorded pre-state, not executable), for refusal tests. */
export const pendingPin = (pin) => Object.freeze({
  ...pin,
  ...(Object.hasOwn(pin, 'execute') ? { authorization: 'pending', execute: false } : {}),
  expected_live_definition_sha256: null,
});

/** The committed staging pin's apply state: wave 1 recorded and approved, the rest pending. */
export function assertStagingPinState(assert, key, pin) {
  const wave = STAGING_WAVE1[key];
  if (!wave) {
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
    assert.match(pin.authorization, /^Owner approved 2026-10-17: staging apply \(wave 1\) from staging read-live run \d+$/, key);
    assert.ok(pin.authorization.endsWith(wave.run), key);
  }
}
