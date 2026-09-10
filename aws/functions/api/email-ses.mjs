/**
 * SES deliverability foundation — prepared, not activated.
 * No SNS/EventBridge/webhook subscription in this PR.
 * Tags must never include PII, emails, claim numbers, check numbers, or tokens.
 */

export const SES_MESSAGE_CATEGORIES = Object.freeze([
  'signature_request',
  'endorsement_request',
  'homeowner_link',
  'stakeholder_verification',
  'tenant_invite',
  'payment_direction',
]);

const CATEGORY_SET = new Set(SES_MESSAGE_CATEGORIES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SES_EVENT_TYPES = Object.freeze(['delivery', 'bounce', 'complaint']);

export const sesConfigurationSetName = () => (
  String(process.env.AWS_SES_CONFIGURATION_SET || '').trim() || null
);

export const isSesMessageCategory = (value) => CATEGORY_SET.has(String(value || '').trim());

export const sesMessageTags = ({ tenantId = null, category = null } = {}) => {
  const tags = [];
  const tenant = String(tenantId || '').trim();
  if (UUID_RE.test(tenant)) {
    tags.push({ Name: 'tenant_id', Value: tenant });
  }
  const cat = String(category || '').trim();
  if (CATEGORY_SET.has(cat)) {
    tags.push({ Name: 'message_category', Value: cat });
  }
  return tags;
};

/**
 * Normalize a future SES event notification. Does not subscribe or handle webhooks.
 * Recipient is hashed/omitted — never persist raw recipient addresses here.
 */
export const normalizeSesEngagementEvent = (raw = {}) => {
  const type = String(raw.eventType || raw.type || '').toLowerCase();
  const normalizedType = SES_EVENT_TYPES.includes(type) ? type : 'unknown';
  const tags = raw.mail?.tags || raw.tags || {};
  const tenantId = Array.isArray(tags.tenant_id) ? tags.tenant_id[0] : tags.tenant_id;
  const category = Array.isArray(tags.message_category) ? tags.message_category[0] : tags.message_category;
  return {
    type: normalizedType,
    tenantId: UUID_RE.test(String(tenantId || '')) ? tenantId : null,
    category: CATEGORY_SET.has(String(category || '')) ? category : null,
    timestamp: raw.mail?.timestamp || raw.timestamp || null,
    diagnostic: String(raw.bounce?.bounceType || raw.complaint?.complaintFeedbackType || '').slice(0, 80) || null,
  };
};
