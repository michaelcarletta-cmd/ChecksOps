import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRODUCTION_AZURE_DI_SECRET_ID,
  STAGING_AZURE_DI_SECRET_ID,
  assertAzureDiSecretIdAllowed,
  azureDiAnalyzeSecretLoader,
  loadAzureDiStagingSecret,
  resetAzureDiSecretCache,
} from '../functions/api/azure-di-secret.mjs';

const ENDPOINT = 'https://di-test.example.test';
const KEY = 'test-azure-key-not-real';
const GOOD = JSON.stringify({ api_key: KEY, endpoint: ENDPOINT });
const PROD = PRODUCTION_AZURE_DI_SECRET_ID;
const STAGING = STAGING_AZURE_DI_SECRET_ID;

test('staging secret loader success does not expose endpoint or key', async () => {
  resetAzureDiSecretCache();
  let loads = 0;
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'staging' },
    secretId: STAGING_AZURE_DI_SECRET_ID,
    getSecretString: async () => {
      loads += 1;
      return GOOD;
    },
  });
  assert.equal(out.configured, true);
  assert.equal(out.code, 'ok');
  assert.equal('endpoint' in out, false);
  assert.equal('api_key' in out, false);
  assert.equal('apiKey' in out, false);
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.ok(!JSON.stringify(out).includes(ENDPOINT));
  assert.equal(loads, 1);

  const cached = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => {
      loads += 1;
      return GOOD;
    },
  });
  assert.equal(cached.configured, true);
  assert.equal(loads, 1);
  resetAzureDiSecretCache();
});

test('staging secret missing', async () => {
  resetAzureDiSecretCache();
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => {
      throw new Error('ResourceNotFoundException');
    },
  });
  assert.equal(out.configured, false);
  assert.equal(out.code, 'secret_missing');
});

test('malformed secret', async () => {
  resetAzureDiSecretCache();
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => JSON.stringify({ hello: 'world' }),
  });
  assert.equal(out.configured, false);
  assert.equal(out.code, 'secret_malformed');
});

test('unknown and unset env remain blocked', async () => {
  resetAzureDiSecretCache();
  let loads = 0;
  const getter = async () => {
    loads += 1;
    return GOOD;
  };
  for (const envName of [undefined, '', 'isolated', 'test', 'dev']) {
    const out = await loadAzureDiStagingSecret({
      env: envName === undefined ? {} : { CHECKSOPS_ENV: envName },
      secretId: PROD,
      getSecretString: getter,
    });
    assert.equal(out.configured, false, envName || 'unset');
    assert.equal(out.code, 'wrong_env', envName || 'unset');
    assert.equal(assertAzureDiSecretIdAllowed(PROD, envName).code, 'wrong_env');
    assert.equal(assertAzureDiSecretIdAllowed(STAGING, envName).code, 'wrong_env');
  }
  assert.equal(loads, 0);
});

test('isolated secret blocked', async () => {
  resetAzureDiSecretCache();
  let loads = 0;
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'staging' },
    secretId: 'checksops/isolated/azure-document-intelligence-504e',
    getSecretString: async () => {
      loads += 1;
      return GOOD;
    },
  });
  assert.equal(out.configured, false);
  assert.equal(out.code, 'isolated_secret_blocked');
  assert.equal(loads, 0);
});

test('shared providers secret id is rejected', async () => {
  resetAzureDiSecretCache();
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'staging' },
    secretId: 'checksops/staging/providers',
    getSecretString: async () => GOOD,
  });
  assert.equal(out.configured, false);
  assert.equal(out.code, 'secret_id_rejected');
});

test('analyze loader returns raw only to Azure client, public status stays redacted', async () => {
  resetAzureDiSecretCache();
  const loader = azureDiAnalyzeSecretLoader({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => GOOD,
  });
  const raw = await loader();
  const status = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'staging' },
    getSecretString: async () => GOOD,
  });
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes(KEY));
  assert.equal(typeof raw, 'string');
  resetAzureDiSecretCache();
});

const assertLoad = async ({ envName, secretId, expectCode, expectConfigured }) => {
  resetAzureDiSecretCache();
  let loads = 0;
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: envName },
    secretId,
    getSecretString: async () => {
      loads += 1;
      return GOOD;
    },
  });
  assert.equal(out.configured, expectConfigured, `${envName} ${secretId} configured`);
  assert.equal(out.code, expectCode, `${envName} ${secretId} code`);
  assert.equal(loads, expectConfigured ? 1 : 0, `${envName} ${secretId} loads`);
  assert.equal('endpoint' in out, false);
  assert.equal('api_key' in out, false);
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.ok(!JSON.stringify(out).includes(ENDPOINT));
  return out;
};

test('allowlist PASS: staging + staging secret', async () => {
  const allowed = assertAzureDiSecretIdAllowed(STAGING, 'staging');
  assert.deepEqual(allowed, { ok: true, secretId: STAGING });
  await assertLoad({ envName: 'staging', secretId: STAGING, expectCode: 'ok', expectConfigured: true });
});

test('allowlist PASS: production + production secret', async () => {
  const allowed = assertAzureDiSecretIdAllowed(PROD, 'production');
  assert.deepEqual(allowed, { ok: true, secretId: PROD });
  await assertLoad({ envName: 'production', secretId: PROD, expectCode: 'ok', expectConfigured: true });
});

test('allowlist PASS: production-prep + production secret', async () => {
  const allowed = assertAzureDiSecretIdAllowed(PROD, 'production-prep');
  assert.deepEqual(allowed, { ok: true, secretId: PROD });
  const out = await assertLoad({
    envName: 'production-prep',
    secretId: PROD,
    expectCode: 'ok',
    expectConfigured: true,
  });
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.ok(!JSON.stringify(out).includes(ENDPOINT));
});

test('allowlist REJECT: staging + production secret', async () => {
  assert.equal(assertAzureDiSecretIdAllowed(PROD, 'staging').code, 'secret_id_rejected');
  await assertLoad({ envName: 'staging', secretId: PROD, expectCode: 'secret_id_rejected', expectConfigured: false });
});

test('allowlist REJECT: production + staging secret', async () => {
  assert.equal(assertAzureDiSecretIdAllowed(STAGING, 'production').code, 'secret_id_rejected');
  await assertLoad({ envName: 'production', secretId: STAGING, expectCode: 'secret_id_rejected', expectConfigured: false });
});

test('allowlist REJECT: production-prep + staging secret', async () => {
  assert.equal(assertAzureDiSecretIdAllowed(STAGING, 'production-prep').code, 'secret_id_rejected');
  await assertLoad({
    envName: 'production-prep',
    secretId: STAGING,
    expectCode: 'secret_id_rejected',
    expectConfigured: false,
  });
});

test('allowlist REJECT: arbitrary secrets under checksops production and staging', async () => {
  const rejected = [
    ['production', 'checksops/production/providers/other'],
    ['production-prep', 'checksops/production/rds'],
    ['production', 'checksops/production/providers/azure-document-intelligence-extra'],
    ['staging', 'checksops/staging/providers/other'],
    ['staging', 'checksops/staging/providers'],
    ['staging', 'checksops/staging/providers/azure-document-intelligence-extra'],
    ['production-prep', 'checksops/staging/providers/azure-document-intelligence'],
    ['production', 'checksops/providers/azure-document-intelligence'],
    ['production-prep', 'unrelated/provider/secret'],
    ['staging', 'aws/secrets/unrelated'],
  ];
  for (const [envName, secretId] of rejected) {
    assert.equal(
      assertAzureDiSecretIdAllowed(secretId, envName).code,
      'secret_id_rejected',
      `${envName} ${secretId}`,
    );
    await assertLoad({ envName, secretId, expectCode: 'secret_id_rejected', expectConfigured: false });
  }
});

test('allowlist REJECT: empty and malformed secret ids', async () => {
  for (const envName of ['staging', 'production', 'production-prep']) {
    for (const secretId of [null, undefined, '', '   ']) {
      assert.equal(
        assertAzureDiSecretIdAllowed(secretId, envName).code,
        'secret_id_missing',
        `${envName} ${JSON.stringify(secretId)}`,
      );
    }
    await assertLoad({
      envName,
      secretId: '',
      expectCode: 'secret_id_missing',
      expectConfigured: false,
    });
  }
});

test('production-prep does not fall back to the staging secret when AZURE_DI_SECRET_ID is unset', async () => {
  resetAzureDiSecretCache();
  let loads = 0;
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'production-prep' },
    getSecretString: async () => {
      loads += 1;
      return GOOD;
    },
  });
  assert.equal(out.configured, false);
  assert.equal(out.code, 'secret_id_rejected');
  assert.equal(loads, 0);
});

test('secret value and api_key never appear in public status or errors', async () => {
  resetAzureDiSecretCache();
  const cases = [
    { env: { CHECKSOPS_ENV: 'production-prep' }, secretId: PROD },
    { env: { CHECKSOPS_ENV: 'production' }, secretId: PROD },
    { env: { CHECKSOPS_ENV: 'staging' }, secretId: STAGING },
    { env: { CHECKSOPS_ENV: 'production-prep' }, secretId: STAGING },
    { env: { CHECKSOPS_ENV: 'staging' }, secretId: PROD },
  ];
  for (const deps of cases) {
    const out = await loadAzureDiStagingSecret({
      ...deps,
      getSecretString: async () => GOOD,
    });
    const dumped = JSON.stringify(out);
    assert.ok(!dumped.includes(KEY), `key leaked for ${deps.env.CHECKSOPS_ENV}`);
    assert.ok(!dumped.includes(ENDPOINT), `endpoint leaked for ${deps.env.CHECKSOPS_ENV}`);
    assert.equal('api_key' in out, false);
    assert.equal('endpoint' in out, false);
    resetAzureDiSecretCache();
  }

  const malformed = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'production-prep' },
    secretId: PROD,
    getSecretString: async () => JSON.stringify({ api_key: KEY, hello: 'world' }),
  });
  assert.equal(malformed.code, 'secret_malformed');
  assert.ok(!JSON.stringify(malformed).includes(KEY));
});
