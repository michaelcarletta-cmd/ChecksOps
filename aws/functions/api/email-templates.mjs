/** Lightweight HTML transactional templates (Class A staging). */

export const TEMPLATE_NAMES = new Set([
  'demo-request',
  'stakeholder-verify-account',
  'tenant-invoice',
  'new-homeowner-lead',
  'homeowner-claim-portal-link',
  'homeowner-ledger-invite',
  'homeowner-upload-alert',
  'homeowner-document-shared',
]);

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const shell = (title, bodyHtml) => `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.45;color:#111">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1>
    ${bodyHtml}
    <p style="margin-top:24px;font-size:12px;color:#666">ChecksOps staging notification</p>
  </div>
</body></html>`;

export const renderTransactionalTemplate = (name, data = {}) => {
  switch (name) {
    case 'demo-request':
      return {
        subject: 'ChecksOps demo request',
        html: shell('Demo request', `<p>From: ${esc(data.name)} &lt;${esc(data.email)}&gt;</p><p>${esc(data.message)}</p>`),
        text: `Demo request from ${data.name}: ${data.message}`,
      };
    case 'stakeholder-verify-account':
      return {
        subject: 'Verify your ChecksOps stakeholder account',
        html: shell('Verify account', `<p><a href="${esc(data.verifyUrl)}">Verify account</a></p>`),
        text: `Verify: ${data.verifyUrl}`,
      };
    case 'tenant-invoice':
      return {
        subject: data.subject || 'ChecksOps invoice',
        html: shell('Invoice', `<p>Invoice for ${esc(data.tenantName || 'tenant')}</p><p>Amount: ${esc(data.amount)}</p>`),
        text: `Invoice ${data.amount}`,
      };
    case 'new-homeowner-lead':
      return {
        subject: 'New homeowner lead',
        html: shell('New lead', `<p>Homeowner: ${esc(data.homeownerName)}</p><p>Lead: ${esc(data.leadId)}</p>`),
        text: `New lead ${data.leadId}`,
      };
    case 'homeowner-claim-portal-link':
      return {
        subject: 'Your claim portal link',
        html: shell('Claim portal', `<p>Hi ${esc(data.homeownerName || '')},</p><p><a href="${esc(data.portalUrl)}">Open your claim portal</a></p>`),
        text: `Portal: ${data.portalUrl}`,
      };
    case 'homeowner-ledger-invite':
      return {
        subject: 'Your claim timeline',
        html: shell('Claim timeline', `<p>Hi ${esc(data.homeownerName || '')},</p><p><a href="${esc(data.ledgerUrl)}">View your claim timeline</a></p>`),
        text: `Timeline: ${data.ledgerUrl}`,
      };
    case 'homeowner-upload-alert':
      return {
        subject: 'Homeowner uploaded a document',
        html: shell('Upload alert', `<p>A homeowner uploaded a document for claim ${esc(data.claimId || '')}.</p>`),
        text: `Upload for ${data.claimId}`,
      };
    case 'homeowner-document-shared':
      return {
        subject: 'A document was shared with you',
        html: shell('Document shared', `<p>${esc(data.note || 'A document is ready for you.')}</p><p><a href="${esc(data.url)}">Open document</a></p>`),
        text: `Document: ${data.url}`,
      };
    default:
      return {
        subject: 'ChecksOps notification',
        html: shell('Notification', `<pre>${esc(JSON.stringify(data))}</pre>`),
        text: JSON.stringify(data),
      };
  }
};
