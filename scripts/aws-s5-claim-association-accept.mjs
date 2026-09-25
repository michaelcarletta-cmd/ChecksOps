#!/usr/bin/env node
/**
 * Staging-only S5 acceptance for admin_set_check_claim.
 * Uses synthetic Freedom/C1C records and deletes the synthetic check afterward.
 * Does not touch production or the four billing-protected leftover checks.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const RUN_ID = `S5ACC-${Date.now()}`;
const MARKER = `AWS S5 ACC ${RUN_ID}`;
const ARTIFACT = process.env.S5_ACCEPT_ARTIFACT || '/opt/cursor/artifacts/s5-staging-acceptance.json';
const PROTECTED = new Set([
  'b887bd62-1bb0-4d8b-bfc2-9e63d79e77bd',
  '710c9494-04f1-4ff2-8bd3-da9cd8f4658c',
  '1068ac20-08c2-4adb-a6cd-51437efaed73',
  'ed194599-fe40-4dee-ae9c-015fec8674d4',
]);

const tokenFile = process.env.STAGING_TOKEN_FILE || '/tmp/checksops-staging-tokens.json';
const mintedTokens = fs.existsSync(tokenFile)
  ? JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  : {};

const results = [];
const created = { checks: [] };

const record = (name, ok, extra = {}) => {
  const row = { name, ok, ...extra };
  results.push(row);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
  return row;
};

const api = async (path, { method = 'POST', token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try { json = await response.json(); } catch { json = {}; }
  return { status: response.status, json };
};

const login = (email) => {
  const token = mintedTokens[email] || mintedTokens[email.toLowerCase()]
    || (email === FREEDOM_EMAIL ? mintedTokens.freedom : null)
    || (email === C1C_EMAIL ? mintedTokens.c1c : null);
  if (!token) throw new Error(`missing minted token for ${email}`);
  return token;
};

const write = (token, body) => api('/data/write', { token, body });
const query = (token, body) => api('/data/query', { token, body });
const rpc = (token, name, args = {}) => api('/data/rpc', { token, body: { name, args } });
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);
const rowsOf = (payload) => (Array.isArray(payload) ? payload : (payload ? [payload] : []));
const eventData = (row) => {
  const raw = row?.event_data;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
};

const loadCheck = async (token, checkId) => {
  const res = await query(token, {
    table: 'check_intake_items',
    select: 'id,tenant_id,status,check_stage,claim_id,amount,payee_line,carrier_name,check_number,funds_type,review_notes,property_address,deposited_at,detected_claim_number',
    filters: [{ column: 'id', op: 'eq', value: checkId }],
  });
  return rowOf(res.json.data);
};

const loadRelated = async (token, checkId) => {
  const [payees, endorsements, audit, deposits, claimChecks, billing] = await Promise.all([
    query(token, { table: 'check_payees', select: 'id,check_id,payee_name,payee_type,endorsement_status', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_endorsements', select: 'id,check_id,payee_id,status,signed_at', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_audit_log', select: 'id,check_id,event_type,event_description,event_data,actor_id,created_at', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'deposit_items', select: 'id,check_id,amount,status,claim_id', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'claim_checks', select: 'id,check_intake_item_id,claim_id,amount', filters: [{ column: 'check_intake_item_id', op: 'eq', value: checkId }] }),
    query(token, { table: 'check_billing_events', select: 'id,check_id,amount_cents,event_type', filters: [{ column: 'check_id', op: 'eq', value: checkId }] }),
  ]);
  return {
    payees: rowsOf(payees.json.data),
    endorsements: rowsOf(endorsements.json.data),
    audit: rowsOf(audit.json.data),
    deposits: rowsOf(deposits.json.data),
    claimChecks: rowsOf(claimChecks.json.data),
    billing: rowsOf(billing.json.data),
  };
};

const claimAudits = (audit) => audit.filter((row) => row.event_type === 'admin_set_check_claim');

const listClaims = async (token, orgId) => {
  const byOrg = await query(token, {
    table: 'claims',
    select: 'id,org_id,claim_number',
    filters: [{ column: 'org_id', op: 'eq', value: orgId }],
    limit: 10,
  });
  if (byOrg.status === 200) {
    return rowsOf(byOrg.json.data).filter((row) => String(row.org_id) === String(orgId));
  }
  const unfiltered = await query(token, {
    table: 'claims',
    select: 'id,org_id,claim_number',
    limit: 25,
  });
  return rowsOf(unfiltered.json.data).filter((row) => String(row.org_id) === String(orgId));
};

const findDeposited = async (token) => {
  const res = await query(token, {
    table: 'check_intake_items',
    select: 'id,tenant_id,claim_id,deposited_at,amount,status,payee_line',
    filters: [
      { column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT },
      { column: 'deposited_at', op: 'not', notOp: 'is', value: null },
    ],
    limit: 5,
  });
  const rows = rowsOf(res.json.data).filter((row) => row.deposited_at);
  if (rows.length) return rows[0];
  const fallback = await query(token, {
    table: 'check_intake_items',
    select: 'id,tenant_id,claim_id,deposited_at,amount,status,payee_line',
    filters: [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    limit: 50,
  });
  return rowsOf(fallback.json.data).find((row) => row.deposited_at) || null;
};

const snapshotFields = (check, related) => ({
  amount: check?.amount ?? null,
  payee_line: check?.payee_line ?? null,
  status: check?.status ?? null,
  check_stage: check?.check_stage ?? null,
  deposited_at: check?.deposited_at ?? null,
  funds_type: check?.funds_type ?? null,
  payees: (related.payees || []).map((row) => ({
    id: row.id, payee_name: row.payee_name, payee_type: row.payee_type, endorsement_status: row.endorsement_status,
  })),
  endorsements: (related.endorsements || []).map((row) => ({
    id: row.id, status: row.status, signed_at: row.signed_at,
  })),
  deposits: related.deposits || [],
  claimChecks: related.claimChecks || [],
  billing: related.billing || [],
});

const sameSnapshot = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const deleteCheck = async (token, checkId) => {
  if (PROTECTED.has(checkId)) {
    return { status: 0, json: { error: 'protected_leftover', skipped: true } };
  }
  const current = await loadCheck(token, checkId);
  if (current?.claim_id) {
    await rpc(token, 'admin_set_check_claim', { p_check_id: checkId, p_claim_id: null });
  }
  return api(`/workflow/checks/${checkId}`, {
    method: 'DELETE',
    token,
    body: { check_id: checkId, reason: `${MARKER} synthetic cleanup` },
  });
};

const main = async () => {
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  const freedom = login(FREEDOM_EMAIL);
  const c1c = login(C1C_EMAIL);

  const flags = await api('/workflow/status', { method: 'GET' });
  record('staging workflow writes enabled', flags.status === 200 && flags.json.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED === true, {
    detail: `t5=${flags.json.flags?.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED}`,
  });

  const whoami = await query(freedom, {
    table: 'user_roles',
    select: 'user_id,role',
    limit: 20,
  });
  const actorId = whoami.json.applicationUserId;
  const roleNames = rowsOf(whoami.json.data)
    .filter((row) => String(row.user_id) === String(actorId))
    .map((row) => String(row.role || '').toLowerCase());
  record('freedom caller is admin', Boolean(actorId) && roleNames.includes('admin'), {
    detail: `actor=${actorId || 'none'} roles=${roleNames.join(',') || 'none'}`,
  });

  const freedomClaims = (await listClaims(freedom, FREEDOM_TENANT))
    .sort((a, b) => String(a.claim_number || '').localeCompare(String(b.claim_number || '')));
  const synthetic = freedomClaims.filter((row) => String(row.claim_number || '').startsWith('AWS-S5-SYNTHETIC'));
  const usableFreedom = synthetic.length >= 2 ? synthetic : freedomClaims;
  const c1cClaims = await listClaims(c1c, C1C_TENANT);
  record('freedom has two claims', usableFreedom.length >= 2, {
    detail: `count=${usableFreedom.length} ids=${usableFreedom.slice(0, 2).map((row) => row.id).join(',')}`,
  });
  record('c1c has a cross-tenant claim', c1cClaims.length >= 1, {
    detail: `count=${c1cClaims.length} id=${c1cClaims[0]?.id || 'none'}`,
  });
  if (usableFreedom.length < 2 || !c1cClaims[0]?.id) {
    throw new Error('Need ≥2 Freedom claims and ≥1 C1C claim for S5 acceptance');
  }
  const claimA = usableFreedom[0].id;
  const claimB = usableFreedom[1].id;
  const claimC1c = c1cClaims[0].id;

  const createdCheck = await api('/workflow/checks', {
    token: freedom,
    body: {
      carrier_name: MARKER,
      review_notes: MARKER,
      check_number: `S5${Date.now().toString().slice(-8)}`,
      payee_line: 'S5 Claim Switch',
      funds_type: 'acv',
      amount: 150,
      property_address: '500 S5 Audit Lane',
    },
  });
  const check = rowOf(createdCheck.json.data);
  if (check?.id) created.checks.push(check.id);
  record('synthetic check created unlinked', createdCheck.status === 200 && check?.id && check.claim_id == null && Number(check.amount) === 150, {
    detail: `id=${check?.id} claim_id=${check?.claim_id || 'null'} amount=${check?.amount}`,
    checkId: check?.id,
  });
  if (!check?.id) throw new Error('failed to create synthetic check');

  await api('/workflow/transition', { token: freedom, body: { check_id: check.id, action: 'start_review' } });
  await write(freedom, {
    table: 'check_payees',
    op: 'insert',
    values: { check_id: check.id, payee_name: 'S5 Claim Switch', payee_type: 'insured', contact_email: 's5acc-payee@example.invalid' },
    single: true,
  });

  const before = snapshotFields(await loadCheck(freedom, check.id), await loadRelated(freedom, check.id));

  const setA = await rpc(freedom, 'admin_set_check_claim', { p_check_id: check.id, p_claim_id: claimA });
  const afterA = await loadCheck(freedom, check.id);
  const relatedA = await loadRelated(freedom, check.id);
  const auditsA = claimAudits(relatedA.audit);
  const auditA = auditsA[auditsA.length - 1];
  const dataA = eventData(auditA);
  const case1 = setA.status === 200
    && setA.json.data?.ok === true
    && setA.json.data?.noop !== true
    && String(afterA?.claim_id) === String(claimA)
    && dataA.prior_claim_id == null
    && String(dataA.new_claim_id) === String(claimA)
    && String(auditA?.actor_id) === String(actorId)
    && String(auditA?.check_id) === String(check.id)
    && Boolean(auditA?.created_at || dataA.changed_at);
  record('1 unlinked → Claim A succeeds and audits', case1, {
    detail: `http=${setA.status} claim_id=${afterA?.claim_id} prior=${dataA.prior_claim_id} new=${dataA.new_claim_id} actor=${auditA?.actor_id} auditId=${auditA?.id}`,
    audit: auditA,
    rpc: { status: setA.status, error: setA.json.error, data: setA.json.data },
  });

  const setB = await rpc(freedom, 'admin_set_check_claim', { p_check_id: check.id, p_claim_id: claimB });
  const afterB = await loadCheck(freedom, check.id);
  const relatedB = await loadRelated(freedom, check.id);
  const auditsB = claimAudits(relatedB.audit);
  const auditB = auditsB[auditsB.length - 1];
  const dataB = eventData(auditB);
  const case2 = setB.status === 200
    && String(afterB?.claim_id) === String(claimB)
    && String(dataB.prior_claim_id) === String(claimA)
    && String(dataB.new_claim_id) === String(claimB)
    && auditsB.length === auditsA.length + 1;
  record('2 Claim A → Claim B succeeds and audits', case2, {
    detail: `http=${setB.status} claim_id=${afterB?.claim_id} prior=${dataB.prior_claim_id} new=${dataB.new_claim_id} audits=${auditsB.length}`,
    audit: auditB,
    rpc: { status: setB.status, error: setB.json.error, data: setB.json.data },
  });

  const beforeNoopCount = auditsB.length;
  const noop = await rpc(freedom, 'admin_set_check_claim', { p_check_id: check.id, p_claim_id: claimB });
  const afterNoop = await loadCheck(freedom, check.id);
  const relatedNoop = await loadRelated(freedom, check.id);
  const auditsNoop = claimAudits(relatedNoop.audit);
  const case8 = noop.status === 200
    && noop.json.data?.noop === true
    && String(afterNoop?.claim_id) === String(claimB)
    && auditsNoop.length === beforeNoopCount;
  record('8 same-value no-op does not create audit history', case8, {
    detail: `http=${noop.status} noop=${noop.json.data?.noop} auditsBefore=${beforeNoopCount} auditsAfter=${auditsNoop.length} claim_id=${afterNoop?.claim_id}`,
    rpc: { status: noop.status, error: noop.json.error, data: noop.json.data },
  });

  const clear = await rpc(freedom, 'admin_set_check_claim', { p_check_id: check.id, p_claim_id: null });
  const afterClear = await loadCheck(freedom, check.id);
  const relatedClear = await loadRelated(freedom, check.id);
  const auditsClear = claimAudits(relatedClear.audit);
  const auditClear = auditsClear[auditsClear.length - 1];
  const dataClear = eventData(auditClear);
  const case3 = clear.status === 200
    && afterClear?.claim_id == null
    && String(dataClear.prior_claim_id) === String(claimB)
    && dataClear.new_claim_id == null
    && auditsClear.length === auditsNoop.length + 1;
  record('3 Claim B → NULL succeeds and audits', case3, {
    detail: `http=${clear.status} claim_id=${afterClear?.claim_id || 'null'} prior=${dataClear.prior_claim_id} new=${dataClear.new_claim_id} audits=${auditsClear.length}`,
    audit: auditClear,
    rpc: { status: clear.status, error: clear.json.error, data: clear.json.data },
  });

  const beforeCross = await loadCheck(freedom, check.id);
  const cross = await rpc(freedom, 'admin_set_check_claim', { p_check_id: check.id, p_claim_id: claimC1c });
  const afterCross = await loadCheck(freedom, check.id);
  const relatedCross = await loadRelated(freedom, check.id);
  const case4 = cross.status === 403
    && cross.json.error === 'cross_tenant_denied'
    && afterCross?.claim_id === beforeCross?.claim_id
    && claimAudits(relatedCross.audit).length === auditsClear.length;
  record('4 cross-tenant target claim denied with no mutation', case4, {
    detail: `http=${cross.status} error=${cross.json.error} claim_id=${afterCross?.claim_id || 'null'}`,
    rpc: { status: cross.status, error: cross.json.error, message: cross.json.message },
  });

  const beforeUnauth = afterCross;
  const unauth = await rpc(c1c, 'admin_set_check_claim', { p_check_id: check.id, p_claim_id: claimA });
  const afterUnauth = await loadCheck(freedom, check.id);
  const relatedUnauth = await loadRelated(freedom, check.id);
  const case5 = unauth.status === 403
    && unauth.json.error === 'not_authorized'
    && afterUnauth?.claim_id === beforeUnauth?.claim_id
    && claimAudits(relatedUnauth.audit).length === claimAudits(relatedCross.audit).length;
  record('5 unauthorized/non-admin caller denied with no mutation', case5, {
    detail: `http=${unauth.status} error=${unauth.json.error} claim_id=${afterUnauth?.claim_id || 'null'}`,
    rpc: { status: unauth.status, error: unauth.json.error, message: unauth.json.message },
  });

  const deposited = await findDeposited(freedom);
  let case6 = false;
  let depositedEvidence = { found: false };
  if (deposited?.id) {
    const beforeDep = { claim_id: deposited.claim_id, deposited_at: deposited.deposited_at, amount: deposited.amount };
    const changeDep = await rpc(freedom, 'admin_set_check_claim', { p_check_id: deposited.id, p_claim_id: claimA });
    const clearDep = await rpc(freedom, 'admin_set_check_claim', { p_check_id: deposited.id, p_claim_id: null });
    const afterDep = await loadCheck(freedom, deposited.id);
    case6 = changeDep.status === 403
      && changeDep.json.error === 'already_deposited'
      && clearDep.status === 403
      && clearDep.json.error === 'already_deposited'
      && afterDep?.claim_id === beforeDep.claim_id
      && afterDep?.deposited_at === beforeDep.deposited_at
      && Number(afterDep?.amount) === Number(beforeDep.amount);
    depositedEvidence = {
      found: true,
      id: deposited.id,
      before: beforeDep,
      after: { claim_id: afterDep?.claim_id, deposited_at: afterDep?.deposited_at, amount: afterDep?.amount },
      change: { status: changeDep.status, error: changeDep.json.error },
      clear: { status: clearDep.status, error: clearDep.json.error },
    };
  }
  record('6 deposited check cannot change or clear claim_id', case6, {
    detail: deposited?.id
      ? `id=${deposited.id} change=${depositedEvidence.change?.status}/${depositedEvidence.change?.error} clear=${depositedEvidence.clear?.status}/${depositedEvidence.clear?.error}`
      : 'no Freedom check with deposited_at found',
    deposited: depositedEvidence,
  });

  const generic = await write(freedom, {
    table: 'check_intake_items',
    op: 'update',
    values: { claim_id: claimA },
    filters: [{ column: 'id', op: 'eq', value: check.id }],
    single: true,
  });
  const afterGeneric = await loadCheck(freedom, check.id);
  const case7 = generic.status === 403
    && generic.json.error === 'column_not_allowlisted'
    && (generic.json.columns || []).includes('claim_id')
    && afterGeneric?.claim_id == null;
  record('7 generic /data/write claim_id remains denied', case7, {
    detail: `http=${generic.status} error=${generic.json.error} columns=${JSON.stringify(generic.json.columns || [])} claim_id=${afterGeneric?.claim_id || 'null'}`,
    write: { status: generic.status, error: generic.json.error, columns: generic.json.columns },
  });

  const finalCheck = await loadCheck(freedom, check.id);
  const afterFinal = snapshotFields(finalCheck, await loadRelated(freedom, check.id));
  const case9 = Number(afterFinal.amount) === 150
    && Number(before.amount) === 150
    && afterFinal.payee_line === before.payee_line
    && afterFinal.status === before.status
    && afterFinal.check_stage === before.check_stage
    && afterFinal.deposited_at === before.deposited_at
    && afterFinal.funds_type === before.funds_type
    && sameSnapshot(afterFinal.payees, before.payees)
    && sameSnapshot(afterFinal.endorsements, before.endorsements)
    && sameSnapshot(afterFinal.deposits, before.deposits)
    && sameSnapshot(afterFinal.claimChecks, before.claimChecks)
    && sameSnapshot(afterFinal.billing, before.billing)
    && finalCheck?.claim_id == null;
  record('9 amount, payees, endorsement, deposit, financial unchanged', case9, {
    detail: `amount=${afterFinal.amount} payees=${afterFinal.payees.length} endorsements=${afterFinal.endorsements.length} deposits=${afterFinal.deposits.length} billing=${afterFinal.billing.length} deposited_at=${afterFinal.deposited_at || 'null'}`,
    before,
    after: afterFinal,
  });

  const cleanupRows = [];
  for (const id of created.checks) {
    const del = await deleteCheck(freedom, id);
    cleanupRows.push({ id, status: del.status, error: del.json.error, skipped: del.json.skipped || false });
  }
  record('cleanup synthetic checks', cleanupRows.every((row) => row.status === 200 || row.status === 204 || row.skipped), {
    detail: JSON.stringify(cleanupRows),
  });

  const cases = {
    '1_unlinked_to_a': case1,
    '2_a_to_b': case2,
    '3_b_to_null': case3,
    '4_cross_tenant_denied': case4,
    '5_unauthorized_denied': case5,
    '6_deposited_denied': case6,
    '7_generic_write_denied': case7,
    '8_noop_no_audit': case8,
    '9_other_fields_unchanged': case9,
  };
  const out = {
    ok: Object.values(cases).every(Boolean) && results.every((row) => row.ok),
    runId: RUN_ID,
    checkId: check.id,
    claimA,
    claimB,
    claimC1c,
    cases,
    results,
    audits: {
      a: results.find((row) => row.name.startsWith('1 '))?.audit || null,
      b: results.find((row) => row.name.startsWith('2 '))?.audit || null,
      clear: results.find((row) => row.name.startsWith('3 '))?.audit || null,
    },
    cleanup: cleanupRows,
  };
  fs.writeFileSync(ARTIFACT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: out.ok, artifact: ARTIFACT, cases }, null, 2));
  if (!out.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
