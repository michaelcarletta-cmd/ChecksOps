import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterGenuineEndorsementSigned,
  compositeEndorsementSignatures,
  hasUsableDrawnInk,
  invalidateOfficialRearImage,
  isDrawnSignature,
  isGenuineDrawnCompletion,
  makeInkSignatureDataUrl,
  requireDrawnSignature,
  renderDepositJpeg,
} from '../functions/api/endorsement-composite.mjs';
import {
  runAuthenticatedEndorsement,
  runPublicEndorsement,
} from '../functions/api/check-endorsement.mjs';
import {
  ERROR_PROVIDER_REAR_IMAGE_MISSING,
  evaluateOfficialImagePaths,
  evaluateProductionDepositEligibility,
  officialCheckAltRearPath,
} from '../functions/api/providers/production/checkalt-eligibility.mjs';
import {
  bytesToBase64,
  sha256,
  syntheticCompliantCheckAltJpeg,
} from '../functions/api/providers/production/checkalt-image-compliance.mjs';
import { loadProductionDepositImages } from '../functions/api/providers/production/checkalt-images.mjs';
import { buildDepositProcessBody } from '../functions/api/providers/parity/checkalt-client.mjs';
import { handleCompositeEndorsementSignatures } from '../functions/api/documents.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_ID = '44444444-4444-4444-8444-444444444444';
const PAYEE_ID = '55555555-5555-4555-8555-555555555555';
const ENDORSE_ID_2 = '66666666-6666-4666-8666-666666666666';
const PAYEE_ID_2 = '77777777-7777-4777-8777-777777777777';
const USER_ID = '88888888-8888-4888-8888-888888888888';
const ORIGINAL_BACK = `checks/${CHECK_ID}/back-original.jpg`;
const FRONT = `checks/${CHECK_ID}/front.jpg`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const eventOf = (body = {}, headers = {}) => ({
  headers,
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } },
});

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const sqlClient = (handlers) => mockClient((sql, params) => {
  const compact = sql.replace(/\s+/g, ' ');
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) return { rows: [], rowCount: 0 };
  for (const handler of handlers) {
    if (handler.match(compact, params)) return handler.result(params, compact);
  }
  return { rows: [], rowCount: 0 };
});

const createStore = ({
  endorsements = [],
  payees = [],
  check = {},
  deposits = [],
} = {}) => {
  const files = new Map();
  const state = {
    check: {
      id: CHECK_ID,
      tenant_id: TENANT,
      front_image_path: FRONT,
      back_image_path: ORIGINAL_BACK,
      back_image_original_path: ORIGINAL_BACK,
      back_image_deposit_path: null,
      endorsement_override: null,
      endorsement_render_meta: {},
      endorsement_render_status: 'idle',
      endorsement_render_version: 0,
      status: 'endorsements_in_progress',
      check_stage: 'endorsing',
      ...check,
    },
    endorsements: endorsements.map((row) => ({ ...row })),
    payees: payees.map((row) => ({ ...row })),
    deposits: deposits.map((row) => ({ ...row })),
    files,
    updates: [],
  };
  const client = mockClient((sql, params) => {
    const compact = sql.replace(/\s+/g, ' ');
    if (compact.includes('FROM public.check_intake_items') && compact.includes('SELECT')) {
      return { rows: [state.check], rowCount: 1 };
    }
    if (compact.includes('FROM public.check_endorsements e')
      || (compact.includes('FROM public.check_endorsements') && compact.includes('payee_id'))) {
      return { rows: state.endorsements, rowCount: state.endorsements.length };
    }
    if (compact.includes('FROM public.check_endorsements WHERE token')) {
      return { rows: state.endorsements.filter((row) => row.token === params[0]), rowCount: 1 };
    }
    if (compact.includes('FROM public.check_endorsements WHERE id')) {
      return { rows: state.endorsements.filter((row) => row.id === params[0]), rowCount: 1 };
    }
    if (compact.includes('SELECT status, payee_type FROM public.check_endorsements')) {
      return { rows: state.endorsements.map((row) => ({ status: row.status, payee_type: row.payee_type })) };
    }
    if (compact.includes('FROM public.check_payees') && compact.includes('PAYEES_ELIGIBILITY') === false) {
      if (compact.includes('endorsement_status')) {
        return { rows: state.payees, rowCount: state.payees.length };
      }
    }
    if (compact.includes('FROM public.check_payees') && compact.includes('WHERE check_id')) {
      return { rows: state.payees, rowCount: state.payees.length };
    }
    if (compact.includes('FROM public.checkalt_deposits')) {
      return { rows: state.deposits, rowCount: state.deposits.length };
    }
    if (compact.includes('FROM public.tenants')) {
      return { rows: [{ name: 'Freedom Adjustment' }], rowCount: 1 };
    }
    if (compact.includes('UPDATE public.check_intake_items')) {
      state.updates.push({ sql: compact, params });
      if (compact.includes('back_image_deposit_path = $2')) {
        state.check.back_image_deposit_path = params[1];
        state.check.back_image_original_path = state.check.back_image_original_path || params[2];
        state.check.endorsement_render_status = 'completed';
        state.check.endorsement_render_meta = {
          ...(state.check.endorsement_render_meta || {}),
          ...(typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3] || {}),
        };
      }
      if (compact.includes('back_image_deposit_path = NULL')) {
        state.check.back_image_deposit_path = null;
        state.check.endorsement_render_status = 'idle';
        const meta = { ...(state.check.endorsement_render_meta || {}) };
        delete meta.checkalt_rear_fingerprint;
        state.check.endorsement_render_meta = meta;
      }
      if (compact.includes('jsonb_build_object($2::text, $3::text)')) {
        state.check.endorsement_render_meta = {
          ...(state.check.endorsement_render_meta || {}),
          [params[1]]: params[2],
        };
      }
      return { rows: [state.check], rowCount: 1 };
    }
    if (compact.includes("SET status = 'signed'")) {
      const target = state.endorsements.find((row) => row.id === params[0] || row.token === params[params.length - 1]);
      if (target) {
        target.status = 'signed';
        target.signed_at = new Date().toISOString();
        target.signature_image_url = params[1];
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { state, client, files };
};

test('drawn signature helpers reject status-only completion', () => {
  assert.equal(isDrawnSignature('data:image/png;base64,aaa'), true);
  assert.equal(isDrawnSignature('typed:Jane'), false);
  assert.equal(requireDrawnSignature(null).ok, false);
  assert.equal(requireDrawnSignature('typed:Jane').ok, false);
  assert.equal(isGenuineDrawnCompletion({
    status: 'signed',
    signature_image_url: 'data:image/png;base64,aaa',
    signature_method: 'portal',
  }), true);
  assert.equal(isGenuineDrawnCompletion({
    status: 'signed',
    signature_image_url: null,
    signature_method: 'portal',
  }), false);
  assert.equal(hasUsableDrawnInk({ signature_image_url: null }), false);
});

test('email/remote submit refuses missing ink and persists a drawn PNG', async () => {
  const missing = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    eSignConsentAccepted: true,
  }), {
    client: sqlClient([{
      match: (sql) => sql.includes('FROM public.check_endorsements WHERE token'),
      result: () => ({ rows: [{
        id: ENDORSE_ID,
        check_id: CHECK_ID,
        tenant_id: TENANT,
        payee_name: 'Jane Doe',
        status: 'sent',
        token: 'tok',
      }] }),
    }]),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.statusCode, 400);
  assert.match(missing.error, /signatureData/);

  const ink = makeInkSignatureDataUrl({ mark: 'REMOTE' });
  let stored = null;
  const submitted = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    eSignConsentAccepted: true,
    signatureData: ink,
  }), {
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE token'),
        result: () => ({ rows: [{
          id: ENDORSE_ID,
          check_id: CHECK_ID,
          tenant_id: TENANT,
          payee_id: PAYEE_ID,
          payee_name: 'Jane Doe',
          payee_type: 'insured',
          status: 'sent',
          token: 'tok',
        }] }),
      },
      {
        match: (sql) => sql.includes("SET status = 'signed'"),
        result: (params) => {
          stored = params[1];
          return { rows: [], rowCount: 1 };
        },
      },
      {
        match: (sql) => sql.includes('SELECT status, payee_type'),
        result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
      },
    ]),
  });
  assert.equal(submitted.ok, true);
  assert.equal(stored, ink);
  assert.equal(isDrawnSignature(stored), true);
  assert.equal(submitted.depositAdvanceDenied, true);
});

test('sign in person persists the drawn PNG and will not accept typed ink', async () => {
  const endorsement = {
    id: ENDORSE_ID,
    check_id: CHECK_ID,
    tenant_id: TENANT,
    payee_name: 'Jane Doe',
    payee_id: PAYEE_ID,
  };
  const typed = await runAuthenticatedEndorsement({
    client: sqlClient([
      { match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'), result: () => ({ rows: [endorsement] }) },
      { match: (sql) => sql.includes('FROM public.check_intake_items'), result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT }] }) },
      { match: (sql) => sql.includes('aws_can_write_tenant'), result: () => ({ rows: [{ ok: true }] }) },
    ]),
    mapping: { application_user_id: USER_ID },
    body: { action: 'sign_in_person', endorsementId: ENDORSE_ID, signatureData: 'typed:Jane', eSignConsentAccepted: true },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(typed.statusCode, 400);

  const ink = makeInkSignatureDataUrl({ mark: 'PERSON' });
  let stored = null;
  const signed = await runAuthenticatedEndorsement({
    client: sqlClient([
      { match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'), result: () => ({ rows: [endorsement] }) },
      { match: (sql) => sql.includes('FROM public.check_intake_items'), result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT }] }) },
      { match: (sql) => sql.includes('aws_can_write_tenant'), result: () => ({ rows: [{ ok: true }] }) },
      {
        match: (sql) => sql.includes("SET status = 'signed'"),
        result: (params) => {
          stored = params[1];
          return { rows: [], rowCount: 1 };
        },
      },
      {
        match: (sql) => sql.includes('SELECT status, payee_type'),
        result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
      },
    ]),
    mapping: { application_user_id: USER_ID },
    body: {
      action: 'sign_in_person',
      endorsementId: ENDORSE_ID,
      signatureData: ink,
      eSignConsentAccepted: true,
    },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(signed.ok, true);
  assert.equal(stored, ink);
  assert.equal(signed.depositAdvanceDenied, true);
});

test('endorsed JPEG is created, original preserved, CheckAlt rearImage is those exact bytes', async () => {
  const original = syntheticCompliantCheckAltJpeg({ seed: 41, quality: 78 });
  const ink = makeInkSignatureDataUrl({ mark: 'JANE' });
  const store = createStore({
    payees: [{
      id: PAYEE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_type: 'insured',
      endorsement_status: 'signed',
      endorsed_at: '2026-09-15T00:00:00.000Z',
      endorsement_image_path: ink,
    }],
    endorsements: [{
      id: ENDORSE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_id: PAYEE_ID,
      payee_name: 'Jane Doe',
      payee_type: 'insured',
      status: 'signed',
      signed_at: '2026-09-15T00:00:00.000Z',
      signature_image_url: ink,
      signature_method: 'in_person',
    }],
  });
  store.files.set(ORIGINAL_BACK, original);

  const result = await compositeEndorsementSignatures({
    client: store.client,
    checkId: CHECK_ID,
    deps: {
      downloadClaimFile: async (rel) => store.files.get(rel),
      uploadClaimFile: async (rel, bytes) => {
        store.files.set(rel, Buffer.from(bytes));
        return { path: rel };
      },
      loadDeposits: async () => [],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.staging, false);
  assert.equal(result.output_format, 'rasterized_jpeg');
  assert.equal(result.original_back_image_path, ORIGINAL_BACK);
  assert.equal(store.state.check.back_image_path, ORIGINAL_BACK);
  assert.equal(store.state.check.back_image_original_path, ORIGINAL_BACK);
  assert.ok(String(store.state.check.back_image_deposit_path).endsWith('.checkalt.jpg'));
  assert.notEqual(store.state.check.back_image_deposit_path, ORIGINAL_BACK);
  assert.equal(store.state.check.endorsement_render_status, 'completed');
  assert.notEqual(store.state.check.endorsement_render_status, 'composited_staging');

  const endorsed = store.files.get(store.state.check.back_image_deposit_path);
  assert.ok(endorsed?.length);
  assert.notEqual(sha256(endorsed), sha256(original));
  assert.equal(result.sha256, sha256(endorsed));

  const officialRear = officialCheckAltRearPath(store.state.check);
  assert.equal(officialRear, store.state.check.back_image_deposit_path);
  const frontOfficialPath = FRONT.replace(/\.jpg$/i, '.checkalt.jpg');
  const paths = evaluateOfficialImagePaths({
    ...store.state.check,
    front_image_path: FRONT,
  });
  assert.equal(paths.rearPath, store.state.check.back_image_deposit_path);
  assert.equal(paths.frontPath, frontOfficialPath);

  const frontOfficial = syntheticCompliantCheckAltJpeg({ seed: 11, quality: 78 });
  store.files.set(frontOfficialPath, frontOfficial);
  const loaded = await loadProductionDepositImages({
    ...store.state.check,
    front_image_path: FRONT,
  }, {}, {
    downloadClaimFile: async (rel) => store.files.get(rel),
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.rearPath, store.state.check.back_image_deposit_path);
  assert.equal(sha256(endorsed), sha256(Buffer.from(loaded.rearImage, 'base64')));
  assert.equal(loaded.rearImage, bytesToBase64(endorsed));

  const processBody = buildDepositProcessBody({
    fiKey: 'fi',
    ssoKey: 'sso',
    depositAccountNumber: '123',
    captureDateTime: '2026-09-15T00:00:00.000Z',
    userAmount: 100,
    frontImage: loaded.frontImage,
    rearImage: loaded.rearImage,
  });
  assert.equal(processBody.rearImage, loaded.rearImage);
  assert.equal(sha256(Buffer.from(processBody.rearImage, 'base64')), sha256(endorsed));
});

test('second signer invalidates the prior official rear until regenerated', async () => {
  const store = createStore({
    check: {
      back_image_deposit_path: `checks/${CHECK_ID}/endorsed_deposit_old.checkalt.jpg`,
      endorsement_render_status: 'completed',
      endorsement_render_meta: { checkalt_rear_fingerprint: 'old' },
    },
  });
  const invalidated = await invalidateOfficialRearImage(store.client, CHECK_ID);
  assert.equal(invalidated.ok, true);
  assert.equal(store.state.check.back_image_deposit_path, null);
  assert.equal(store.state.check.endorsement_render_status, 'idle');
  assert.equal(store.state.check.endorsement_render_meta.checkalt_rear_fingerprint, undefined);
  assert.equal(store.state.check.back_image_path, ORIGINAL_BACK);

  const missing = evaluateOfficialImagePaths(store.state.check);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, ERROR_PROVIDER_REAR_IMAGE_MISSING);
});

test('missing endorsed rear is never replaced by the clean back', async () => {
  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    front_image_path: `${FRONT.replace(/\.jpg$/, '')}.checkalt.jpg`,
    back_image_path: ORIGINAL_BACK,
    back_image_original_path: ORIGINAL_BACK,
    back_image_deposit_path: null,
  };
  const images = evaluateOfficialImagePaths(check);
  assert.equal(images.ok, false);
  assert.equal(images.error, ERROR_PROVIDER_REAR_IMAGE_MISSING);
  assert.equal(officialCheckAltRearPath(check), null);

  const eligibility = evaluateProductionDepositEligibility({
    check,
    payees: [{
      id: PAYEE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_type: 'insured',
      endorsement_status: 'signed',
      endorsed_at: '2026-09-15T00:00:00.000Z',
    }],
    endorsements: [{
      id: ENDORSE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_id: PAYEE_ID,
      payee_type: 'insured',
      status: 'signed',
      signed_at: '2026-09-15T00:00:00.000Z',
    }],
  });
  assert.equal(eligibility.ok, false);
  assert.equal(eligibility.error, ERROR_PROVIDER_REAR_IMAGE_MISSING);
});

test('already deposited checks are not re-composited', async () => {
  const store = createStore({
    deposits: [{
      id: 'dep-1',
      tenant_id: TENANT,
      check_intake_item_id: CHECK_ID,
      checkalt_reference: '122678838',
      status: 'submitted',
    }],
    endorsements: [{
      id: ENDORSE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_id: PAYEE_ID,
      payee_name: 'Jane Doe',
      status: 'signed',
      signature_image_url: makeInkSignatureDataUrl(),
      signature_method: 'portal',
    }],
  });
  const result = await compositeEndorsementSignatures({
    client: store.client,
    checkId: CHECK_ID,
    deps: {
      downloadClaimFile: async () => {
        throw new Error('should not download historical deposit images');
      },
      loadDeposits: async () => store.state.deposits,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'historical_deposit_locked');
  assert.equal(result.historicalDepositUntouched, true);
  assert.equal(store.state.check.back_image_path, ORIGINAL_BACK);
  assert.equal(store.state.check.back_image_deposit_path, null);
});

test('signed-without-ink cannot be composited as a drawn endorsement', async () => {
  const store = createStore({
    endorsements: [{
      id: ENDORSE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_id: PAYEE_ID,
      payee_name: 'Jane Doe',
      payee_type: 'insured',
      status: 'signed',
      signature_image_url: null,
      signature_method: 'portal',
    }],
  });
  const result = await compositeEndorsementSignatures({
    client: store.client,
    checkId: CHECK_ID,
    deps: {
      downloadClaimFile: async () => syntheticCompliantCheckAltJpeg({ seed: 21, quality: 78 }),
      loadDeposits: async () => [],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'signature_image_missing');
});

test('two payees both appear on one endorsed JPEG after the second sign', async () => {
  const original = syntheticCompliantCheckAltJpeg({ seed: 61, quality: 78 });
  const jane = makeInkSignatureDataUrl({ mark: 'JANE' });
  const john = makeInkSignatureDataUrl({ mark: 'JOHN' });
  const store = createStore({
    payees: [
      {
        id: PAYEE_ID, check_id: CHECK_ID, tenant_id: TENANT, payee_type: 'insured',
        endorsement_status: 'signed', endorsed_at: '2026-09-15T00:00:00.000Z', endorsement_image_path: jane,
      },
      {
        id: PAYEE_ID_2, check_id: CHECK_ID, tenant_id: TENANT, payee_type: 'insured',
        endorsement_status: 'signed', endorsed_at: '2026-09-15T00:01:00.000Z', endorsement_image_path: john,
      },
    ],
    endorsements: [
      {
        id: ENDORSE_ID, check_id: CHECK_ID, tenant_id: TENANT, payee_id: PAYEE_ID,
        payee_name: 'Jane Doe', payee_type: 'insured', status: 'signed',
        signed_at: '2026-09-15T00:00:00.000Z', signature_image_url: jane, signature_method: 'portal',
      },
      {
        id: ENDORSE_ID_2, check_id: CHECK_ID, tenant_id: TENANT, payee_id: PAYEE_ID_2,
        payee_name: 'John Doe', payee_type: 'insured', status: 'signed',
        signed_at: '2026-09-15T00:01:00.000Z', signature_image_url: john, signature_method: 'in_person',
      },
    ],
  });
  const rendered = renderDepositJpeg(original, {
    override: { xPct: 0.38, yPct: 0.5, scale: 1, rotationDeg: 0, showPayToOrder: false },
    companyName: 'Freedom Adjustment',
    clientSignatures: [
      { payee_name: 'Jane Doe', signature_image_url: jane },
      { payee_name: 'John Doe', signature_image_url: john },
    ],
    companySignature: null,
  });
  assert.equal(rendered.ok, true);
  const blank = renderDepositJpeg(original, {
    override: { xPct: 0.38, yPct: 0.5, scale: 1, rotationDeg: 0, showPayToOrder: false },
    companyName: 'Freedom Adjustment',
    clientSignatures: [],
    companySignature: null,
  });
  assert.notEqual(rendered.sha256, blank.sha256);

  store.files.set(ORIGINAL_BACK, original);
  const result = await compositeEndorsementSignatures({
    client: store.client,
    checkId: CHECK_ID,
    deps: {
      downloadClaimFile: async (rel) => store.files.get(rel),
      uploadClaimFile: async (rel, bytes) => {
        store.files.set(rel, Buffer.from(bytes));
        return { path: rel };
      },
      loadDeposits: async () => [],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sha256(store.files.get(result.back_image_deposit_path)), rendered.sha256);
});

test('AWS composite handler is no longer a staging placeholder', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/documents.mjs'), 'utf8');
  assert.match(src, /compositeEndorsementSignatures/);
  assert.doesNotMatch(src, /composited_staging/);
  assert.doesNotMatch(src, /aws_staging_composite/);
  assert.equal(typeof handleCompositeEndorsementSignatures, 'function');
});

test('CheckAlt submit still rejects browser-supplied rearImage bytes', async () => {
  const submitSrc = fs.readFileSync(
    path.join(ROOT, 'aws/functions/api/providers/production/checkalt-submit.mjs'),
    'utf8',
  );
  assert.match(submitSrc, /untrusted_image_bytes/);
  assert.match(submitSrc, /loadProductionDepositImages/);
  assert.match(submitSrc, /evaluateProductionDepositEligibility/);
  const imagesSrc = fs.readFileSync(
    path.join(ROOT, 'aws/functions/api/providers/production/checkalt-images.mjs'),
    'utf8',
  );
  assert.match(imagesSrc, /resolveCheckAltArtifactPaths/);
  const complianceSrc = fs.readFileSync(
    path.join(ROOT, 'aws/functions/api/providers/production/checkalt-image-compliance.mjs'),
    'utf8',
  );
  assert.match(complianceSrc, /toCheckAltPath\(check\.back_image_deposit_path\)/);
});

test('afterGenuineEndorsementSigned invalidates then optionally composites', async () => {
  const store = createStore({
    check: {
      back_image_deposit_path: `checks/${CHECK_ID}/endorsed_deposit_old.checkalt.jpg`,
      endorsement_render_meta: { checkalt_rear_fingerprint: 'stale' },
    },
  });
  const out = await afterGenuineEndorsementSigned(store.client, CHECK_ID, { skipComposite: true });
  assert.equal(out.invalidated.ok, true);
  assert.equal(out.composited, null);
  assert.equal(store.state.check.back_image_deposit_path, null);
});
