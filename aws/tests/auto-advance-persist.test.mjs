import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyAutoAdvanceIfEligible,
  classifyPersistFailure,
  persistAutoAdvanceWrite,
  runAuthenticatedEndorsement,
} from '../functions/api/check-endorsement.mjs';
import { commitWriteTransaction } from '../functions/api/data.mjs';
import { endorsementStateFingerprint } from '../functions/api/providers/production/checkalt-eligibility.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = 'b74c0a7d-dbcd-4f4b-8692-151aa5aea176';
const ACTOR = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const SOURCE = readFileSync(new URL('../functions/api/check-endorsement.mjs', import.meta.url), 'utf8');
const DATA_SOURCE = readFileSync(new URL('../functions/api/data.mjs', import.meta.url), 'utf8');

const readyCheck = (extra = {}) => ({
  id: CHECK_ID,
  tenant_id: TENANT,
  status: 'endorsements_in_progress',
  check_stage: 'endorsing',
  deposit_recommendation: null,
  deposited_at: extra.deposited_at || null,
  ...extra,
});

const withAdvance = async (fn) => {
  const previous = process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = 'true';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
    else process.env.AWS_ENDORSEMENT_AUTO_ADVANCE = previous;
  }
};

const persistError = (sqlMatch, { code = '42501', message, table, column } = {}) => {
  const error = new Error(message || 'permission denied for column deposit_recommendation');
  error.code = code;
  error.table = table || 'check_intake_items';
  error.column = column || 'deposit_recommendation';
  return error;
};

test('persist-critical auto-advance writes do not use safeQuery', () => {
  const persistBlock = SOURCE.slice(
    SOURCE.indexOf('export const applyAutoAdvanceIfEligible'),
    SOURCE.indexOf('const officialRearObjectExists'),
  );
  assert.match(persistBlock, /persistAutoAdvanceWrite/);
  assert.equal(persistBlock.includes('await safeQuery('), false);
  assert.match(DATA_SOURCE, /commitWriteTransaction/);
  assert.match(DATA_SOURCE, /transaction_not_committed/);
});

test('persistAutoAdvanceWrite does not swallow PostgreSQL errors', async () => {
  const client = {
    query: async () => {
      throw persistError('UPDATE');
    },
  };
  await assert.rejects(
    () => persistAutoAdvanceWrite(client, 'UPDATE public.check_intake_items SET status = $1', ['approved_for_deposit'], {
      statement: 'UPDATE check_intake_items',
      table: 'check_intake_items',
    }),
    (error) => {
      assert.equal(error.persistError.code, '42501');
      assert.equal(error.persistError.table, 'check_intake_items');
      assert.equal(error.persistError.column, 'deposit_recommendation');
      assert.equal(error.persistError.statement, 'UPDATE check_intake_items');
      assert.equal(error.persistError.transactionState, 'aborted');
      return true;
    },
  );
});

test('aborted COMMIT command cannot be treated as success', async () => {
  const client = {
    query: async (sql) => {
      if (sql === 'COMMIT') return { command: 'ROLLBACK', rows: [] };
      return { command: 'SELECT', rows: [{ txn_alive: 1 }] };
    },
  };
  await assert.rejects(() => commitWriteTransaction(client), /transaction_not_committed/);
});

test('successful COMMIT is accepted when driver tag is COMMIT', async () => {
  const client = {
    query: async (sql) => {
      if (sql === 'COMMIT') return { command: 'COMMIT', rows: [] };
      return { rows: [] };
    },
  };
  const committed = await commitWriteTransaction(client);
  assert.equal(committed.command, 'COMMIT');
});

test('persistence error cannot return advance applied', async () => {
  const statements = [];
  const client = {
    query: async (sql) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      statements.push(compact);
      if (/FROM public.check_intake_items/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [readyCheck()], rowCount: 1 };
      }
      if (/UPDATE public.check_intake_items/.test(compact)) {
        throw persistError(compact);
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: true,
    anyRejected: false,
  }, { officialRearReady: true }));
  assert.equal(result.ok, false);
  assert.equal(result.success, false);
  assert.notEqual(result.advance_check_on_endorsement_complete, 'applied');
  assert.equal(result.advance_check_on_endorsement_complete, 'persist_failed');
  assert.equal(result.error, 'auto_advance_persist_failed');
  assert.equal(result.persistError.code, '42501');
  assert.equal(result.persistError.statement, 'UPDATE check_intake_items');
  assert.equal(result.newStatus, 'endorsements_in_progress');
  assert.equal(statements.some((sql) => /INSERT INTO public.check_audit_log/.test(sql)), false);
});

test('successful persist writes status stage recommendation and audit', async () => {
  const captured = [];
  const check = readyCheck();
  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      captured.push({ sql: compact, params });
      if (/FROM public.check_intake_items/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [check], rowCount: 1 };
      }
      if (/UPDATE public.check_intake_items/.test(compact)) {
        check.status = 'approved_for_deposit';
        check.check_stage = 'ready_for_deposit';
        check.deposit_recommendation = 'ready_for_deposit';
        return { rows: [check], rowCount: 1 };
      }
      if (/FROM public.claim_checks/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE public.claim_checks/.test(compact)) {
        throw new Error('claim_checks UPDATE must be skipped when no linked row exists');
      }
      if (/INSERT INTO public.check_audit_log/.test(compact)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: true,
    anyRejected: false,
  }, { officialRearReady: true }));
  assert.equal(result.advance_check_on_endorsement_complete, 'applied');
  assert.equal(check.status, 'approved_for_deposit');
  assert.equal(check.check_stage, 'ready_for_deposit');
  assert.equal(check.deposit_recommendation, 'ready_for_deposit');
  assert.equal(captured.some((row) => /INSERT INTO public.check_audit_log/.test(row.sql)), true);
  assert.equal(captured.some((row) => /UPDATE public.claim_checks/.test(row.sql)), false);
});

test('missing optional claim_checks row does not abort intake persist', async () => {
  const check = readyCheck();
  const client = {
    query: async (sql) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (/FROM public.check_intake_items/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [check], rowCount: 1 };
      }
      if (/UPDATE public.check_intake_items/.test(compact)) {
        check.status = 'approved_for_deposit';
        check.check_stage = 'ready_for_deposit';
        check.deposit_recommendation = 'ready_for_deposit';
        return { rows: [check], rowCount: 1 };
      }
      if (/FROM public.claim_checks/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE public.claim_checks/.test(compact)) {
        throw new Error('claim_checks UPDATE must be skipped when no linked row exists');
      }
      if (/INSERT INTO public.check_audit_log/.test(compact)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: true,
    anyRejected: false,
  }, { officialRearReady: true }));
  assert.equal(result.advance_check_on_endorsement_complete, 'applied');
  assert.equal(check.status, 'approved_for_deposit');
});

test('failure rolls back later persist statements', async () => {
  const captured = [];
  const client = {
    query: async (sql) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      captured.push(compact);
      if (/FROM public.check_intake_items/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [readyCheck()], rowCount: 1 };
      }
      if (/UPDATE public.check_intake_items/.test(compact)) {
        return { rows: [], rowCount: 1 };
      }
      if (/FROM public.claim_checks/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [{ id: 'claim-check-1' }], rowCount: 1 };
      }
      if (/UPDATE public.claim_checks/.test(compact)) {
        const error = new Error('permission denied for table claim_checks');
        error.code = '42501';
        error.table = 'claim_checks';
        throw error;
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: true,
    anyRejected: false,
  }, { officialRearReady: true }));
  assert.equal(result.advance_check_on_endorsement_complete, 'persist_failed');
  assert.equal(result.persistError.table, 'claim_checks');
  assert.equal(captured.some((sql) => /INSERT INTO public.check_audit_log/.test(sql)), false);
});

test('incomplete endorsements remain blocked', async () => {
  const client = {
    query: async (sql) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (/FROM public.check_intake_items/.test(compact)) {
        return { rows: [readyCheck()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: false,
    anyRejected: false,
  }, { officialRearReady: true }));
  assert.notEqual(result.advance_check_on_endorsement_complete, 'applied');
});

test('missing official rear remains blocked', async () => {
  const client = {
    query: async () => ({ rows: [readyCheck()], rowCount: 1 }),
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: true,
    anyRejected: false,
  }, { officialRearReady: false }));
  assert.equal(result.advance_check_on_endorsement_complete, 'blocked_official_rear_missing');
});

test('terminal deposited check does not regress', async () => {
  const client = {
    query: async () => ({ rows: [readyCheck({ status: 'deposited', deposited_at: '2026-09-01T00:00:00Z' })], rowCount: 1 }),
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: true,
    anyRejected: false,
  }, { officialRearReady: true }));
  assert.equal(result.advance_check_on_endorsement_complete, 'skipped_ineligible');
  assert.equal(result.newStatus, 'deposited');
});

test('already-ready retry is idempotent', async () => {
  const client = {
    query: async (sql) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (/FROM public.check_intake_items/.test(compact)) {
        return {
          rows: [readyCheck({
            status: 'approved_for_deposit',
            check_stage: 'ready_for_deposit',
            deposit_recommendation: 'ready_for_deposit',
          })],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected write ${compact}`);
    },
  };
  const result = await withAdvance(() => applyAutoAdvanceIfEligible(client, CHECK_ID, {
    allSigned: true,
    anyRejected: false,
  }, { officialRearReady: true }));
  assert.equal(result.advance_check_on_endorsement_complete, 'already_ready');
});

test('finalize_existing_endorsements persist failure is not false success and mutates no endorsements', async () => {
  const endorsements = [{ id: 'e1', status: 'signed', payee_type: 'insured', signed_at: '2026-09-28T17:15:17.435Z' }];
  const payees = [{ id: 'p1', payee_type: 'insured', endorsement_status: 'signed' }];
  const check = readyCheck({
    back_image_path: `checks/${CHECK_ID}/rear.jpg`,
    back_image_original_path: `checks/${CHECK_ID}/rear.jpg`,
    back_image_deposit_path: `checks/${CHECK_ID}/endorsed_deposit_b0b24ad7.checkalt.jpg`,
    endorsement_render_meta: {
      checkalt_rear_fingerprint: endorsementStateFingerprint(CHECK_ID, payees, endorsements),
    },
  });
  const client = {
    query: async (sql) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (/aws_can_write_tenant/.test(compact)) return { rows: [{ ok: true }], rowCount: 1 };
      if (/FROM public.check_intake_items/.test(compact) && !/UPDATE/.test(compact)) {
        return { rows: [check], rowCount: 1 };
      }
      if (/FROM public.check_endorsements/.test(compact)) return { rows: endorsements, rowCount: 1 };
      if (/FROM public.check_payees/.test(compact)) return { rows: payees, rowCount: 1 };
      if (/UPDATE public.check_intake_items/.test(compact)) {
        throw persistError(compact);
      }
      if (/UPDATE public.check_endorsements/.test(compact)) {
        throw new Error('endorsement mutation is forbidden in this test');
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await withAdvance(() => runAuthenticatedEndorsement({
    client,
    mapping: { application_user_id: ACTOR },
    body: { action: 'finalize_existing_endorsements', checkId: CHECK_ID },
    spoof: { ignored: true },
    event: { headers: {} },
    compositeDeps: {
      objectExists: async () => true,
      downloadClaimFile: async () => Buffer.from('jpeg'),
      loadCheckPayees: async () => payees,
      loadCheckEndorsements: async () => endorsements,
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.success, false);
  assert.notEqual(result.advance_check_on_endorsement_complete, 'applied');
  assert.equal(result.endorsementRowsMutated, false);
  assert.equal(result.providerSubmitted, false);
});

test('classifyPersistFailure redacts credentials and keeps sqlstate', () => {
  const error = new Error('password=supersecret permission denied');
  error.code = '42501';
  error.table = 'check_intake_items';
  error.column = 'deposit_recommendation';
  const classified = classifyPersistFailure(error, {
    statement: 'UPDATE check_intake_items',
    table: 'check_intake_items',
  });
  assert.equal(classified.code, '42501');
  assert.match(classified.message, /redacted|permission denied/i);
  assert.equal(classified.message.includes('supersecret'), false);
});
