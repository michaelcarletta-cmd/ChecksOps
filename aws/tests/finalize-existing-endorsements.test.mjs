import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AUTH_ENDORSEMENT_ACTIONS,
  applyAutoAdvanceIfEligible,
  finalizeEndorsementState,
  reuseExistingOfficialRear,
  runAuthenticatedEndorsement,
} from '../functions/api/check-endorsement.mjs';
import { endorsementStateFingerprint } from '../functions/api/providers/production/checkalt-eligibility.mjs';
import { isCheckAltArtifactPath } from '../functions/api/providers/production/checkalt-image-compliance.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAYEE_INSURED = '2458e6b8-3da4-4483-998e-cc66bc7ed64b';
const PAYEE_PA = 'cf98aa1b-6c7e-4ada-999d-fdfe515dcadd';
const ENDO_INSURED = '76af9561-c1fa-41ec-8eec-7b294d8af265';
const ENDO_PA = 'bd35fb4a-b89e-4b97-b93d-db7cfa20e18e';
const ACTOR = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const ORIGINAL = `checks/${CHECK_ID}/1786993369162_back_image_cropped.jpg`;
const DIRTY_SVG = `checks/${CHECK_ID}/1786993369162_back_image_cropped_endorsed_1787324815745.svg`;
const DEPOSIT = `checks/${CHECK_ID}/endorsed_deposit_8f0a1f22.checkalt.jpg`;

const SOURCE = readFileSync(new URL('../functions/api/check-endorsement.mjs', import.meta.url), 'utf8');

const brendaPayees = (overrides = {}) => ([
  {
    id: PAYEE_INSURED,
    check_id: CHECK_ID,
    tenant_id: TENANT,
    payee_type: 'insured',
    endorsement_status: 'pending',
    endorsed_at: null,
    ...overrides.insured,
  },
  {
    id: PAYEE_PA,
    check_id: CHECK_ID,
    tenant_id: TENANT,
    payee_type: 'public_adjuster',
    endorsement_status: 'signed',
    endorsed_at: '2026-08-21T15:06:52.486Z',
    ...overrides.pa,
  },
]);

const brendaEndorsements = (overrides = {}) => ([
  {
    id: ENDO_PA,
    check_id: CHECK_ID,
    tenant_id: TENANT,
    payee_id: PAYEE_PA,
    payee_type: 'public_adjuster',
    status: 'signed',
    signed_at: '2026-08-21T15:06:52.486Z',
    signature_method: 'portal',
    ...overrides.pa,
  },
  {
    id: ENDO_INSURED,
    check_id: CHECK_ID,
    tenant_id: TENANT,
    payee_id: PAYEE_INSURED,
    payee_type: 'insured',
    status: 'signed',
    signed_at: '2026-09-22T22:23:04.988Z',
    signature_method: 'in_person',
    ...overrides.insured,
  },
]);

const fingerprintFor = (payees, endorsements) =>
  endorsementStateFingerprint(CHECK_ID, payees, endorsements);

const brendaCheck = (extra = {}) => {
  const payees = extra.payees || brendaPayees();
  const endorsements = extra.endorsements || brendaEndorsements();
  return {
    id: CHECK_ID,
    tenant_id: TENANT,
    status: 'endorsements_in_progress',
    check_stage: 'endorsing',
    deposit_recommendation: 'endorsements_pending',
    deposited_at: null,
    back_image_path: DIRTY_SVG,
    back_image_original_path: ORIGINAL,
    back_image_deposit_path: DEPOSIT,
    endorsement_render_meta: {
      checkalt_rear_fingerprint: fingerprintFor(payees, endorsements),
      original_back_image_path: ORIGINAL,
      endorsed_back_image_path: DEPOSIT,
    },
    ...extra.check,
  };
};

const createStore = ({
  check,
  endorsements = brendaEndorsements(),
  payees = brendaPayees(),
  canWrite = true,
  files = new Set([ORIGINAL, DEPOSIT]),
} = {}) => {
  const state = {
    check: brendaCheck({ check, payees, endorsements }),
    endorsements: endorsements.map((row) => ({ ...row })),
    payees: payees.map((row) => ({ ...row })),
    audits: [],
    endorsementSql: [],
    payeeSql: [],
    checkSql: [],
    compositeCalls: 0,
    uploads: [],
    providerCalls: [],
  };
  const endorsementSnapshot = () => JSON.parse(JSON.stringify(state.endorsements));
  const payeeSnapshot = () => JSON.parse(JSON.stringify(state.payees));
  state.beforeEndorsements = endorsementSnapshot();
  state.beforePayees = payeeSnapshot();

  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (/aws_can_write_tenant/.test(compact)) {
        return { rows: [{ ok: canWrite }], rowCount: 1 };
      }
      if (/FROM public.check_intake_items/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [state.check], rowCount: 1 };
      }
      if (/FROM public.check_payees/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: state.payees, rowCount: state.payees.length };
      }
      if (/FROM public.check_endorsements/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: state.endorsements, rowCount: state.endorsements.length };
      }
      if (/UPDATE public.check_endorsements/.test(compact)) {
        state.endorsementSql.push(compact);
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE public.check_payees/.test(compact)) {
        state.payeeSql.push(compact);
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE public.check_intake_items/.test(compact)) {
        state.checkSql.push(compact);
        if (/status = 'approved_for_deposit'/.test(compact)) {
          state.check.status = 'approved_for_deposit';
          state.check.deposit_recommendation = 'ready_for_deposit';
          state.check.check_stage = 'ready_for_deposit';
        }
        if (/check_stage = 'ready_for_deposit'/.test(compact) && state.check.status === 'approved_for_deposit') {
          state.check.check_stage = 'ready_for_deposit';
        }
        return { rows: [state.check], rowCount: 1 };
      }
      if (/INSERT INTO public.check_audit_log/.test(compact)) {
        state.audits.push({ sql: compact, params });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO public.endorsement_audit_log/.test(compact)) {
        state.audits.push({ sql: compact, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const deps = {
    objectExists: async (rel) => files.has(rel),
    downloadClaimFile: async (rel) => {
      if (!files.has(rel)) throw new Error('missing');
      return Buffer.from('jpeg');
    },
    uploadClaimFile: async (rel, bytes) => {
      state.uploads.push(rel);
      files.add(rel);
      return { path: rel, bytes };
    },
    loadDeposits: async () => {
      state.providerCalls.push('loadDeposits');
      return [];
    },
  };

  return { state, client, deps, files, endorsementSnapshot, payeeSnapshot };
};

const runFinalize = async (store, body = { action: 'finalize_existing_endorsements', checkId: CHECK_ID }) => {
  const previous = process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = 'true';
  try {
    return await runAuthenticatedEndorsement({
      client: store.client,
      mapping: { application_user_id: ACTOR },
      body,
      spoof: { ignored: true },
      event: { headers: {} },
      compositeDeps: store.deps,
    });
  } finally {
    if (previous === undefined) delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
    else process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = previous;
  }
};

test('finalize_existing_endorsements is an authenticated action', () => {
  assert.equal(AUTH_ENDORSEMENT_ACTIONS.has('finalize_existing_endorsements'), true);
});

test('completed endorsements + valid official rear finalizes without regenerating', async () => {
  const store = createStore();
  const result = await runFinalize(store);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'finalize_existing_endorsements');
  assert.equal(result.allSigned, true);
  assert.equal(result.officialRearReady, true);
  assert.equal(result.advance_check_on_endorsement_complete, 'applied');
  assert.equal(result.readyForDeposit, true);
  assert.equal(result.newStatus, 'approved_for_deposit');
  assert.equal(result.composited?.reused, true);
  assert.equal(result.composited?.back_image_deposit_path, DEPOSIT);
  assert.equal(store.state.check.status, result.newStatus);
  assert.equal(store.state.check.check_stage, 'ready_for_deposit');
  assert.equal(store.state.check.deposit_recommendation, 'ready_for_deposit');
  assert.equal(store.state.check.back_image_deposit_path, DEPOSIT);
  assert.equal(store.state.uploads.length, 0);
  assert.deepEqual(store.endorsementSnapshot(), store.state.beforeEndorsements);
  assert.deepEqual(store.payeeSnapshot(), store.state.beforePayees);
  assert.equal(store.state.endorsementSql.length, 0);
  assert.equal(store.state.payeeSql.length, 0);
  assert.equal(store.state.audits.some((row) => row.sql.includes('all_endorsements_complete')), true);
  assert.equal(result.providerSubmitted, false);
  assert.equal(result.paymentDirectionTriggered, false);
});

test('incomplete endorsement refuses advancement', async () => {
  const endorsements = brendaEndorsements({ insured: { status: 'pending', signed_at: null } });
  const store = createStore({ endorsements, check: { endorsement_render_meta: {} } });
  const result = await runFinalize(store);
  assert.equal(result.ok, true);
  assert.equal(result.allSigned, false);
  assert.equal(result.officialRearReady, false);
  assert.notEqual(result.advance_check_on_endorsement_complete, 'applied');
  assert.equal(store.state.check.status, 'endorsements_in_progress');
  assert.equal(store.state.check.deposit_recommendation, 'endorsements_pending');
  assert.equal(store.state.uploads.length, 0);
  assert.deepEqual(store.endorsementSnapshot(), store.state.beforeEndorsements);
});

test('missing official rear and unrecoverable original refuses advancement', async () => {
  const store = createStore({
    check: {
      back_image_deposit_path: null,
      back_image_original_path: DIRTY_SVG,
      back_image_path: DIRTY_SVG,
      endorsement_render_meta: {},
    },
    files: new Set([DIRTY_SVG]),
  });
  const result = await runFinalize(store);
  assert.equal(result.officialRearReady, false);
  assert.equal(result.advance_check_on_endorsement_complete, 'blocked_official_rear_missing');
  assert.equal(store.state.check.status, 'endorsements_in_progress');
  assert.equal(store.state.uploads.length, 0);
});

test('generated artifact masquerading as original remains fail-closed', async () => {
  const store = createStore({
    check: {
      back_image_deposit_path: null,
      back_image_original_path: DIRTY_SVG,
      back_image_path: DIRTY_SVG,
      endorsement_render_meta: { original_back_image_path: DIRTY_SVG },
    },
    files: new Set([DIRTY_SVG]),
  });
  const result = await runFinalize(store);
  assert.equal(result.officialRearReady, false);
  assert.equal(result.composited?.error, 'original_back_missing');
  assert.equal(store.state.check.status, 'endorsements_in_progress');
});

test('already-ready check is idempotent and does not regress', async () => {
  const store = createStore({
    check: {
      status: 'approved_for_deposit',
      check_stage: 'ready_for_deposit',
      deposit_recommendation: 'ready_for_deposit',
    },
  });
  const result = await runFinalize(store);
  assert.equal(result.ok, true);
  assert.equal(result.officialRearReady, true);
  assert.equal(result.advance_check_on_endorsement_complete, 'already_ready');
  assert.equal(store.state.check.status, 'approved_for_deposit');
  assert.equal(store.state.check.check_stage, 'ready_for_deposit');
  assert.equal(store.state.check.deposit_recommendation, 'ready_for_deposit');
  assert.equal(store.state.uploads.length, 0);
  assert.deepEqual(store.endorsementSnapshot(), store.state.beforeEndorsements);
});

test('deposited/terminal check is not moved backward', async () => {
  const store = createStore({
    check: {
      status: 'deposited',
      check_stage: 'deposited',
      deposited_at: '2026-09-01T00:00:00.000Z',
    },
  });
  const result = await runFinalize(store);
  assert.equal(result.advance_check_on_endorsement_complete, 'skipped_ineligible');
  assert.equal(result.newStatus, 'deposited');
  assert.equal(store.state.check.status, 'deposited');
  assert.equal(store.state.check.deposited_at, '2026-09-01T00:00:00.000Z');
  assert.equal(store.state.uploads.length, 0);
});

test('wrong tenant write is denied', async () => {
  const store = createStore({ canWrite: false });
  const result = await runFinalize(store);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'forbidden');
  assert.equal(store.state.check.status, 'endorsements_in_progress');
  assert.deepEqual(store.endorsementSnapshot(), store.state.beforeEndorsements);
});

test('missing checkId is a safe failure', async () => {
  const store = createStore();
  const result = await runFinalize(store, { action: 'finalize_existing_endorsements' });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'checkId required');
});

test('stale/missing check is a safe failure', async () => {
  const store = createStore();
  store.state.check = null;
  const result = await runFinalize(store);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'Check not found');
});

test('reuseExistingOfficialRear rejects a generated artifact as official rear', async () => {
  const check = brendaCheck({
    check: { back_image_deposit_path: DIRTY_SVG },
  });
  const result = await reuseExistingOfficialRear(null, check, {
    objectExists: async () => true,
    loadCheckPayees: async () => brendaPayees(),
    loadCheckEndorsements: async () => brendaEndorsements(),
  });
  assert.equal(result.ok, false);
  assert.equal(isCheckAltArtifactPath(DIRTY_SVG), false);
});

test('stale official-rear fingerprint is not reused', async () => {
  const store = createStore({
    check: {
      endorsement_render_meta: { checkalt_rear_fingerprint: 'deadbeef' },
    },
  });
  const existing = await reuseExistingOfficialRear(store.client, store.state.check, store.deps);
  assert.equal(existing.ok, false);
  assert.equal(existing.error, 'provider_rear_image_stale');
});

test('blocked_official_rear_missing remains mandatory', async () => {
  const previous = process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = 'true';
  try {
    const blocked = await applyAutoAdvanceIfEligible({
      query: async (sql) => {
        if (String(sql).includes('FROM public.check_intake_items')) {
          return { rows: [brendaCheck({ check: { back_image_deposit_path: null } })] };
        }
        throw new Error(`unexpected write: ${sql}`);
      },
    }, CHECK_ID, { allSigned: true, anyRejected: false }, { officialRearReady: false });
    assert.equal(blocked.advance_check_on_endorsement_complete, 'blocked_official_rear_missing');
  } finally {
    if (previous === undefined) delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
    else process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = previous;
  }
});

test('operation cannot initiate CheckAlt/Moov/provider submission', () => {
  const actionBlock = SOURCE.slice(
    SOURCE.indexOf("action === 'finalize_existing_endorsements'"),
    SOURCE.indexOf("action === 'force_complete_endorsements'"),
  );
  assert.match(actionBlock, /finalizeEndorsementState/);
  assert.doesNotMatch(actionBlock, /checkalt-submit-deposit|checkalt_submit_deposit|submitCheckAlt|moov|payout|disburse/i);
  assert.match(SOURCE, /providerSubmitted: false/);
  assert.equal(SOURCE.includes("action === 'finalize_existing_endorsements'"), true);
});

test('stale payee endorsement_status is not synchronized', async () => {
  const store = createStore();
  assert.equal(store.state.payees[0].endorsement_status, 'pending');
  const result = await runFinalize(store);
  assert.equal(result.ok, true);
  assert.equal(store.state.payees[0].endorsement_status, 'pending');
  assert.equal(store.state.payeeSql.length, 0);
  assert.doesNotMatch(SOURCE.slice(
    SOURCE.indexOf("action === 'finalize_existing_endorsements'"),
    SOURCE.indexOf("action === 'force_complete_endorsements'"),
  ), /check_payees/);
});

test('finalizeEndorsementState reuses current rear instead of compositing', async () => {
  const store = createStore();
  let compositeCalls = 0;
  const previous = process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = 'true';
  try {
    const result = await finalizeEndorsementState(store.client, CHECK_ID, {
      refreshOfficialRear: false,
      compositeDeps: {
        ...store.deps,
        uploadClaimFile: async (rel) => {
          compositeCalls += 1;
          return { path: rel };
        },
      },
    });
    assert.equal(result.officialRearReady, true);
    assert.equal(result.composited?.reused, true);
    assert.equal(compositeCalls, 0);
    assert.equal(store.state.check.status, 'approved_for_deposit');
  } finally {
    if (previous === undefined) delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
    else process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = previous;
  }
});
