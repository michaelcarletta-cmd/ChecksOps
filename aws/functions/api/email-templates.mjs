/** ChecksOps transactional templates rendered through the shared layout. */

import { renderChecksOpsEmail, escapeHtml } from './email-layout.mjs';
import { PLATFORM_PRIMARY_COLOR } from './email-branding.mjs';

export const TEMPLATE_NAMES = new Set([
  'demo-request',
  'stakeholder-verify-account',
  'tenant-invoice',
  'new-homeowner-lead',
  'homeowner-claim-portal-link',
  'homeowner-ledger-invite',
  'homeowner-upload-alert',
  'homeowner-document-shared',
  'generic_notification',
  'generic-notification',
  'internal-notification',
  'mortgage-handling-request',
  'endorsement-request',
  'payment-direction-request',
  'tenant-user-invite',
  'mortgage-agent-invite',
  'homeowner-upload-otp',
  'portal-invite',
]);

const brandingOf = (data = {}) => data.branding || {};

const layoutFrom = (data, fields) => renderChecksOpsEmail({
  companySubtitle: brandingOf(data).companySubtitle || data.companyName || null,
  primaryColor: brandingOf(data).primaryColor || PLATFORM_PRIMARY_COLOR,
  logoUrl: brandingOf(data).logoUrl || null,
  unsubscribeUrl: data.unsubscribeUrl || null,
  ...fields,
});

export const renderTransactionalTemplate = (name, data = {}) => {
  switch (name) {
    case 'demo-request': {
      const layout = layoutFrom(data, {
        title: 'ChecksOps demo request',
        preview: `Demo request from ${data.name || 'a prospect'}`,
        paragraphs: [
          `From: ${data.name || ''} <${data.email || ''}>`,
          data.company ? `Company: ${data.company}` : null,
          data.role ? `Role: ${data.role}` : null,
          data.message || data.notes || null,
        ].filter(Boolean),
      });
      return { subject: 'ChecksOps demo request', ...layout };
    }
    case 'stakeholder-verify-account': {
      const layout = layoutFrom(data, {
        title: 'Verify your ChecksOps payment account',
        greeting: data.custname ? `Hi ${data.custname},` : 'Hi,',
        paragraphs: [
          data.nickname
            ? `To receive ACH payments for ${data.nickname}, securely link your bank account.`
            : 'To start receiving ACH payments, securely link your bank account.',
          'Your details go to our regulated payments partner. ChecksOps never stores your full account number.',
        ],
        ctaLabel: 'Link bank account',
        ctaUrl: data.verifyUrl,
        fallbackUrl: data.verifyUrl,
        expiresText: data.expiresText || 'This link expires in 30 days.',
      });
      return { subject: 'Verify your bank account with ChecksOps', ...layout };
    }
    case 'tenant-invoice': {
      const layout = layoutFrom(data, {
        title: 'ChecksOps invoice',
        paragraphs: [
          `Invoice for ${data.tenantName || 'tenant'}`,
          data.amount != null ? `Amount: ${data.amount}` : null,
        ].filter(Boolean),
      });
      return { subject: data.subject || 'ChecksOps invoice', ...layout };
    }
    case 'new-homeowner-lead': {
      const layout = layoutFrom(data, {
        title: 'New homeowner lead',
        paragraphs: [
          `Homeowner: ${data.homeownerName || ''}`,
          data.leadId ? `Lead: ${data.leadId}` : null,
        ].filter(Boolean),
      });
      return { subject: 'New homeowner lead', ...layout };
    }
    case 'homeowner-claim-portal-link': {
      const layout = layoutFrom(data, {
        title: 'Your claim portal is ready',
        greeting: data.homeownerName ? `Hi ${data.homeownerName},` : 'Hi,',
        paragraphs: ['Open your secure claim portal to continue.'],
        ctaLabel: 'Open claim portal',
        ctaUrl: data.portalUrl,
        fallbackUrl: data.portalUrl,
      });
      return { subject: 'Your claim portal link', ...layout };
    }
    case 'homeowner-ledger-invite': {
      const layout = layoutFrom(data, {
        title: data.is_pre_claim ? 'Send us your insurance check' : 'Your claim timeline',
        greeting: data.homeownerName || data.homeowner_name ? `Hi ${data.homeownerName || data.homeowner_name},` : 'Hi,',
        paragraphs: [
          data.is_pre_claim
            ? 'Use the secure link below to upload the front and back of your insurance check.'
            : 'View every check, endorsement, deposit, and dollar released — updated as work happens.',
        ],
        ctaLabel: data.is_pre_claim ? 'Upload my check' : 'View claim timeline',
        ctaUrl: data.ledgerUrl || data.portal_url,
        fallbackUrl: data.ledgerUrl || data.portal_url,
      });
      return {
        subject: data.is_pre_claim ? 'Send us your insurance check' : 'Your claim timeline',
        ...layout,
      };
    }
    case 'homeowner-upload-alert': {
      const layout = layoutFrom(data, {
        title: 'Homeowner uploaded a document',
        paragraphs: [
          data.homeowner_name || data.homeownerName
            ? `${data.homeowner_name || data.homeownerName} uploaded a document.`
            : 'A homeowner uploaded a document.',
          data.claimId ? `Claim: ${data.claimId}` : null,
          data.homeowner_note ? `Note: ${data.homeowner_note}` : null,
        ].filter(Boolean),
        ctaLabel: data.inbox_url ? 'Open ChecksOps' : null,
        ctaUrl: data.inbox_url || null,
        fallbackUrl: data.inbox_url || null,
      });
      return { subject: 'Homeowner uploaded a document', ...layout };
    }
    case 'homeowner-document-shared': {
      const layout = layoutFrom(data, {
        title: 'A document was shared with you',
        greeting: data.homeowner_name || data.homeownerName ? `Hi ${data.homeowner_name || data.homeownerName},` : 'Hi,',
        paragraphs: [
          data.note || data.document_name
            ? (data.note || `Document: ${data.document_name}`)
            : 'A document is ready for you.',
        ],
        ctaLabel: 'Open document',
        ctaUrl: data.url || data.document_url || data.portal_url,
        fallbackUrl: data.url || data.document_url || data.portal_url,
      });
      return {
        subject: data.document_name ? `New document: ${data.document_name}` : 'A document was shared with you',
        ...layout,
      };
    }
    case 'generic_notification':
    case 'generic-notification':
    case 'internal-notification': {
      const layout = layoutFrom(data, {
        title: data.subject || 'ChecksOps notification',
        paragraphs: [data.message || data.body || ''],
      });
      return { subject: data.subject || 'ChecksOps notification', ...layout };
    }
    case 'mortgage-handling-request': {
      const layout = layoutFrom(data, {
        title: 'Mortgage handling request',
        paragraphs: [
          data.mortgageCompany || data.mortgage_company ? `Company: ${data.mortgageCompany || data.mortgage_company}` : null,
          data.status ? `Status: ${data.status}` : null,
          `Request: ${data.requestId || data.request_id || ''}`,
        ].filter(Boolean),
      });
      return { subject: `Mortgage handling request ${data.requestId || data.request_id || ''}`.trim(), ...layout };
    }
    case 'endorsement-request': {
      const layout = layoutFrom(data, {
        title: 'Endorsement required',
        greeting: data.payeeName ? `Hello ${data.payeeName},` : 'Hello,',
        paragraphs: [
          `Check #${data.checkNumber || 'N/A'} from ${data.carrier || 'the carrier'} needs your endorsement.`,
          data.amount != null && data.amount !== '' ? `Amount: ${data.amount}` : null,
        ].filter(Boolean),
        ctaLabel: 'Review and endorse',
        ctaUrl: data.endorseUrl,
        fallbackUrl: data.endorseUrl,
      });
      return {
        subject: data.subject || `Endorsement required — Check #${data.checkNumber || 'N/A'}`,
        ...layout,
      };
    }
    case 'payment-direction-request': {
      const layout = layoutFrom(data, {
        title: 'Payment direction needed',
        greeting: data.policyholderName ? `Dear ${data.policyholderName},` : 'Dear Policyholder,',
        paragraphs: [
          'Please tell us how you want funds handled so we can move your claim forward.',
          data.claimNumber ? `Claim: ${data.claimNumber}` : null,
          data.carrier ? `Carrier: ${data.carrier}` : null,
        ].filter(Boolean),
        ctaLabel: 'Respond now',
        ctaUrl: data.requestUrl,
        fallbackUrl: data.requestUrl,
      });
      return {
        subject: data.subject || 'Payment direction needed for your insurance check',
        ...layout,
      };
    }
    case 'tenant-user-invite': {
      const layout = layoutFrom(data, {
        title: `You're invited to ${data.tenantName || 'ChecksOps'}`,
        paragraphs: [
          `You have been invited as ${data.role || 'a member'}.`,
          'Sign in with a passwordless email code.',
        ],
        ctaLabel: 'Sign in',
        ctaUrl: data.loginUrl,
        fallbackUrl: data.loginUrl,
      });
      return { subject: `You're invited to ${data.tenantName || 'ChecksOps'}`, ...layout };
    }
    case 'mortgage-agent-invite': {
      const layout = layoutFrom(data, {
        title: 'You have access to ChecksOps Mortgage Ops',
        greeting: data.fullName ? `Hi ${data.fullName},` : 'Hi,',
        paragraphs: [
          'Your Mortgage Ops account is ready. Sign in with a passwordless email code.',
        ],
        ctaLabel: 'Sign in to Mortgage Ops',
        ctaUrl: data.loginUrl,
        fallbackUrl: data.loginUrl,
      });
      return { subject: "You're invited to ChecksOps Mortgage Ops", ...layout };
    }
    case 'homeowner-upload-otp': {
      const code = String(data.code || '');
      const layout = layoutFrom(data, {
        title: 'Your ChecksOps upload code',
        paragraphs: [
          'Use this one-time code to authorize a document upload. It does not create a ChecksOps login.',
        ],
        bodyHtml: `<p style="margin:16px 0;font-size:28px;letter-spacing:6px;font-weight:700;color:#0f172a;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(code)}</p>`,
        expiresText: 'This code expires in 15 minutes.',
      });
      return { subject: 'Your ChecksOps upload code', ...layout };
    }
    case 'portal-invite': {
      const layout = layoutFrom(data, {
        title: `Your ${data.tenantName || 'ChecksOps'} portal`,
        greeting: data.userName ? `Hello ${data.userName},` : 'Hello,',
        paragraphs: [
          data.userType
            ? `Your ${data.userType} portal account is ready. Sign in with a passwordless email code.`
            : 'Your portal account is ready. Sign in with a passwordless email code.',
        ],
        ctaLabel: 'Open portal',
        ctaUrl: data.loginUrl || data.portalUrl,
        fallbackUrl: data.loginUrl || data.portalUrl,
      });
      return {
        subject: data.subject || `Your ${data.tenantName || 'ChecksOps'} portal invite`,
        ...layout,
      };
    }
    default: {
      const layout = layoutFrom(data, {
        title: 'ChecksOps notification',
        paragraphs: [JSON.stringify(data)],
      });
      return { subject: 'ChecksOps notification', ...layout };
    }
  }
};
