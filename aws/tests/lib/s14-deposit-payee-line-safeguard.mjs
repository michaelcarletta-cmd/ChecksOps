/**
 * Shared S14 Deposit Payee Line Protection safeguard helpers.
 * Behavioral assertions plus local-copy mutation probes.
 * Does not call AWS, mutate production, or pin a Lambda SHA.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONFIRMED_MONEY_STATUSES,
  MONEY_IN_OPERATION_TYPES,
} from '../../functions/api/financial-remaining.mjs';

export const S14_LABEL = 'S14 Deposit Payee Line Protection';
export const ACCEPTED_MONEY_IN_TYPES = Object.freeze(['checkalt_deposit']);
export const ACCEPTED_CONFIRMED_STATUSES = Object.freeze(['provider_confirmed', 'settled']);

export const S14_RUNTIME_FILES = Object.freeze([
  'aws/functions/api/check-deposited.mjs',
  'aws/functions/api/write-check-workflow.mjs',
  'aws/functions/api/ocr.mjs',
  'aws/functions/api/ocr-descriptive-persist.mjs',
  'aws/functions/api/ingest-shared-check.mjs',
]);

export const S14_EXISTING_CHECK_WRITERS = Object.freeze([
  {
    file: 'aws/functions/api/write-check-workflow.mjs',
    helper: 'rejectPayeeLineIfDeposited',
    markers: ['executeIntakeUpdate', 'executeClaimChecks'],
  },
  {
    file: 'aws/functions/api/ocr.mjs',
    helper: 'resolveWritablePayeeLine',
    markers: ['payee_line = COALESCE($4, payee_line)'],
  },
  {
    file: 'aws/functions/api/ocr-descriptive-persist.mjs',
    helper: 'resolveWritablePayeeLine',
    markers: ['persistOcrDescriptiveHandoff'],
  },
  {
    file: 'aws/functions/api/ingest-shared-check.mjs',
    helper: 'rejectPayeeLineIfDeposited',
    markers: ['guardIngestPlanPayeeLine', 'persistIngestInline'],
  },
]);

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export const s14Assert = (condition, message) => {
  if (!condition) {
    const error = new Error(`${S14_LABEL}: ${message}`);
    error.s14 = true;
    throw error;
  }
};

export const readRepo = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

export const depositClient = ({
  deposited_at = null,
  payee_line = 'Original Payee Line',
  confirmedDeposit = false,
  throwOn = null,
  missing = false,
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (throwOn && String(sql).includes(throwOn)) throw new Error('synthetic lookup failure');
      if (/^SAVEPOINT /i.test(sql) || /^ROLLBACK TO SAVEPOINT /i.test(sql) || /^RELEASE SAVEPOINT /i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT set_config/.test(sql)) return { rows: [{ set_config: params[1] }] };
      if (/SELECT deposited_at, payee_line/.test(sql)) {
        return { rows: missing ? [] : [{ deposited_at, payee_line }] };
      }
      if (/FROM public.aws_financial_operations/.test(sql)) {
        return { rows: confirmedDeposit ? [{ ok: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
};

export const assertConfirmedDepositContract = () => {
  s14Assert(
    [...MONEY_IN_OPERATION_TYPES].join(',') === ACCEPTED_MONEY_IN_TYPES.join(','),
    'confirmed provider deposit types must remain exactly checkalt_deposit',
  );
  const statuses = [...CONFIRMED_MONEY_STATUSES].sort();
  s14Assert(
    statuses.join(',') === [...ACCEPTED_CONFIRMED_STATUSES].sort().join(','),
    'confirmed provider deposit statuses must remain exactly provider_confirmed and settled',
  );
};

export const assertHelperInvariants = async (helper) => {
  s14Assert(typeof helper.isCheckDeposited === 'function', 'isCheckDeposited helper is missing');
  s14Assert(typeof helper.rejectPayeeLineIfDeposited === 'function', 'rejectPayeeLineIfDeposited is missing');
  s14Assert(typeof helper.resolveWritablePayeeLine === 'function', 'resolveWritablePayeeLine is missing');
  s14Assert(helper.PAYEE_LINE_LOCKED === 'payee_line_locked', 'PAYEE_LINE_LOCKED constant drifted');

  const open = await helper.isCheckDeposited(depositClient(), UUID);
  s14Assert(open.deposited === false && open.reason === 'not_deposited', 'pre-deposit check must not be locked');

  const stamped = await helper.isCheckDeposited(
    depositClient({ deposited_at: '2026-09-25T00:00:00Z' }),
    UUID,
  );
  s14Assert(stamped.deposited === true && stamped.reason === 'deposited_at', 'deposited_at IS NOT NULL must lock');

  const confirmedClient = depositClient({ confirmedDeposit: true });
  const confirmed = await helper.isCheckDeposited(confirmedClient, UUID);
  s14Assert(
    confirmed.deposited === true && confirmed.reason === 'confirmed_provider_deposit',
    'confirmed checkalt_deposit must lock even when deposited_at is null',
  );
  const sqls = confirmedClient.queries.map((row) => row.sql);
  s14Assert(sqls.some((sql) => /FROM public.aws_financial_operations/.test(sql)), 'confirmed-provider lookup was not performed');
  s14Assert(sqls.some((sql) => /SAVEPOINT s14_deposit_lookup/i.test(sql)), 'confirmed-provider lookup must use s14_deposit_lookup savepoint');
  s14Assert(
    sqls.some((sql) => /set_config\('request.financial_certification'/.test(sql)),
    'confirmed-provider lookup must raise financial certification inside the savepoint',
  );
  const ops = confirmedClient.queries.find((row) => /FROM public.aws_financial_operations/.test(row.sql));
  s14Assert(Array.isArray(ops?.params?.[1]), 'confirmed-provider lookup must pass money-in types');
  s14Assert(Array.isArray(ops?.params?.[2]), 'confirmed-provider lookup must pass confirmed statuses');
  s14Assert(
    [...ops.params[1]].sort().join(',') === [...ACCEPTED_MONEY_IN_TYPES].sort().join(','),
    'confirmed-provider types were broadened or narrowed',
  );
  s14Assert(
    [...ops.params[2]].sort().join(',') === [...ACCEPTED_CONFIRMED_STATUSES].sort().join(','),
    'confirmed-provider statuses were broadened or narrowed',
  );

  const failed = await helper.isCheckDeposited(depositClient({ throwOn: 'check_intake_items' }), UUID);
  s14Assert(failed.deposited === true && failed.failClosed === true, 'lookup failure must fail closed');

  const missing = await helper.isCheckDeposited(depositClient({ missing: true }), UUID);
  s14Assert(missing.deposited === true && missing.failClosed === true, 'missing check must fail closed');

  const invalid = await helper.isCheckDeposited(depositClient(), 'not-a-uuid');
  s14Assert(invalid.deposited === true && invalid.failClosed === true, 'invalid check id must fail closed');

  const same = await helper.rejectPayeeLineIfDeposited(
    depositClient({ deposited_at: '2026-09-25T00:00:00Z' }),
    UUID,
    { current: 'Corrected Payee Line', next: 'Corrected Payee Line' },
  );
  s14Assert(same.locked === false && same.noop === true, 'same-value post-deposit request must be a no-op');

  const changedStamp = await helper.rejectPayeeLineIfDeposited(
    depositClient({ deposited_at: '2026-09-25T00:00:00Z' }),
    UUID,
    { current: 'Corrected Payee Line', next: 'Anything Else' },
  );
  s14Assert(changedStamp.locked === true && changedStamp.error === 'payee_line_locked', 'post-deposit mutation must be denied');

  const changedConfirm = await helper.rejectPayeeLineIfDeposited(
    depositClient({ confirmedDeposit: true }),
    UUID,
    { current: 'Corrected Payee Line', next: 'Anything Else' },
  );
  s14Assert(changedConfirm.locked === true, 'confirmed-deposit mutation must be denied');

  const failClosedWrite = await helper.rejectPayeeLineIfDeposited(
    depositClient({ throwOn: 'aws_financial_operations' }),
    UUID,
    { current: 'Corrected Payee Line', next: 'Anything Else' },
  );
  s14Assert(failClosedWrite.locked === true && failClosedWrite.failClosed === true, 'lookup failure on write must fail closed');

  const preDeposit = await helper.resolveWritablePayeeLine(
    depositClient({ payee_line: 'Original Payee Line' }),
    UUID,
    'Corrected Payee Line',
  );
  s14Assert(preDeposit.value === 'Corrected Payee Line' && preDeposit.locked === false, 'pre-deposit correction must remain writable');

  const lockedOcr = await helper.resolveWritablePayeeLine(
    depositClient({ confirmedDeposit: true, payee_line: 'Corrected Payee Line' }),
    UUID,
    'OCR Rewrite',
  );
  s14Assert(lockedOcr.value == null && lockedOcr.locked === true, 'OCR resolve must not return a post-deposit overwrite');
};

export const assertAllowlistKeepsPreDepositCorrection = (allowlist) => {
  s14Assert(
    !allowlist.INTAKE_PROHIBITED_COLUMNS.has('payee_line'),
    'payee_line must not be placed into INTAKE_PROHIBITED_COLUMNS',
  );
  const intake = allowlist.WRITE_ALLOWLIST.check_intake_items;
  s14Assert(intake.columns.has('payee_line'), 'pre-deposit payee_line must remain an authorized intake column');
  s14Assert(allowlist.INTAKE_PROHIBITED_COLUMNS.has('claim_id'), 'S5 claim_id generic write lock must remain');
  s14Assert(allowlist.INTAKE_PROHIBITED_COLUMNS.has('amount'), 'amount must remain prohibited');
};

export const assertWritersCallHelper = (root) => {
  for (const writer of S14_EXISTING_CHECK_WRITERS) {
    const source = readRepo(root, writer.file);
    s14Assert(
      source.includes("from './check-deposited.mjs'") && source.includes(writer.helper),
      `${writer.file} no longer calls ${writer.helper}`,
    );
    for (const marker of writer.markers) {
      s14Assert(source.includes(marker), `${writer.file} is missing accepted writer marker ${marker}`);
    }
  }
};

const UPDATE_PAYEE_LINE = /UPDATE\s+public\.(?:check_intake_items|claim_checks)[\s\S]{0,400}payee_line\s*=/i;

export const assertNoUnguardedExistingCheckWriter = (root) => {
  const apiDir = path.join(root, 'aws/functions/api');
  const files = fs.readdirSync(apiDir).filter((name) => name.endsWith('.mjs'));
  const unexpected = [];
  for (const name of files) {
    const rel = `aws/functions/api/${name}`;
    const source = fs.readFileSync(path.join(apiDir, name), 'utf8');
    const writesExisting = UPDATE_PAYEE_LINE.test(source)
      || /add\(\s*['"]payee_line['"]\s*,/.test(source)
      || /nextValues\.payee_line/.test(source);
    if (!writesExisting) continue;
    if (name === 'workflow.mjs' && /INSERT INTO public\.check_intake_items/.test(source) && !UPDATE_PAYEE_LINE.test(source)) {
      continue;
    }
    const accepted = S14_EXISTING_CHECK_WRITERS.some((writer) => writer.file === rel);
    const usesHelper = /check-deposited\.mjs/.test(source)
      && /rejectPayeeLineIfDeposited|resolveWritablePayeeLine/.test(source);
    if (!accepted || !usesHelper) unexpected.push(rel);
  }
  s14Assert(
    unexpected.length === 0,
    `unguarded existing-check payee_line writer(s): ${unexpected.join(', ') || 'none'}`,
  );
};

const rewriteRelativeImports = (source, fromDir) => source.replace(
  /from\s+['"](\.\/[^'"]+)['"]/g,
  (_all, rel) => `from ${JSON.stringify(pathToFileURL(path.join(fromDir, rel)).href)}`,
);

export const importMutatedHelper = async (root, mutate) => {
  const apiDir = path.join(root, 'aws/functions/api');
  const original = fs.readFileSync(path.join(apiDir, 'check-deposited.mjs'), 'utf8');
  const mutated = rewriteRelativeImports(mutate(original), apiDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's14-helper-'));
  const dest = path.join(dir, 'check-deposited.mjs');
  fs.writeFileSync(dest, mutated);
  return import(`${pathToFileURL(dest).href}?t=${Date.now()}-${Math.random()}`);
};

export const importMutatedOcrPersist = async (root, mutate) => {
  const apiDir = path.join(root, 'aws/functions/api');
  const original = fs.readFileSync(path.join(apiDir, 'ocr-descriptive-persist.mjs'), 'utf8');
  const mutated = rewriteRelativeImports(mutate(original), apiDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's14-ocr-'));
  const dest = path.join(dir, 'ocr-descriptive-persist.mjs');
  fs.writeFileSync(dest, mutated);
  return import(`${pathToFileURL(dest).href}?t=${Date.now()}-${Math.random()}`);
};

export const expectS14Failure = async (label, fn) => {
  let failed = false;
  let message = '';
  try {
    await fn();
  } catch (error) {
    failed = true;
    message = String(error?.message || error);
  }
  assert.equal(failed, true, `${S14_LABEL}: expected FAIL for ${label}`);
  assert.match(message, /S14 Deposit Payee Line Protection/, `${S14_LABEL}: failure for ${label} must name S14`);
};

export const mutateRemoveConfirmedProvider = (source) => {
  const target = `    const confirmed = await lookupConfirmedProviderDeposit(client, checkId);
    if (confirmed.error) {
      return {
        deposited: true,
        failClosed: true,
        reason: 'lookup_failed',
        payee_line: null,
      };
    }
    if (confirmed.found) {
      return {
        deposited: true,
        failClosed: false,
        reason: 'confirmed_provider_deposit',
        payee_line: payeeLine,
      };
    }`;
  if (!source.includes(target)) {
    throw new Error(`${S14_LABEL}: cannot apply confirmed-provider mutation`);
  }
  return source.replace(target, '    const confirmed = { error: false, found: false };');
};

export const mutateFailOpen = (source) => source
  .replace(/deposited:\s*true,\s*\n\s*failClosed:\s*true/g, 'deposited: false,\n      failClosed: false');

export const mutateRemoveDepositedAt = (source) => {
  const target = `    if (row.deposited_at) {
      return {
        deposited: true,
        failClosed: false,
        reason: 'deposited_at',
        payee_line: payeeLine,
      };
    }`;
  if (!source.includes(target)) {
    throw new Error(`${S14_LABEL}: cannot apply deposited_at mutation`);
  }
  return source.replace(target, '');
};

export const mutateOcrBypass = (source) => source.replace(
  /const resolvedPayee = await resolveWritablePayeeLine\([\s\S]*?\);/,
  'const resolvedPayee = { value: normalizeDescriptiveText(parsed.payee_line), locked: false };',
);

export const mutateStripWriterHelperCalls = (source) => source
  .replace(/import \{[^}]*\} from '\.\/check-deposited\.mjs';\n/, '')
  .replace(/const guard = await rejectPayeeLineIfDeposited\([\s\S]*?\);/g, 'const guard = { locked: false, noop: false };')
  .replace(/const writablePayee = await resolveWritablePayeeLine\([\s\S]*?\);/g, 'const writablePayee = { value: parsed.payee_line };')
  .replace(/guardIngestPlanPayeeLine/g, 'async function unusedGuard');
