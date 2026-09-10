import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { syntheticCheckRaster } from '../functions/api/providers/parity/checkalt-image.mjs';
import {
  CHECKALT_ARTIFACT_SUFFIX,
  CHECKALT_CANVAS_HEIGHT,
  CHECKALT_CANVAS_WIDTH,
  CHECKALT_IMAGE_ERROR,
  CHECKALT_MAX_COMPLIANT_BYTES,
  CHECKALT_MIN_BYTES,
  CHECKALT_PAD,
  auditJpegMetadata,
  base64ToBytes,
  bytesToBase64,
  evaluateCheckAltImageCompliance,
  isCheckAltArtifactPath,
  normalizeToCheckAltCanvas,
  samplePixel,
  sha256,
  syntheticCompliantCheckAltJpeg,
  syntheticUndersizedCheckAltJpeg,
  syntheticMarkedCheck,
  toCheckAltPath,
} from '../functions/api/providers/production/checkalt-image-compliance.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  CHECKALT_IMAGE_PREPARATION_REQUIRED,
  runCheckAltOneClickSubmit,
} from '../../src/lib/awsCheckAltMoneyPath.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '44444444-4444-4444-8444-444444444444';

const productionFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_CHECKALT_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const jwtEvent = (pathName, method, body) => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const compliant = () => {
  let jpeg = syntheticCompliantCheckAltJpeg({ quality: 70 });
  if (jpeg.length < 80 * 1024) {
    jpeg = Buffer.concat([jpeg.subarray(0, jpeg.length - 2), Buffer.alloc(80 * 1024 - jpeg.length, 0x20), Buffer.from([0xff, 0xd9])]);
  }
  return jpeg;
};

const sizedCanvas = (targetBytes) => {
  const base = syntheticCompliantCheckAltJpeg({ quality: 78 });
  if (targetBytes <= base.length) return base.subarray(0, targetBytes);
  return Buffer.concat([
    base.subarray(0, base.length - 2),
    Buffer.alloc(targetBytes - base.length, 0x11),
    Buffer.from([0xff, 0xd9]),
  ]);
};

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'owner@freedomadj.com',
  status: 'active',
};

const submitWithFiles = async (files, body = {}) => {
  const { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } = await import('../functions/api/identity.mjs');
  const deposits = [];
  const check = {
    id: CHECK_ID,
    tenant_id: FREEDOM_TENANT,
    amount: 4.5,
    check_number: '1',
    front_image_path: `checks/${CHECK_ID}/front.jpg`,
    back_image_path: `checks/${CHECK_ID}/back.jpg`,
    back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
  };
  const store = {
    deposits,
    processPosts: 0,
    processBodies: [],
    files,
    check,
    memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
    stepups: [{
      id: 'step',
      user_id: FREEDOM_APP,
      tenant_id: FREEDOM_TENANT,
      action_key: 'deposit.submit',
      factor_type: 'totp',
      succeeded: true,
      metadata: { check_id: CHECK_ID, amount_cents: 450 },
      created_at: new Date().toISOString(),
    }],
  };
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
        || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE') || text.startsWith('ROLLBACK TO')) {
        return { rows: [] };
      }
      if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (text === LOOKUP_MAPPING_SQL) return { rows: [mapping] };
      if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
        return { rows: store.memberships };
      }
      if (text.includes('FROM public.user_roles') || (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id'))) {
        return { rows: [{ role: 'admin' }] };
      }
      if (text.includes('FROM public.check_intake_items')) return { rows: [store.check] };
      if (text.includes('aws_checkalt_production_config') || text.includes('FROM public.checkalt_config')) {
        return { rows: [{ merchant: 'prod-merchant', fi_key: 'fi', base_url: 'https://api2.checkalt.com', default_enabled: true }] };
      }
      if (text.includes('FROM public.checkalt_tenant_accounts')) {
        return { rows: [{ tenant_id: FREEDOM_TENANT, enabled: true, sso_user_id: 'dep', deposit_account_number: '1234567890', last_register_payload: { sso_key: 'sso' } }] };
      }
      if (text.includes('FROM public.financial_stepup_log')) return { rows: store.stepups };
      if (text.includes('INSERT INTO public.checkalt_deposits')) {
        const row = {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          check_intake_item_id: params[0],
          tenant_id: params[1],
          amount: params[2],
          amount_cents: params[3],
          status: 'queued',
          idempotency_key: params[5],
          checkalt_reference: null,
          provider_http_attempted_at: null,
        };
        store.deposits.push(row);
        return { rows: [row] };
      }
      if (text.includes('FROM public.checkalt_deposits')) return { rows: store.deposits };
      if (text.includes('UPDATE public.checkalt_deposits') && text.includes('provider_http_attempted_at')) {
        store.deposits[0].provider_http_attempted_at = new Date().toISOString();
        store.deposits[0].status = 'submitting';
        return { rows: [store.deposits[0]] };
      }
      if (text.includes('UPDATE public.checkalt_deposits')) {
        store.deposits[0].status = params[1];
        store.deposits[0].checkalt_reference = params[2];
        return { rows: [store.deposits[0]] };
      }
      return { rows: [] };
    },
  };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/authenticate')) {
      const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"exp":9999999999}').toString('base64url')}.sig`;
      return { ok: true, status: 200, text: async () => token };
    }
    if (target.includes('/deposit/process')) {
      store.processPosts += 1;
      store.processBodies.push(JSON.parse(options.body || '{}'));
      return { ok: true, status: 200, text: async () => JSON.stringify({ referenceNumber: 1, status: 127 }) };
    }
    return { ok: false, status: 404, text: async () => 'no' };
  };
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', {
      check_intake_item_id: CHECK_ID,
      ...body,
    }),
    '/functions/v1/checkalt-submit-deposit',
    'POST',
    {
      createClient: () => client,
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      fetchImpl,
      loadProductionSecrets: async () => ({
        ok: true,
        credentials: {
          environment: 'production',
          username: 'u',
          password: 'p',
          fiKey: 'fi',
          baseUrl: 'https://api2.checkalt.com',
          webhookSecretConfigured: true,
        },
      }),
      downloadClaimFile: async (filePath) => store.files[filePath] || null,
    },
  ));
  return { result, store };
};

const pair = (front, rear) => ({
  [`checks/${CHECK_ID}/front.checkalt.jpg`]: front,
  [`checks/${CHECK_ID}/back.checkalt.jpg`]: rear,
});

test('official constants and artifact suffix are the production contract', () => {
  assert.equal(CHECKALT_CANVAS_WIDTH, 1920);
  assert.equal(CHECKALT_CANVAS_HEIGHT, 1080);
  assert.equal(CHECKALT_MIN_BYTES, 25 * 1024);
  assert.equal(CHECKALT_MAX_COMPLIANT_BYTES, 300 * 1024);
  assert.equal(CHECKALT_ARTIFACT_SUFFIX, '.checkalt.jpg');
  assert.equal(CHECKALT_PAD.strategy, 'contain');
  assert.equal(CHECKALT_PAD.allowUpscale, false);
  assert.equal(toCheckAltPath('checks/a/front.jpg'), 'checks/a/front.checkalt.jpg');
  assert.equal(isCheckAltArtifactPath('checks/a/front.deposit2.jpg'), false);
  assert.equal(isCheckAltArtifactPath('checks/a/front.checkalt.jpg'), true);
  const spa = fs.readFileSync(path.join(ROOT, 'src/lib/checkaltImageCompliance.ts'), 'utf8');
  assert.match(spa, /CHECKALT_CANVAS_WIDTH = 1920/);
  assert.match(spa, /CHECKALT_CANVAS_HEIGHT = 1080/);
  assert.match(spa, /CHECKALT_MIN_BYTES = 25 \* 1024/);
  assert.match(spa, /CHECKALT_MAX_COMPLIANT_BYTES = 300 \* 1024/);
  assert.doesNotMatch(spa, /encodeTIFF|CCITT Group 4/);
  const server = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-image-compliance.mjs'), 'utf8');
  assert.doesNotMatch(server, /encodeTIFF|CCITT Group 4/);
});

test('1. front + rear 1920x1080 ~80KB PASS and share one process body', async () => {
  const jpeg = compliant();
  assert.ok(jpeg.length >= 25 * 1024);
  const { result, store } = await submitWithFiles(pair(jpeg, jpeg));
  assert.equal(result.error, undefined);
  assert.equal(result.liveProviderCalled, true);
  assert.equal(store.processPosts, 1);
  assert.ok(store.processBodies[0].frontImage);
  assert.ok(store.processBodies[0].rearImage);
});

test('2-3. missing front or rear fails with zero provider HTTP', async () => {
  const jpeg = compliant();
  const missingFront = await submitWithFiles({ [`checks/${CHECK_ID}/back.checkalt.jpg`]: jpeg });
  assert.equal(missingFront.result.error, CHECKALT_IMAGE_ERROR);
  assert.equal(missingFront.result.reason, 'front_missing');
  assert.equal(missingFront.store.processPosts, 0);

  const missingRear = await submitWithFiles({ [`checks/${CHECK_ID}/front.checkalt.jpg`]: jpeg });
  assert.equal(missingRear.result.error, CHECKALT_IMAGE_ERROR);
  assert.equal(missingRear.result.reason, 'rear_missing');
  assert.equal(missingRear.store.processPosts, 0);
});

test('4-6. 1600x900, 1200x550, and portrait cannot submit', async () => {
  const good = compliant();
  for (const [label, bad] of [
    ['1600x900', syntheticCheckRaster({ width: 1600, height: 900, flat: true })],
    ['1200x550', syntheticCheckRaster({ width: 1200, height: 550, flat: true })],
    ['portrait', syntheticCheckRaster({ width: 1080, height: 1920, flat: true })],
  ]) {
    const { result, store } = await submitWithFiles(pair(bad, good));
    assert.equal(result.error, CHECKALT_IMAGE_ERROR, label);
    assert.equal(result.reason, 'front_dimensions', label);
    assert.equal(store.processPosts, 0, label);
  }
});

test('7-10. per-image size bands', async () => {
  const good = compliant();
  const tiny = syntheticUndersizedCheckAltJpeg();
  assert.ok(tiny.length < CHECKALT_MIN_BYTES);
  const mid = sizedCanvas(280 * 1024);
  const overPreferred = sizedCanvas(320 * 1024);
  const overAbsolute = sizedCanvas(1_100_000);

  assert.equal(evaluateCheckAltImageCompliance(tiny, 'front').reason, 'front_too_small');
  assert.equal(evaluateCheckAltImageCompliance(mid, 'front').pass, true);
  assert.equal(evaluateCheckAltImageCompliance(overPreferred, 'front').reason, 'front_too_large');
  assert.equal(evaluateCheckAltImageCompliance(overAbsolute, 'front').reason, 'front_too_large');

  const t = await submitWithFiles(pair(tiny, good));
  assert.equal(t.result.reason, 'front_too_small');
  assert.equal(t.store.processPosts, 0);

  const p = await submitWithFiles(pair(mid, mid));
  assert.equal(p.result.liveProviderCalled, true);
  assert.equal(p.store.processPosts, 1);

  const o = await submitWithFiles(pair(overPreferred, good));
  assert.equal(o.result.reason, 'front_too_large');
  assert.equal(o.store.processPosts, 0);

  const a = await submitWithFiles(pair(overAbsolute, good));
  assert.equal(a.result.reason, 'front_too_large');
  assert.equal(a.store.processPosts, 0);
});

test('11. invalid JPEG magic fails closed', async () => {
  const good = compliant();
  const { result, store } = await submitWithFiles(pair(Buffer.from('not-a-jpeg'), good));
  assert.equal(result.error, CHECKALT_IMAGE_ERROR);
  assert.equal(result.reason, 'front_invalid_jpeg');
  assert.equal(store.processPosts, 0);
});

test('12-14. contain+pad keeps the full check, no crop, no stretch', () => {
  const source = syntheticMarkedCheck({ width: 1600, height: 800 });
  const out = normalizeToCheckAltCanvas(source);
  assert.equal(out.ok, true);
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
  assert.equal(out.contentRect.width, 1600);
  assert.equal(out.contentRect.height, 800);
  assert.ok(Math.abs((1600 / 800) - (out.contentRect.width / out.contentRect.height)) < 0.001);
  const pad = samplePixel(out.bytes, 2, 2);
  assert.ok(pad[0] > 240 && pad[1] > 240 && pad[2] > 240);
  const red = samplePixel(out.bytes, out.contentRect.x + 4, out.contentRect.y + 4);
  const green = samplePixel(out.bytes, out.contentRect.x + 1596, out.contentRect.y + 4);
  const blue = samplePixel(out.bytes, out.contentRect.x + 4, out.contentRect.y + 796);
  const yellow = samplePixel(out.bytes, out.contentRect.x + 1596, out.contentRect.y + 796);
  assert.ok(red[0] > 200 && red[1] < 80, `red ${red}`);
  assert.ok(green[1] > 200 && green[0] < 80, `green ${green}`);
  assert.ok(blue[2] > 200 && blue[0] < 80, `blue ${blue}`);
  assert.ok(yellow[0] > 200 && yellow[1] > 200 && yellow[2] < 80, `yellow ${yellow}`);
});

test('15. old 1200px endorsed rear cannot submit', async () => {
  const good = compliant();
  const oldRear = syntheticCheckRaster({ width: 1200, height: 550, flat: true });
  const { result, store } = await submitWithFiles(pair(good, oldRear));
  assert.equal(result.reason, 'rear_dimensions');
  assert.equal(store.processPosts, 0);
});

test('16. Command Center one-click cannot bypass official preparation', async () => {
  let fetched = 0;
  const blocked = await runCheckAltOneClickSubmit(CHECK_ID, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    idToken: 'token',
    prepareCheckAltDeposit: async () => ({
      deposit_front_path: `checks/${CHECK_ID}/front.deposit2.jpg`,
      deposit_back_path: `checks/${CHECK_ID}/back.deposit2.jpg`,
    }),
    fetchImpl: async () => {
      fetched += 1;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.match(String(blocked.error?.message), /CHECKALT_IMAGE_PREPARATION_REQUIRED|checkalt/);
  assert.equal(fetched, 0);

  const oneClick = fs.readFileSync(path.join(ROOT, 'src/lib/awsCheckAltMoneyPath.ts'), 'utf8');
  assert.match(oneClick, /prepareCheckAltDeposit/);
  assert.match(oneClick, /isCheckAltArtifactPath/);
  const ccc = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  assert.match(ccc, /CheckAltImageComplianceCard/);
  assert.match(ccc, /runCheckAltOneClickSubmit/);
});

test('17-19. same process body, stored SHA equals decoded outbound, failure is zero HTTP', async () => {
  const front = compliant();
  const rear = syntheticCompliantCheckAltJpeg({ seed: 90, quality: 68 });
  const { result, store } = await submitWithFiles(pair(front, rear));
  assert.equal(store.processPosts, 1);
  const body = store.processBodies[0];
  assert.equal(sha256(front), sha256(base64ToBytes(body.frontImage)));
  assert.equal(sha256(rear), sha256(base64ToBytes(body.rearImage)));
  assert.equal(bytesToBase64(front), body.frontImage);
  assert.equal(result.imagePipeline, 'checkalt_official_canvas_base64');

  const failed = await submitWithFiles(pair(syntheticCheckRaster({ width: 1600, height: 900 }), rear));
  assert.equal(failed.store.processPosts, 0);
  assert.equal(failed.result.liveProviderCalled, false);
});

test('20. browser-supplied provider image bytes remain rejected', async () => {
  const jpeg = compliant();
  const { result, store } = await submitWithFiles(pair(jpeg, jpeg), {
    frontImage: bytesToBase64(jpeg),
    rearImage: bytesToBase64(jpeg),
  });
  assert.equal(result.error, 'untrusted_image_bytes');
  assert.equal(store.processPosts, 0);
});

test('source too small to fabricate detail fails normalization', () => {
  const tiny = syntheticCheckRaster({ width: 400, height: 200, flat: true });
  const out = normalizeToCheckAltCanvas(tiny);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'source_too_small');
});

test('normalized output does not fabricate camera EXIF', () => {
  const source = syntheticMarkedCheck({ width: 1600, height: 800 });
  const out = normalizeToCheckAltCanvas(source);
  assert.equal(out.ok, true);
  assert.equal(out.metadata.cameraExifFabricated, false);
  assert.equal(out.metadata.hasExif, false);
  const audit = auditJpegMetadata(out.bytes);
  assert.equal(audit.cameraExifFabricated, false);
});
