/**
 * Report-only reconciliation. Never auto-corrects financial discrepancies.
 */

export const FINDING_TYPES = {
  INTERNAL_PENDING_PROVIDER_SUCCEEDED: 'internal_pending_provider_succeeded',
  INTERNAL_SUCCEEDED_PROVIDER_MISSING: 'internal_succeeded_provider_missing',
  AMOUNT_MISMATCH: 'amount_mismatch',
  DUPLICATE_PROVIDER_TRANSACTION: 'duplicate_provider_transaction',
  UNKNOWN_PROVIDER_TRANSACTION: 'unknown_provider_transaction',
  STALE_PENDING: 'stale_pending',
};

const STALE_PENDING_MS = 15 * 60 * 1000;

export const classifyFinding = ({ operation, providerTxn, nowMs = Date.now() } = {}) => {
  if (!operation && providerTxn) {
    return {
      finding_type: FINDING_TYPES.UNKNOWN_PROVIDER_TRANSACTION,
      operation_id: null,
      provider_reference: providerTxn.provider_reference || null,
      internal_status: null,
      provider_status: providerTxn.status || null,
      internal_amount_cents: null,
      provider_amount_cents: providerTxn.amount_cents ?? null,
    };
  }
  if (!operation) return null;

  const pending = operation.status === 'submitting' || operation.status === 'provider_pending';
  const succeeded = operation.status === 'provider_confirmed' || operation.status === 'settled';
  const providerSucceeded = providerTxn && ['provider_confirmed', 'settled', 'completed', 'cleared'].includes(
    String(providerTxn.status || ''),
  );

  if (pending && providerSucceeded) {
    return {
      finding_type: FINDING_TYPES.INTERNAL_PENDING_PROVIDER_SUCCEEDED,
      operation_id: operation.id,
      provider_reference: providerTxn.provider_reference || operation.provider_reference || null,
      internal_status: operation.status,
      provider_status: providerTxn.status,
      internal_amount_cents: operation.amount_cents,
      provider_amount_cents: providerTxn.amount_cents ?? null,
    };
  }
  if (succeeded && !providerTxn) {
    return {
      finding_type: FINDING_TYPES.INTERNAL_SUCCEEDED_PROVIDER_MISSING,
      operation_id: operation.id,
      provider_reference: operation.provider_reference || null,
      internal_status: operation.status,
      provider_status: null,
      internal_amount_cents: operation.amount_cents,
      provider_amount_cents: null,
    };
  }
  if (providerTxn && Number.isInteger(providerTxn.amount_cents)
    && Number(providerTxn.amount_cents) !== Number(operation.amount_cents)) {
    return {
      finding_type: FINDING_TYPES.AMOUNT_MISMATCH,
      operation_id: operation.id,
      provider_reference: providerTxn.provider_reference || operation.provider_reference || null,
      internal_status: operation.status,
      provider_status: providerTxn.status || null,
      internal_amount_cents: operation.amount_cents,
      provider_amount_cents: providerTxn.amount_cents,
    };
  }
  if (pending && operation.updated_at) {
    const updatedMs = Date.parse(operation.updated_at);
    if (Number.isFinite(updatedMs) && (nowMs - updatedMs) > STALE_PENDING_MS) {
      return {
        finding_type: FINDING_TYPES.STALE_PENDING,
        operation_id: operation.id,
        provider_reference: operation.provider_reference || null,
        internal_status: operation.status,
        provider_status: providerTxn?.status || null,
        internal_amount_cents: operation.amount_cents,
        provider_amount_cents: providerTxn?.amount_cents ?? null,
      };
    }
  }
  return null;
};

export const detectDuplicateProviderTxns = (providerTxns = []) => {
  const byRef = new Map();
  const findings = [];
  for (const txn of providerTxns) {
    const key = txn.provider_reference || txn.id;
    if (!key) continue;
    if (byRef.has(key)) {
      findings.push({
        finding_type: FINDING_TYPES.DUPLICATE_PROVIDER_TRANSACTION,
        operation_id: txn.operation_id || null,
        provider_reference: key,
        internal_status: null,
        provider_status: txn.status || null,
        internal_amount_cents: null,
        provider_amount_cents: txn.amount_cents ?? null,
      });
    } else {
      byRef.set(key, txn);
    }
  }
  return findings;
};

export const reconcileOperations = ({ operations = [], providerTxns = [], nowMs } = {}) => {
  const byOpId = new Map();
  const byRef = new Map();
  for (const txn of providerTxns) {
    if (txn.operation_id) byOpId.set(txn.operation_id, txn);
    if (txn.provider_reference) byRef.set(txn.provider_reference, txn);
  }
  const findings = [];
  for (const operation of operations) {
    const txn = byOpId.get(operation.id)
      || (operation.provider_reference ? byRef.get(operation.provider_reference) : null);
    const finding = classifyFinding({ operation, providerTxn: txn, nowMs });
    if (finding) findings.push(finding);
  }
  for (const txn of providerTxns) {
    const matched = operations.some((op) => (
      op.id === txn.operation_id || (txn.provider_reference && op.provider_reference === txn.provider_reference)
    ));
    if (!matched) {
      const finding = classifyFinding({ operation: null, providerTxn: txn, nowMs });
      if (finding) findings.push(finding);
    }
  }
  findings.push(...detectDuplicateProviderTxns(providerTxns));
  return {
    compared: operations.length,
    providerObserved: providerTxns.length,
    findings,
    autoCorrected: false,
  };
};
