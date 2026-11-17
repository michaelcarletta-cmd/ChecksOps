/**
 * Cost finding (2026-11-17): CloudTrail showed about 53,000 GetSecretValue calls a day for the
 * production database secret, one per API request. getSecretStringFromAws now caches the secret
 * string per container for SECRET_STRING_CACHE_MS.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SECRET_STRING_CACHE_MS,
  getSecretStringFromAws,
  loadDatabaseCredentials,
  resetSecretStringCacheForTests,
} from '../functions/api/secrets.mjs';

const ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:test/app';

const counter = (impl) => {
  const calls = [];
  const fn = async (arn) => {
    calls.push(arn);
    return impl(arn, calls.length);
  };
  return { fn, calls };
};

test('a second read inside the TTL does not call Secrets Manager again', async () => {
  resetSecretStringCacheForTests();
  const { fn, calls } = counter(() => 'value-1');
  let now = 1_000;
  const deps = { fetchSecretString: fn, now: () => now };
  assert.equal(await getSecretStringFromAws(ARN, deps), 'value-1');
  now += SECRET_STRING_CACHE_MS - 1;
  assert.equal(await getSecretStringFromAws(ARN, deps), 'value-1');
  assert.equal(calls.length, 1);
});

test('the secret is fetched again once the TTL has passed, so a rotation is picked up', async () => {
  resetSecretStringCacheForTests();
  const { fn, calls } = counter((arn, n) => `value-${n}`);
  let now = 1_000;
  const deps = { fetchSecretString: fn, now: () => now };
  assert.equal(await getSecretStringFromAws(ARN, deps), 'value-1');
  now += SECRET_STRING_CACHE_MS;
  assert.equal(await getSecretStringFromAws(ARN, deps), 'value-2');
  assert.equal(calls.length, 2);
});

test('concurrent reads share one fetch', async () => {
  resetSecretStringCacheForTests();
  const { fn, calls } = counter(() => 'value-1');
  const deps = { fetchSecretString: fn, now: () => 1_000 };
  const values = await Promise.all([
    getSecretStringFromAws(ARN, deps),
    getSecretStringFromAws(ARN, deps),
    getSecretStringFromAws(ARN, deps),
  ]);
  assert.deepEqual(values, ['value-1', 'value-1', 'value-1']);
  assert.equal(calls.length, 1);
});

test('a failed fetch is not cached', async () => {
  resetSecretStringCacheForTests();
  const { fn, calls } = counter((arn, n) => {
    if (n === 1) throw new Error('throttled');
    return 'value-2';
  });
  const deps = { fetchSecretString: fn, now: () => 1_000 };
  await assert.rejects(() => getSecretStringFromAws(ARN, deps), /throttled/);
  assert.equal(await getSecretStringFromAws(ARN, deps), 'value-2');
  assert.equal(calls.length, 2);
});

test('secrets are cached separately by id', async () => {
  resetSecretStringCacheForTests();
  const { fn, calls } = counter((arn) => `value-of-${arn}`);
  const deps = { fetchSecretString: fn, now: () => 1_000 };
  assert.equal(await getSecretStringFromAws('a', deps), 'value-of-a');
  assert.equal(await getSecretStringFromAws('b', deps), 'value-of-b');
  assert.equal(await getSecretStringFromAws('a', deps), 'value-of-a');
  assert.deepEqual(calls, ['a', 'b']);
});

test('loadDatabaseCredentials still uses an injected reader unchanged', async () => {
  resetSecretStringCacheForTests();
  const previous = process.env.DATABASE_SECRET_ARN;
  process.env.DATABASE_SECRET_ARN = ARN;
  try {
    const { fn, calls } = counter(() => JSON.stringify({
      username: 'checksops', host: 'db.internal', port: 5432, dbname: 'checksops', password: 'x',
    }));
    const first = await loadDatabaseCredentials(fn);
    await loadDatabaseCredentials(fn);
    assert.equal(first.username, 'checksops');
    assert.equal(calls.length, 2);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_SECRET_ARN;
    else process.env.DATABASE_SECRET_ARN = previous;
  }
});
