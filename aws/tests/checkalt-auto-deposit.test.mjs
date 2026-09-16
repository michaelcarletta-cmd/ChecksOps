import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_DEPOSIT_ACTOR,
  AUTO_DEPOSIT_REASONS,
  AUTO_DEPOSIT_TRIGGERS,
  applyAutoDepositSettings,
  evaluateAutoDepositPolicy,
  maybeRunCheckAltAutoDeposit,
  parseAutoDepositConfigValues,
  roleAllowsAutoDepositConfig,
} from '../functions/api/providers/production/checkalt-auto-deposit.mjs';
import { handleProductionCheckAltSubmit } from '../functions/api/providers/production/checkalt-submit.mjs';
import { hasAuthoritativeCheckAltSubmission, normalCheckAltDepositAllowed } from '../../src/features/check-command/checkAltLifecycle.ts';
import { buildFinancialStepUpRequest, isTenantBoundAction } from '../../src/lib/financialStepUp.ts';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';

const mapping = {
  application_user_id: USER,
  email: 'owner@freedomadj.com',
};

const readyCheck = (extra = {}) => ({
  id: CHECK,
  tenant_id: TENANT,
  amount: 1546.72,
  status: 'approved_for_deposit',
  check_stage: 'ready_for_deposit',
  updated_at: '2026-09-16T12:00:00.000Z',
  ...extra,
});

const onSetting = (extra = {}) => ({
  tenant_id: TENANT,
  auto_deposit_enabled: true,
  auto_deposit_max_cents: 200000,
  auto_deposit_updated_at: '2026-09-16T11:00:00.000Z',
  ...extra,
});

const createStore = () => ({
  deposits: [],
  decisions: [],
  settings: [],
  audits: [],
  submits: 0,
  totpReads: 0,
});

const clientFor = (store) => ({
  connect: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('FROM public.checkalt_deposits') && text.includes('ORDER BY')) {
      return {
        rows: store.deposits.filter((row) => (
          row.tenant_id === params[0] && row.check_intake_item_id === params[1]
        )),
      };
    }
    if (text.includes('INSERT INTO public.checkalt_auto_deposit_decisions')) {
      const row = {
        id: crypto.randomUUID(),
        tenant_id: params[0],
        check_intake_item_id: params[1],
        amount_cents: params[2],
        auto_deposit_enabled: params[3],
        auto_deposit_max_cents: params[4],
        eligible: params[5],
        reason: params[6],
        trigger: params[7],
        actor: params[8],
        deposit_id: params[9],
        checkalt_reference: params[10],
        submit_result: typeof params[11] === 'string' ? JSON.parse(params[11]) : params[11],
        created_at: new Date().toISOString(),
      };
      store.decisions.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.checkalt_tenant_deposit_settings')) {
      return { rows: store.settings.filter((row) => row.tenant_id === params[0]) };
    }
    if (text.includes('INSERT INTO public.checkalt_tenant_deposit_settings')) {
      const row = {
        tenant_id: params[0],
        auto_deposit_enabled: params[1],
        auto_deposit_max_cents: params[2],
        auto_deposit_updated_by: params[3],
        auto_deposit_updated_at: new Date().toISOString(),
      };
      store.settings = store.settings.filter((item) => item.tenant_id !== params[0]);
      store.settings.push(row);
      return { rows: [row] };
    }
    if (text.includes('INSERT INTO public.checkalt_auto_deposit_settings_audit')) {
      const row = { id: crypto.randomUUID(), tenant_id: params[0], actor_id: params[1] };
      store.audits.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.financial_stepup_log')) {
      store.totpReads += 1;
      return { rows: [] };
    }
    if (text.includes('FROM public.check_review_decisions') || text.includes('FROM public.check_audit_log')) {
      return { rows: [] };
    }
    return { rows: [] };
  },
});

const run = (store, extra = {}) => maybeRunCheckAltAutoDeposit({
  client: clientFor(store),
  mapping,
  claims: { sub: 'cognito-sub' },
  check: extra.check || readyCheck(),
  previous: extra.previous === undefined ? { status: 'endorsements_complete', check_stage: 'endorsing' } : extra.previous,
  trigger: extra.trigger || AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION,
  deps: {
    setting: extra.setting === undefined ? onSetting() : extra.setting,
    evaluatePreflight: extra.preflight || (async () => ({
      ok: true,
      readyForVerification: true,
      historicalReference: false,
    })),
    submit: extra.submit || (async () => {
      store.submits += 1;
      const deposit = {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        check_intake_item_id: CHECK,
        tenant_id: TENANT,
        checkalt_reference: 'AUTO-1',
        status: 'submitted',
        provider_http_attempted_at: new Date().toISOString(),
        last_status_payload: { submission_source: 'auto_deposit' },
      };
      store.deposits.push(deposit);
      return {
        liveProviderCalled: true,
        checkalt_reference: 'AUTO-1',
        deposit_id: deposit.id,
        status: 'submitted',
        submission_source: 'auto_deposit',
        interactiveTotp: false,
      };
    }),
    executionAllowed: extra.executionAllowed || (() => true),
  },
});

test('default OFF and settings_change never submit', () => {
  const off = evaluateAutoDepositPolicy({
    setting: { auto_deposit_enabled: false, auto_deposit_max_cents: 200000 },
    check: readyCheck(),
    previous: { status: 'endorsements_complete' },
    amountCents: 154672,
    trigger: AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION,
  });
  assert.equal(off.eligible, false);
  assert.equal(off.reason, AUTO_DEPOSIT_REASONS.SETTING_OFF);

  const sweep = evaluateAutoDepositPolicy({
    setting: onSetting(),
    check: readyCheck(),
    previous: { status: 'endorsements_complete' },
    amountCents: 154672,
    trigger: AUTO_DEPOSIT_TRIGGERS.SETTINGS_CHANGE,
  });
  assert.equal(sweep.eligible, false);
  assert.equal(sweep.reason, AUTO_DEPOSIT_REASONS.PREEXISTING_READY);
});

test('amount at or below threshold is eligible; above is not', () => {
  const below = evaluateAutoDepositPolicy({
    setting: onSetting({ auto_deposit_max_cents: 154672 }),
    check: readyCheck(),
    previous: { status: 'endorsements_complete' },
    amountCents: 154672,
    trigger: AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION,
  });
  assert.equal(below.eligible, true);
  assert.equal(below.reason, 'at_threshold');

  const under = evaluateAutoDepositPolicy({
    setting: onSetting({ auto_deposit_max_cents: 200000 }),
    check: readyCheck(),
    previous: { status: 'endorsements_complete' },
    amountCents: 154672,
    trigger: AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION,
  });
  assert.equal(under.eligible, true);
  assert.equal(under.reason, 'below_threshold');

  const above = evaluateAutoDepositPolicy({
    setting: onSetting({ auto_deposit_max_cents: 100000 }),
    check: readyCheck(),
    previous: { status: 'endorsements_complete' },
    amountCents: 154672,
    trigger: AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION,
  });
  assert.equal(above.eligible, false);
  assert.equal(above.reason, AUTO_DEPOSIT_REASONS.ABOVE_THRESHOLD);
});

test('preexisting Ready checks are not swept when Auto-Deposit is enabled', async () => {
  const store = createStore();
  const result = await run(store, {
    previous: { status: 'approved_for_deposit', check_stage: 'ready_for_deposit' },
  });
  assert.equal(result.submitted, false);
  assert.equal(result.reason, AUTO_DEPOSIT_REASONS.PREEXISTING_READY);
  assert.equal(store.submits, 0);
  assert.equal(store.decisions[0].reason, AUTO_DEPOSIT_REASONS.PREEXISTING_READY);
});

test('changing the threshold does not sweep existing Ready checks', async () => {
  const store = createStore();
  store.settings.push({
    tenant_id: TENANT,
    auto_deposit_enabled: false,
    auto_deposit_max_cents: null,
  });
  const applied = await applyAutoDepositSettings({
    client: clientFor(store),
    mapping,
    tenantId: TENANT,
    enabled: true,
    maxCents: 500000,
  });
  assert.equal(applied.swept, false);
  assert.equal(store.settings[0].auto_deposit_enabled, true);
  assert.equal(store.audits.length, 1);
  const result = await run(store, {
    setting: store.settings[0],
    previous: { status: 'approved_for_deposit', check_stage: 'ready_for_deposit' },
    trigger: AUTO_DEPOSIT_TRIGGERS.SETTINGS_CHANGE,
  });
  assert.equal(result.submitted, false);
  assert.equal(result.reason, AUTO_DEPOSIT_REASONS.PREEXISTING_READY);
  assert.equal(store.submits, 0);
});

test('OFF or above-threshold Ready transitions do not submit', async () => {
  const offStore = createStore();
  const off = await run(offStore, { setting: { auto_deposit_enabled: false, auto_deposit_max_cents: 200000 } });
  assert.equal(off.submitted, false);
  assert.equal(off.reason, AUTO_DEPOSIT_REASONS.SETTING_OFF);
  assert.equal(offStore.submits, 0);

  const overStore = createStore();
  const over = await run(overStore, { setting: onSetting({ auto_deposit_max_cents: 1000 }) });
  assert.equal(over.submitted, false);
  assert.equal(over.reason, AUTO_DEPOSIT_REASONS.ABOVE_THRESHOLD);
  assert.equal(overStore.submits, 0);
});

test('incomplete endorsements and invalid artifacts stay Ready/manual', async () => {
  const endorsements = createStore();
  const blockedEndorsements = await run(endorsements, {
    preflight: async () => ({ ok: false, readyForVerification: false, error: 'endorsements_incomplete' }),
  });
  assert.equal(blockedEndorsements.submitted, false);
  assert.equal(blockedEndorsements.reason, AUTO_DEPOSIT_REASONS.GATES_FAILED);
  assert.equal(endorsements.submits, 0);

  const artifacts = createStore();
  const blockedArtifacts = await run(artifacts, {
    preflight: async () => ({ ok: false, readyForVerification: false, error: 'checkalt_image_noncompliant' }),
  });
  assert.equal(blockedArtifacts.submitted, false);
  assert.equal(blockedArtifacts.reason, AUTO_DEPOSIT_REASONS.GATES_FAILED);
  assert.equal(artifacts.submits, 0);
});

test('existing reference and uncertain provider state never auto-retry', async () => {
  const referenced = createStore();
  referenced.deposits.push({
    id: 'ref-1',
    tenant_id: TENANT,
    check_intake_item_id: CHECK,
    checkalt_reference: '122678838',
    status: 'pending_approval',
    provider_http_attempted_at: '2026-09-01T00:00:00.000Z',
  });
  const blockedRef = await run(referenced);
  assert.equal(blockedRef.submitted, false);
  assert.equal(blockedRef.reason, AUTO_DEPOSIT_REASONS.ALREADY_HAS_REFERENCE);
  assert.equal(referenced.submits, 0);

  const uncertain = createStore();
  uncertain.deposits.push({
    id: 'unc-1',
    tenant_id: TENANT,
    check_intake_item_id: CHECK,
    checkalt_reference: null,
    status: 'submitting',
    provider_http_attempted_at: '2026-09-16T11:00:00.000Z',
  });
  const blockedUncertain = await run(uncertain);
  assert.equal(blockedUncertain.submitted, false);
  assert.equal(blockedUncertain.reason, AUTO_DEPOSIT_REASONS.UNCERTAIN_BLOCKED);
  assert.equal(uncertain.submits, 0);
});

test('duplicate concurrent Ready transitions submit at most once', async () => {
  const store = createStore();
  let inFlight = null;
  const submit = async () => {
    store.submits += 1;
    if (store.submits > 1) {
      return {
        liveProviderCalled: false,
        duplicate: true,
        replayed: true,
        checkalt_reference: 'AUTO-1',
        deposit_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      };
    }
    const deposit = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      tenant_id: TENANT,
      check_intake_item_id: CHECK,
      checkalt_reference: 'AUTO-1',
      status: 'submitted',
      provider_http_attempted_at: new Date().toISOString(),
    };
    store.deposits.push(deposit);
    return {
      liveProviderCalled: true,
      checkalt_reference: 'AUTO-1',
      deposit_id: deposit.id,
      status: 'submitted',
    };
  };
  const first = run(store, { submit });
  const second = run(store, { submit });
  const results = await Promise.all([first, second]);
  assert.equal(store.submits, 2);
  const providerPosts = results.filter((row) => row.submit?.liveProviderCalled === true);
  const blocked = results.filter((row) => (
    row.reason === AUTO_DEPOSIT_REASONS.DUPLICATE_BLOCKED
    || row.reason === AUTO_DEPOSIT_REASONS.ALREADY_HAS_REFERENCE
    || row.submit?.duplicate === true
  ));
  assert.equal(providerPosts.length, 1);
  assert.ok(blocked.length >= 1);
  void inFlight;
});

test('eligible Ready transition submits through the production path without interactive TOTP', async () => {
  const store = createStore();
  const result = await run(store);
  assert.equal(result.submitted, true);
  assert.equal(result.reason, AUTO_DEPOSIT_REASONS.EXECUTED);
  assert.equal(result.interactiveTotp, false);
  assert.equal(store.submits, 1);
  assert.equal(store.totpReads, 0);
  assert.equal(result.decision.actor, AUTO_DEPOSIT_ACTOR);
  assert.equal(result.decision.checkalt_reference, 'AUTO-1');
  assert.equal(result.submit.submission_source, 'auto_deposit');
});

test('automatic submission produces the same post-submission safety state as manual', () => {
  const autoCheck = {
    checkalt_deposits: [{
      id: 'd1',
      status: 'submitted',
      checkalt_reference: 'AUTO-1',
      provider_http_attempted_at: '2026-09-16T12:00:00.000Z',
      last_status_payload: { submission_source: 'auto_deposit' },
    }],
  };
  const manualCheck = {
    checkalt_deposits: [{
      id: 'd2',
      status: 'submitted',
      checkalt_reference: 'MANUAL-1',
      provider_http_attempted_at: '2026-09-16T12:00:00.000Z',
      last_status_payload: { submission_source: 'manual' },
    }],
  };
  assert.equal(hasAuthoritativeCheckAltSubmission(autoCheck), true);
  assert.equal(normalCheckAltDepositAllowed(autoCheck), false);
  assert.equal(hasAuthoritativeCheckAltSubmission(manualCheck), true);
  assert.equal(normalCheckAltDepositAllowed(manualCheck), false);
});

test('browser cannot request Auto-Deposit authority on the submit path', async () => {
  const denied = await handleProductionCheckAltSubmit({
    client: clientFor(createStore()),
    mapping,
    claims: { sub: 'x' },
    body: { check_intake_item_id: CHECK, auto_deposit: true, skip_step_up: true },
    spoof: {},
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'untrusted_auto_deposit_authority');
  assert.equal(denied.liveProviderCalled, false);
});

test('owner/admin may configure; manager may not; values are integer cents', () => {
  assert.equal(roleAllowsAutoDepositConfig(['owner']), true);
  assert.equal(roleAllowsAutoDepositConfig(['admin']), true);
  assert.equal(roleAllowsAutoDepositConfig(['manager']), false);
  assert.equal(roleAllowsAutoDepositConfig(['staff']), false);
  const parsed = parseAutoDepositConfigValues({ auto_deposit_enabled: true, auto_deposit_max_cents: 154672 });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.maxCents, 154672);
  const bad = parseAutoDepositConfigValues({ auto_deposit_enabled: true, auto_deposit_max_cents: 12.5 });
  assert.equal(bad.error, 'invalid_threshold');
});

test('Auto-Deposit configure step-up is tenant-bound and not check-bound', () => {
  assert.equal(isTenantBoundAction('checkalt.auto_deposit.configure'), true);
  const missing = buildFinancialStepUpRequest({ actionKey: 'checkalt.auto_deposit.configure' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'tenant_id is required');
  const ok = buildFinancialStepUpRequest({
    actionKey: 'checkalt.auto_deposit.configure',
    tenantId: TENANT,
    autoDepositEnabled: true,
    autoDepositMaxCents: 200000,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.checkId, null);
  assert.equal(ok.request.tenantId, TENANT);
});

test('auto-deposit module does not read auto_approve_* columns', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const here = path.dirname((await import('node:url')).fileURLToPath(import.meta.url));
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const source = strip(fs.readFileSync(path.join(here, '../functions/api/providers/production/checkalt-auto-deposit.mjs'), 'utf8'));
  const http = strip(fs.readFileSync(path.join(here, '../functions/api/providers/production/checkalt-auto-deposit-http.mjs'), 'utf8'));
  assert.equal(/auto_approve_/.test(source), false);
  assert.equal(/auto_approve_/.test(http), false);
});
