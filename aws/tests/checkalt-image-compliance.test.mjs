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
  CHECKALT_JPEG_QUALITY_LADDER,
  CHECKALT_MAX_COMPLIANT_BYTES,
  CHECKALT_MIN_BYTES,
  CHECKALT_MIN_JPEG_QUALITY,
  CHECKALT_PAD,
  CHECKALT_VENDOR_PENDING,
  auditJpegMetadata,
  base64ToBytes,
  bytesToBase64,
  evaluateCheckAltImageCompliance,
  isCheckAltArtifactPath,
  normalizeToCheckAltCanvas,
  planCheckAltContain,
  samplePixel,
  sha256,
  syntheticCompliantCheckAltJpeg,
  syntheticRegionCheck,
  syntheticUndersizedCheckAltJpeg,
  syntheticMarkedCheck,
  toCheckAltPath,
} from '../functions/api/providers/production/checkalt-image-compliance.mjs';
import { buildDepositProcessBody } from '../functions/api/providers/parity/checkalt-client.mjs';
import { loadProductionDepositImages } from '../functions/api/providers/production/checkalt-images.mjs';
import { buildCompletedEndorsementState } from '../functions/api/providers/production/checkalt-eligibility.mjs';
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
  const eligible = buildCompletedEndorsementState({ checkId: CHECK_ID, tenantId: FREEDOM_TENANT });
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
    endorsement_render_meta: { checkalt_rear_fingerprint: eligible.fingerprint },
  };
  const store = {
    deposits,
    processPosts: 0,
    authenticatePosts: 0,
    processBodies: [],
    files,
    check,
    payees: eligible.payees,
    endorsements: eligible.endorsements,
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
      if (text.includes('FROM public.check_payees')) return { rows: store.payees };
      if (text.includes('FROM public.check_endorsements')) return { rows: store.endorsements };
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
      store.authenticatePosts += 1;
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
  assert.equal(CHECKALT_VENDOR_PENDING.iclConversionInApiPath, false);
  assert.equal(CHECKALT_VENDOR_PENDING.writeJfifDpi, false);
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
  assert.equal(missingFront.result.error, 'provider_front_image_missing');
  assert.equal(missingFront.result.reason, 'front_missing');
  assert.equal(missingFront.store.processPosts, 0);

  const missingRear = await submitWithFiles({ [`checks/${CHECK_ID}/front.checkalt.jpg`]: jpeg });
  assert.equal(missingRear.result.error, 'provider_rear_image_missing');
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
    assert.equal(result.error, 'checkalt_image_noncompliant', label);
    assert.equal(result.complianceError, CHECKALT_IMAGE_ERROR, label);
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
  assert.equal(t.result.error, 'checkalt_image_noncompliant');
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
  assert.equal(result.error, 'checkalt_image_noncompliant');
  assert.equal(result.complianceError, CHECKALT_IMAGE_ERROR);
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
  assert.match(ccc, /runCheckAltDepositClick/);
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

const near = (actual, expected, slack = 40) =>
  Math.abs(actual[0] - expected[0]) < slack
  && Math.abs(actual[1] - expected[1]) < slack
  && Math.abs(actual[2] - expected[2]) < slack;

const mapSourcePoint = (rect, scale, x, y) => ({
  x: rect.x + Math.round(x * scale),
  y: rect.y + Math.round(y * scale),
});

test('source-size contain+pad never upscales; 1920x1080 is the canvas only', () => {
  const cases = [
    [1200, 500],
    [1300, 550],
    [1600, 670],
    [1919, 800],
    [1920, 800],
    [2400, 1000],
    [4000, 1667],
  ];
  const table = [];
  for (const [width, height] of cases) {
    const plan = planCheckAltContain({ width, height });
    const source = syntheticMarkedCheck({ width, height });
    const out = normalizeToCheckAltCanvas(source);
    const report = out.ok ? evaluateCheckAltImageCompliance(out.bytes, 'front') : { pass: false, reason: out.error };
    assert.equal(plan.sourcePixelsEnlarged, false, `${width}x${height} enlarged`);
    assert.ok(plan.scale <= 1, `${width}x${height} scale`);
    assert.equal(plan.canvasWidth, 1920);
    assert.equal(plan.canvasHeight, 1080);
    assert.ok(Math.abs(plan.sourceAspect - plan.renderedAspect) < 0.01, `${width}x${height} stretch`);
    table.push({
      source: `${width}x${height}`,
      scale: Number(plan.scale.toFixed(6)),
      rendered: `${plan.renderedWidth}x${plan.renderedHeight}`,
      canvas: `${plan.canvasWidth}x${plan.canvasHeight}`,
      sourcePixelsEnlarged: plan.sourcePixelsEnlarged,
      padding: {
        left: plan.padLeft,
        right: plan.padRight,
        top: plan.padTop,
        bottom: plan.padBottom,
      },
      normalizeOk: out.ok === true,
      serverValidation: report.pass ? 'PASS' : report.reason,
    });
  }
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/phase3b3a_source_size_table.json', JSON.stringify(table, null, 2));
  assert.equal(table.length, 7);
  assert.equal(CHECKALT_PAD.allowUpscale, false);
  assert.equal(CHECKALT_VENDOR_PENDING.canvasInterpretation, 'exact_api_jpeg_canvas');
  assert.equal(CHECKALT_VENDOR_PENDING.allowUpscale, false);
  assert.equal(CHECKALT_VENDOR_PENDING.objectiveReadabilityMetric, null);
});

test('quality ladder is fail-closed at min quality 50 with no readability metric', () => {
  assert.equal(CHECKALT_MIN_JPEG_QUALITY, 50);
  assert.equal(Math.min(...CHECKALT_JPEG_QUALITY_LADDER), 50);
  assert.ok(CHECKALT_JPEG_QUALITY_LADDER.every((q) => q >= CHECKALT_MIN_JPEG_QUALITY));
  assert.equal(CHECKALT_VENDOR_PENDING.objectiveReadabilityMetric, null);
  assert.equal(CHECKALT_VENDOR_PENDING.maxBytesIsHardLimit, true);
  const spa = fs.readFileSync(path.join(ROOT, 'src/lib/checkaltImageCompliance.ts'), 'utf8');
  assert.match(spa, /CHECKALT_MIN_JPEG_QUALITY = 0\.5/);
  assert.match(spa, /Minimum approved JPEG quality still exceeds 300KB/);
});

test('personal and business check aspect ratios keep MICR, edges, signature, endorsement', () => {
  const samples = [
    { label: 'personal-front', width: 1600, height: 733, kind: 'front' },
    { label: 'personal-rear', width: 1600, height: 733, kind: 'rear' },
    { label: 'business-front', width: 2400, height: 990, kind: 'front' },
    { label: 'business-rear', width: 2400, height: 990, kind: 'rear' },
  ];
  for (const sample of samples) {
    const { bytes, regions } = syntheticRegionCheck(sample);
    const out = normalizeToCheckAltCanvas(bytes);
    assert.equal(out.ok, true, sample.label);
    assert.equal(out.sourcePixelsEnlarged, false, sample.label);
    assert.ok(out.scale <= 1, sample.label);
    assert.ok(Math.abs((sample.width / sample.height) - (out.contentRect.width / out.contentRect.height)) < 0.01, sample.label);
    const pad = samplePixel(out.bytes, 2, 2);
    assert.ok(pad[0] > 240 && pad[1] > 240 && pad[2] > 240, `${sample.label} pad`);
    for (const [name, region] of Object.entries(regions)) {
      if (!region) continue;
      const mapped = mapSourcePoint(out.contentRect, out.scale, region.x, region.y);
      assert.ok(mapped.x >= out.contentRect.x && mapped.x < out.contentRect.x + out.contentRect.width, `${sample.label} ${name} x`);
      assert.ok(mapped.y >= out.contentRect.y && mapped.y < out.contentRect.y + out.contentRect.height, `${sample.label} ${name} y`);
      const pixel = samplePixel(out.bytes, mapped.x, mapped.y);
      assert.ok(near(pixel, region.rgb), `${sample.label} ${name} ${pixel} != ${region.rgb}`);
    }
  }
});

test('renamed non-compliant .checkalt.jpg is rejected by actual S3 bytes', async () => {
  const good = compliant();
  const fakeName = syntheticCheckRaster({ width: 1600, height: 900, flat: true });
  const { result, store } = await submitWithFiles({
    [`checks/${CHECK_ID}/front.checkalt.jpg`]: fakeName,
    [`checks/${CHECK_ID}/back.checkalt.jpg`]: good,
  });
  assert.equal(result.error, 'checkalt_image_noncompliant');
  assert.equal(result.complianceError, CHECKALT_IMAGE_ERROR);
  assert.equal(result.reason, 'front_dimensions');
  assert.equal(store.processPosts, 0);
  assert.equal(store.authenticatePosts, 0);
  assert.equal(store.deposits.length, 0);
});

test('cross-tenant and arbitrary .checkalt.jpg body paths cannot override server artifacts', async () => {
  const good = compliant();
  const files = {
    ...pair(good, good),
    'checks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/front.checkalt.jpg': good,
    'secrets/other.checkalt.jpg': good,
  };
  const foreign = await submitWithFiles(files, {
    deposit_front_path: 'checks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/front.checkalt.jpg',
    deposit_back_path: `checks/${CHECK_ID}/back.checkalt.jpg`,
  });
  assert.equal(foreign.result.error, undefined, JSON.stringify(foreign.result));
  assert.equal(foreign.result.liveProviderCalled, true);
  assert.equal(foreign.store.processPosts, 1);
  assert.ok(foreign.store.processBodies[0].frontImage);
  assert.equal(foreign.store.processBodies[0].frontImage, bytesToBase64(good));

  const arbitrary = await submitWithFiles(files, {
    deposit_front_path: 'secrets/other.checkalt.jpg',
    deposit_back_path: `checks/${CHECK_ID}/back.checkalt.jpg`,
  });
  assert.equal(arbitrary.result.error, undefined, JSON.stringify(arbitrary.result));
  assert.equal(arbitrary.result.liveProviderCalled, true);
  assert.equal(arbitrary.store.processPosts, 1);
  assert.equal(arbitrary.store.processBodies[0].frontImage, bytesToBase64(good));
});

test('production body builder base64s exact stored S3 bytes with no later processing', async () => {
  const front = compliant();
  const rear = syntheticCompliantCheckAltJpeg({ seed: 77, quality: 70 });
  const check = {
    id: CHECK_ID,
    front_image_path: `checks/${CHECK_ID}/front.jpg`,
    back_image_path: `checks/${CHECK_ID}/back.jpg`,
    back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
  };
  const files = pair(front, rear);
  const images = await loadProductionDepositImages(check, {}, {
    downloadClaimFile: async (filePath) => files[filePath] || null,
  });
  assert.equal(images.ok, true);
  assert.equal(images.frontSha256, sha256(front));
  assert.equal(images.rearSha256, sha256(rear));
  const processBody = buildDepositProcessBody({
    fiKey: 'fi',
    ssoKey: 'sso',
    depositAccountNumber: '1234567890',
    captureDateTime: '2026-09-10T00:00:00.000Z',
    userAmount: 4.5,
    frontImage: images.frontImage,
    rearImage: images.rearImage,
  });
  assert.equal(sha256(front), sha256(base64ToBytes(processBody.frontImage)));
  assert.equal(sha256(rear), sha256(base64ToBytes(processBody.rearImage)));
  assert.equal(processBody.frontImage, bytesToBase64(front));
  assert.equal(processBody.rearImage, bytesToBase64(rear));

  const { result, store } = await submitWithFiles(files);
  assert.equal(store.processPosts, 1);
  assert.equal(sha256(front), sha256(base64ToBytes(store.processBodies[0].frontImage)));
  assert.equal(sha256(rear), sha256(base64ToBytes(store.processBodies[0].rearImage)));
  assert.equal(result.imagePipeline, 'checkalt_official_canvas_base64');
});

test('compliance failures never authenticate, mark attempted, or POST process', async () => {
  const good = compliant();
  const failures = [
    [{ [`checks/${CHECK_ID}/back.checkalt.jpg`]: good }, {}, 'front_missing'],
    [{ [`checks/${CHECK_ID}/front.checkalt.jpg`]: good }, {}, 'rear_missing'],
    [pair(syntheticCheckRaster({ width: 1600, height: 900 }), good), {}, 'front_dimensions'],
    [pair(Buffer.from('not-a-jpeg'), good), {}, 'front_invalid_jpeg'],
  ];
  for (const [files, body, reason] of failures) {
    const { result, store } = await submitWithFiles(files, body);
    const expectedError = reason === 'front_missing'
      ? 'provider_front_image_missing'
      : reason === 'rear_missing'
        ? 'provider_rear_image_missing'
        : 'checkalt_image_noncompliant';
    assert.equal(result.error, expectedError, reason);
    assert.equal(result.reason, reason);
    if (reason !== 'front_missing' && reason !== 'rear_missing') {
      assert.equal(result.complianceError, CHECKALT_IMAGE_ERROR, reason);
    }
    assert.equal(store.authenticatePosts, 0, reason);
    assert.equal(store.processPosts, 0, reason);
    assert.equal(store.deposits.length, 0, reason);
    assert.equal(result.liveProviderCalled, false, reason);
  }
});

test('Command Center cannot bypass official artifacts or the compliance card', async () => {
  let fetched = 0;
  const blockedDeposit2 = await runCheckAltOneClickSubmit(CHECK_ID, {
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
  assert.equal(blockedDeposit2.error?.message, CHECKALT_IMAGE_PREPARATION_REQUIRED);
  assert.equal(fetched, 0);

  const blockedOld = await runCheckAltOneClickSubmit(CHECK_ID, {
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    idToken: 'token',
    prepareCheckAltDeposit: async () => ({
      deposit_front_path: `checks/${CHECK_ID}/front.jpg`,
      deposit_back_path: `checks/${CHECK_ID}/endorsed_1200.jpg`,
    }),
    fetchImpl: async () => {
      fetched += 1;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(blockedOld.error?.message, CHECKALT_IMAGE_PREPARATION_REQUIRED);
  assert.equal(fetched, 0);

  const ccc = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  assert.match(ccc, /CheckAltImageComplianceCard/);
  assert.match(ccc, /runCheckAltDepositClick/);
  assert.doesNotMatch(ccc, /checkAltImagePass/);
  assert.doesNotMatch(ccc, /!checkAltImagePass/);
  const start = ccc.indexOf('const handleDepositWithCheckAlt');
  const end = ccc.indexOf('const ensureDepositReadyBackImage', start);
  const oneClickFn = end === -1 ? ccc.slice(start, start + 3500) : ccc.slice(start, end);
  assert.doesNotMatch(oneClickFn, /prepare_deposit/);
  assert.doesNotMatch(oneClickFn, /assign_provider/);
  assert.match(oneClickFn, /runCheckAltDepositClick/);
  assert.match(oneClickFn, /requireStepUp/);
  const card = fs.readFileSync(path.join(ROOT, 'src/components/checks/CheckAltImageComplianceCard.tsx'), 'utf8');
  assert.doesNotMatch(card, /Prepare official 1920/);
  assert.doesNotMatch(card, /prepareCheckAltDeposit/);
  assert.match(card, /Deposit will prepare the front and back images automatically/);
});
