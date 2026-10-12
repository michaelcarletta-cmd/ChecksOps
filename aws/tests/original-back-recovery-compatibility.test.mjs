import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compositeEndorsementSignatures,
  isCleanRasterOriginalPath,
  isEndorsedArtifactPath,
  makeInkSignatureDataUrl,
  recoverOriginalPath,
  recoverTrustedOriginalBackPath,
  reconstructSiblingCandidates,
} from '../functions/api/endorsement-composite.mjs';
import { applyAutoAdvanceIfEligible } from '../functions/api/check-endorsement.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { isCheckScopedPathFor } from '../functions/api/storage-paths.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = 'f618a3ea-e995-449f-b53f-329c81a6dcbc';
const OTHER_CHECK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOADER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const ENDORSE_ID = 'bd35fb4a-b89e-4b97-b93d-db7cfa20e18e';
const PAYEE_ID = 'cf98aa1b-6c7e-4ada-999d-fdfe515dcadd';
const USER_ID = '88888888-8888-4888-8888-888888888888';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';

const CLEAN_SCOPED = `checks/${CHECK_ID}/back-original.jpg`;
const CLEAN_LEGACY = `checks/${UPLOADER}/unclaimed/1786993369162_back_image_cropped.jpg`;
const DIRTY_SVG = `checks/${UPLOADER}/unclaimed/1786993369162_back_image_cropped_endorsed_1787324815745.svg`;
const FOREIGN_JPEG = `checks/${OTHER_CHECK}/unclaimed/other_back.jpg`;
const CHECKALT = `checks/${CHECK_ID}/endorsed_deposit_deadbeef.checkalt.jpg`;
const SIBLING_STEM = `checks/${CHECK_ID}/rear_scan`;
const SIBLING_SVG = `${SIBLING_STEM}_endorsed_99.svg`;
const SIBLING_JPG = `${SIBLING_STEM}.jpg`;
const SIBLING_JPEG = `${SIBLING_STEM}.jpeg`;
const SIBLING_PNG = `${SIBLING_STEM}.png`;

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const createStore = ({ check = {}, endorsements = [], payees = [], audits = [] } = {}) => {
  const files = new Map();
  const ink = makeInkSignatureDataUrl({ mark: 'BW' });
  const state = {
    check: {
      id: CHECK_ID,
      tenant_id: TENANT,
      status: 'endorsements_in_progress',
      check_stage: 'endorsing',
      deposited_at: null,
      back_image_path: CLEAN_SCOPED,
      back_image_original_path: CLEAN_SCOPED,
      back_image_deposit_path: null,
      endorsement_override: null,
      endorsement_render_meta: {},
      endorsement_render_status: 'idle',
      endorsement_render_version: 0,
      deposit_recommendation: 'endorsements_pending',
      ...check,
    },
    endorsements: (endorsements.length ? endorsements : [{
      id: ENDORSE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_id: PAYEE_ID,
      payee_name: 'Brenda Wilcox',
      payee_type: 'insured',
      status: 'signed',
      signed_at: '2026-09-22T22:23:04.988Z',
      signature_image_url: ink,
      signature_method: 'in_person',
    }]).map((row) => ({ ...row })),
    payees: (payees.length ? payees : [{
      id: PAYEE_ID,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_type: 'insured',
      endorsement_status: 'signed',
      endorsed_at: '2026-09-22T22:23:04.988Z',
      endorsement_image_path: ink,
    }]).map((row) => ({ ...row })),
    audits: audits.map((row) => ({ ...row })),
    files,
    updates: [],
  };
  const client = mockClient((sql, params) => {
    const compact = sql.replace(/\s+/g, ' ');
    if (compact.includes('FROM public.check_intake_items') && compact.includes('SELECT')) {
      return { rows: [state.check], rowCount: 1 };
    }
    if (compact.includes('FROM public.check_endorsements e')) {
      return { rows: state.endorsements, rowCount: state.endorsements.length };
    }
    if (compact.includes('FROM public.check_payees')) {
      return { rows: state.payees, rowCount: state.payees.length };
    }
    if (compact.includes('FROM public.checkalt_deposits')) {
      return { rows: [], rowCount: 0 };
    }
    if (compact.includes('FROM public.tenants')) {
      return { rows: [{ name: 'Freedom Adjustment' }], rowCount: 1 };
    }
    if (compact.includes('FROM public.check_audit_log')) {
      return { rows: state.audits, rowCount: state.audits.length };
    }
    if (compact.includes('UPDATE public.check_intake_items')) {
      state.updates.push({ sql: compact, params });
      if (compact.includes('back_image_deposit_path = $2')) {
        state.check.back_image_deposit_path = params[1];
        const replaceDirty = params[4] === true;
        if (replaceDirty || !state.check.back_image_original_path) {
          state.check.back_image_original_path = params[2];
        }
        state.check.endorsement_render_status = 'completed';
        state.check.endorsement_render_meta = {
          ...(state.check.endorsement_render_meta || {}),
          ...(typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3] || {}),
        };
      }
      if (compact.includes("SET status = 'approved_for_deposit'")) {
        state.check.status = 'approved_for_deposit';
        state.check.deposit_recommendation = 'ready_for_deposit';
        state.check.check_stage = 'ready_for_deposit';
      }
      return { rows: [state.check], rowCount: 1 };
    }
    if (compact.includes('INSERT INTO public.check_audit_log')) {
      return { rows: [], rowCount: 1 };
    }
    if (compact.includes('UPDATE public.claim_checks')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { state, client, files };
};

const existing = (paths) => {
  const set = new Set(paths);
  return async (rel) => set.has(rel);
};

test('1. modern clean original pointer continues to win', async () => {
  const recovered = await recoverTrustedOriginalBackPath({
    id: CHECK_ID,
    back_image_original_path: CLEAN_SCOPED,
    back_image_path: CLEAN_SCOPED,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.path, CLEAN_SCOPED);
  assert.equal(recovered.source, 'back_image_original_path');
  assert.equal(recoverOriginalPath({
    back_image_original_path: CLEAN_SCOPED,
    back_image_path: DIRTY_SVG,
  }), CLEAN_SCOPED);
});

test('2. Brenda-shaped legacy SVG pointers recover the audited clean JPEG', async () => {
  const recovered = await recoverTrustedOriginalBackPath({
    id: CHECK_ID,
    back_image_original_path: DIRTY_SVG,
    back_image_path: DIRTY_SVG,
    endorsement_render_meta: { reason: 'endorsement_state_changed' },
  }, {
    loadCompositeAudits: async () => [{
      event_data: {
        original_back_image_path: CLEAN_LEGACY,
        endorsed_back_image_path: DIRTY_SVG,
      },
    }],
    objectExists: existing([CLEAN_LEGACY]),
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.path, CLEAN_LEGACY);
  assert.equal(recovered.source, 'check_audit_log');
  assert.equal(isEndorsedArtifactPath(DIRTY_SVG), true);
  assert.equal(isCleanRasterOriginalPath(DIRTY_SVG), false);
  assert.equal(isCleanRasterOriginalPath(CLEAN_LEGACY), true);
});

test('3. deterministic sibling reconstruction selects the single clean raster', async () => {
  const recovered = await recoverTrustedOriginalBackPath({
    id: CHECK_ID,
    back_image_original_path: SIBLING_SVG,
    back_image_path: SIBLING_SVG,
  }, {
    loadCompositeAudits: async () => [],
    objectExists: existing([SIBLING_JPG]),
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.path, SIBLING_JPG);
  assert.equal(recovered.source, 'sibling');
  assert.deepEqual(reconstructSiblingCandidates(SIBLING_SVG), [
    SIBLING_JPG,
    SIBLING_JPEG,
    SIBLING_PNG,
  ]);
});

test('4. ambiguous siblings fail closed', async () => {
  const recovered = await recoverTrustedOriginalBackPath({
    id: CHECK_ID,
    back_image_original_path: SIBLING_SVG,
    back_image_path: SIBLING_SVG,
  }, {
    loadCompositeAudits: async () => [],
    objectExists: existing([SIBLING_JPG, SIBLING_PNG]),
  });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error, 'original_back_ambiguous');
  assert.equal(recovered.path, null);
});

test('5. missing original fails closed and never returns the SVG', async () => {
  const recovered = await recoverTrustedOriginalBackPath({
    id: CHECK_ID,
    back_image_original_path: DIRTY_SVG,
    back_image_path: DIRTY_SVG,
  }, {
    loadCompositeAudits: async () => [],
    objectExists: existing([]),
  });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error, 'original_back_missing');
  assert.equal(recovered.path, null);
  assert.equal(recoverOriginalPath({
    back_image_original_path: DIRTY_SVG,
    back_image_path: DIRTY_SVG,
  }), null);
});

test('6. CheckAlt artifact can never become a clean original', async () => {
  assert.equal(isEndorsedArtifactPath(CHECKALT), true);
  assert.equal(isCleanRasterOriginalPath(CHECKALT), false);
  const recovered = await recoverTrustedOriginalBackPath({
    id: CHECK_ID,
    back_image_original_path: CHECKALT,
    back_image_path: CHECKALT,
    endorsement_render_meta: { original_back_image_path: CHECKALT },
  }, {
    loadCompositeAudits: async () => [{
      event_data: { original_back_image_path: CHECKALT, endorsed_back_image_path: CHECKALT },
    }],
    objectExists: existing([CHECKALT]),
  });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.path, null);
});

test('7. generated SVG can never become a clean original', async () => {
  assert.equal(isEndorsedArtifactPath(DIRTY_SVG), true);
  assert.equal(isCleanRasterOriginalPath(DIRTY_SVG), false);
  assert.equal(recoverOriginalPath({
    back_image_original_path: DIRTY_SVG,
    back_image_path: DIRTY_SVG,
  }), null);
});

test('8. unrelated tenant/check object cannot be recovered merely because it exists', async () => {
  const recovered = await recoverTrustedOriginalBackPath({
    id: CHECK_ID,
    back_image_original_path: DIRTY_SVG,
    back_image_path: DIRTY_SVG,
    endorsement_render_meta: { original_back_image_path: FOREIGN_JPEG },
  }, {
    loadCompositeAudits: async () => [{
      event_data: {
        original_back_image_path: FOREIGN_JPEG,
        endorsed_back_image_path: DIRTY_SVG,
      },
    }],
    objectExists: existing([FOREIGN_JPEG]),
  });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.path, null);
  assert.equal(isCheckScopedPathFor(FOREIGN_JPEG, CHECK_ID), false);
  assert.equal(isCheckScopedPathFor(CLEAN_LEGACY, CHECK_ID), false);
});

test('9. already-valid official rear is not rewritten by recovery', async () => {
  const original = syntheticCompliantCheckAltJpeg({ seed: 41, quality: 78 });
  const store = createStore({
    check: {
      back_image_original_path: CLEAN_SCOPED,
      back_image_path: CLEAN_SCOPED,
      back_image_deposit_path: CHECKALT,
      endorsement_render_status: 'completed',
    },
  });
  store.files.set(CLEAN_SCOPED, original);
  store.files.set(CHECKALT, Buffer.from('existing-official-rear'));
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
      objectExists: existing([CLEAN_SCOPED]),
      stampFingerprint: false,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(store.state.check.back_image_original_path, CLEAN_SCOPED);
  assert.notEqual(store.state.check.back_image_deposit_path, CLEAN_SCOPED);
  assert.notEqual(store.state.check.back_image_deposit_path, CHECKALT);
  assert.match(store.state.check.back_image_deposit_path, /endorsed_deposit_[0-9a-f]+\.checkalt\.jpg$/);
  assert.ok(store.files.get(CHECKALT)?.equals(Buffer.from('existing-official-rear')));
});

test('10. officialRearReady remains mandatory for auto-advance', async () => {
  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    status: 'endorsements_in_progress',
    check_stage: 'endorsing',
    deposit_recommendation: 'endorsements_pending',
    deposited_at: null,
  };
  const evaluation = { allSigned: true, anyRejected: false };
  const client = mockClient((sql) => {
    if (String(sql).includes('FROM public.check_intake_items')) {
      return { rows: [check], rowCount: 1 };
    }
    throw new Error(`unexpected write: ${sql}`);
  });
  const prev = process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = 'true';
  try {
    const blocked = await applyAutoAdvanceIfEligible(client, CHECK_ID, evaluation, {
      officialRearReady: false,
    });
    assert.equal(blocked.advance_check_on_endorsement_complete, 'blocked_official_rear_missing');
    assert.equal(blocked.officialRearReady, false);
    assert.equal(blocked.depositAdvanceDenied, true);
  } finally {
    if (prev === undefined) delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
    else process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = prev;
  }
});

test('11. generic /data/write still rejects unauthorized cross-UUID assignment', async () => {
  assert.equal(isCheckScopedPathFor(CLEAN_LEGACY, CHECK_ID), false);
  const mapping = {
    application_user_id: USER_ID,
    cognito_sub: COGNITO_SUB,
    email: 'checksops-tester@freedomadj.com',
    status: 'active',
  };
  const queries = [];
  const client = {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (String(sql).startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) return { rows: [mapping] };
      if (/SELECT id, tenant_id FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: CHECK_ID, tenant_id: TENANT }] };
      }
      if (String(sql).startsWith('UPDATE public.check_intake_items')) {
        throw new Error('generic write must not reach UPDATE for cross-UUID original');
      }
      return { rows: [] };
    },
  };
  const result = await handleWrite({
    rawPath: '/data/write',
    headers: { authorization: 'Bearer test-id-token' },
    body: JSON.stringify({
      table: 'check_intake_items',
      op: 'update',
      values: { back_image_original_path: CLEAN_LEGACY },
      filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
      single: true,
    }),
    requestContext: {
      stage: 'staging',
      http: { method: 'POST', path: '/data/write' },
      authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
    },
  }, {
    forceEnabled: true,
    loadDatabaseCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => client,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rls_denied');
  assert.match(String(result.message || ''), /not scoped to this check/);
  assert.equal(queries.some((row) => String(row.sql).startsWith('UPDATE public.check_intake_items')), false);
});

test('Brenda-shaped composite uses the clean JPEG and writes only the official rear', async () => {
  const original = syntheticCompliantCheckAltJpeg({ seed: 17, quality: 78 });
  const store = createStore({
    check: {
      back_image_original_path: DIRTY_SVG,
      back_image_path: DIRTY_SVG,
      back_image_deposit_path: null,
      endorsement_render_meta: { reason: 'endorsement_state_changed' },
    },
    audits: [{
      event_data: {
        original_back_image_path: CLEAN_LEGACY,
        endorsed_back_image_path: DIRTY_SVG,
      },
    }],
  });
  store.files.set(CLEAN_LEGACY, original);
  store.files.set(DIRTY_SVG, Buffer.from('<svg></svg>'));
  const downloaded = [];
  const result = await compositeEndorsementSignatures({
    client: store.client,
    checkId: CHECK_ID,
    deps: {
      downloadClaimFile: async (rel) => {
        downloaded.push(rel);
        return store.files.get(rel);
      },
      uploadClaimFile: async (rel, bytes) => {
        store.files.set(rel, Buffer.from(bytes));
        return { path: rel };
      },
      loadDeposits: async () => [],
      objectExists: existing([CLEAN_LEGACY]),
      stampFingerprint: false,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.original_back_image_path, CLEAN_LEGACY);
  assert.equal(store.state.check.back_image_original_path, CLEAN_LEGACY);
  assert.equal(store.state.check.back_image_path, DIRTY_SVG);
  assert.match(store.state.check.back_image_deposit_path, /endorsed_deposit_[0-9a-f]+\.checkalt\.jpg$/);
  assert.ok(downloaded.includes(CLEAN_LEGACY));
  assert.equal(downloaded.includes(DIRTY_SVG), false);
  assert.equal(store.files.get(DIRTY_SVG).toString(), '<svg></svg>');
  assert.ok(store.files.get(CLEAN_LEGACY).equals(original));
});
