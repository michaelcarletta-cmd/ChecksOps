/**
 * Class A application-service dispatcher.
 * Routes former Supabase Edge Function names to AWS-native handlers
 * BEFORE the catch-all provider_disabled stub.
 */
import { parseBody, ignoredSpoof } from './data.mjs';
import {
  handleSendTransactionalEmail,
  handleSendEmail,
  handleEmailUnsubscribe,
  handlePreviewTransactionalEmail,
  handleNotifyMortgageHandlingRequest,
  handleNotifyHomeownerLead,
  handleNotifyHomeownerLeadAccepted,
} from './email.mjs';
import {
  handleCheckOcrIntake,
  handleDetectEndorsementZone,
  handleCheckOcrBacklog,
} from './ocr.mjs';
import {
  handleHomeownerLedgerView,
  handleHomeownerClaimPortal,
  handleHomeownerLedgerUpload,
  handleHomeownerLedgerSignLink,
  handleHomeownerLedgerSend,
  handleSendFileToHomeowner,
  handleSendPortalInvite,
  handleGetCheckImageUrls,
  handlePublicContractorDirectory,
  handleLookupPartnerCodePublic,
  handleHomeownerUploadCheck,
} from './homeowner.mjs';

export const CLASS_A_FUNCTIONS = new Set([
  // Email
  'send-email',
  'send-transactional-email',
  'preview-transactional-email',
  'handle-email-unsubscribe',
  'notify-mortgage-handling-request',
  'notify-homeowner-lead',
  'notify-homeowner-lead-accepted',
  'send-portal-invite',
  'send-file-to-homeowner',
  // OCR / docs
  'check-ocr-intake',
  'check-ocr-backlog',
  'detect-endorsement-zone',
  'get-check-image-urls',
  // HomeownerOps (non-financial)
  'homeowner-ledger-view',
  'homeowner-claim-portal',
  'homeowner-ledger-upload',
  'homeowner-ledger-sign-link',
  'homeowner-ledger-send',
  'homeowner-upload-check',
  // Public directory
  'public-contractor-directory',
  'lookup-partner-code-public',
  'contractor-directory-search',
]);

export const functionNameFromPath = (path) => {
  const match = String(path || '').match(/^\/functions(?:\/v1)?\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const notYet = (name, spoof, note) => ({
  ok: false,
  statusCode: 501,
  error: 'class_a_pending',
  message: note || `${name} is Class A but not fully ported in this batch`,
  name,
  spoofFieldsIgnored: spoof,
});

export const handleAppServiceRequest = async (event, path, method) => {
  const name = functionNameFromPath(path);
  if (!name || !CLASS_A_FUNCTIONS.has(name)) return null;

  const upper = String(method || 'POST').toUpperCase();
  if (upper === 'OPTIONS') {
    return { ok: true, statusCode: 200, cors: true };
  }

  // GET unsubscribe validation
  if (name === 'handle-email-unsubscribe' && (upper === 'GET' || upper === 'POST')) {
    return handleEmailUnsubscribe(event);
  }

  switch (name) {
    case 'send-transactional-email':
      return handleSendTransactionalEmail(event);
    case 'send-email':
      return handleSendEmail(event);
    case 'preview-transactional-email':
      return handlePreviewTransactionalEmail(event);
    case 'notify-mortgage-handling-request':
      return handleNotifyMortgageHandlingRequest(event);
    case 'notify-homeowner-lead':
      return handleNotifyHomeownerLead(event);
    case 'notify-homeowner-lead-accepted':
      return handleNotifyHomeownerLeadAccepted(event);
    case 'send-portal-invite':
      return handleSendPortalInvite(event);
    case 'send-file-to-homeowner':
      return handleSendFileToHomeowner(event);
    case 'check-ocr-intake':
      return handleCheckOcrIntake(event);
    case 'check-ocr-backlog':
      return handleCheckOcrBacklog(event);
    case 'detect-endorsement-zone':
      return handleDetectEndorsementZone(event);
    case 'get-check-image-urls':
      return handleGetCheckImageUrls(event);
    case 'homeowner-ledger-view':
      return handleHomeownerLedgerView(event);
    case 'homeowner-claim-portal':
      return handleHomeownerClaimPortal(event);
    case 'homeowner-ledger-upload':
      return handleHomeownerLedgerUpload(event);
    case 'homeowner-ledger-sign-link':
      return handleHomeownerLedgerSignLink(event);
    case 'homeowner-ledger-send':
      return handleHomeownerLedgerSend(event);
    case 'homeowner-upload-check':
      return handleHomeownerUploadCheck(event);
    case 'public-contractor-directory':
    case 'contractor-directory-search':
      return handlePublicContractorDirectory(event);
    case 'lookup-partner-code-public':
      return handleLookupPartnerCodePublic(event);
    default: {
      const spoof = ignoredSpoof(event, parseBody(event));
      return notYet(name, spoof);
    }
  }
};
