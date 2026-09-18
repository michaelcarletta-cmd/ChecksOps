import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STAGING_AZURE_DI_SECRET_ID,
  assertAzureDiSecretIdAllowed,
  azureDiAnalyzeSecretLoader,
  loadAzureDiStagingSecret,
  resetAzureDiSecretCache,
} from '../functions/api/azure-di-secret.mjs';

const ENDPOINT = 'https://di-test.example.test';
const KEY = 'test-azure-key-not-real';
const GOOD = JSON.stringify({ api_key: KEY, endpoint: ENDPOINT });

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

test('wrong env blocked', async () => {
  resetAzureDiSecretCache();
  let loads = 0;
  const out = await loadAzureDiStagingSecret({
    env: { CHECKSOPS_ENV: 'production' },
    getSecretString: async () => {
      loads += 1;
      return GOOD;
    },
  });
  assert.equal(out.configured, false);
  assert.equal(out.code, 'wrong_env');
  assert.equal(loads, 0);
  assert.equal(assertAzureDiSecretIdAllowed(STAGING_AZURE_DI_SECRET_ID, 'production').code, 'wrong_env');
  const unset = await loadAzureDiStagingSecret({
    env: {},
    getSecretString: async () => {
      loads += 1;
      return GOOD;
    },
  });
  assert.equal(unset.configured, false);
  assert.equal(unset.code, 'wrong_env');
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
