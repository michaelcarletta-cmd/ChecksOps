const DROP_KEYS = /account_number|routing_number|secret|password|token|authorization|ssn|dob|bank_account|iban|plaid_access|kyc|document_bytes|image_base64/i;

export const sanitizeAuditDetails = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditDetails(item));
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (DROP_KEYS.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeAuditDetails(nested);
  }
  return out;
};

export const auditRow = ({
  applicationUserId,
  tenantId,
  operationType,
  operationId,
  amountCents,
  provider,
  providerReference,
  outcome,
  idempotencyKey,
  details,
} = {}) => ({
  application_user_id: applicationUserId || null,
  tenant_id: tenantId || null,
  operation_type: operationType || null,
  operation_id: operationId || null,
  amount_cents: amountCents ?? null,
  provider: provider || null,
  provider_reference: providerReference || null,
  outcome: outcome || 'unknown',
  idempotency_key: idempotencyKey || null,
  details: sanitizeAuditDetails(details) || {},
});
