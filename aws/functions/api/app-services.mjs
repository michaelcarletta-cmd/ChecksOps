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
  handleProcessEmailQueue,
  handleEmailSuppression,
  handleResendWebhook,
} from './email-queue.mjs';
import {
  handleCheckOcrIntake,
  handleDetectEndorsementZone,
  handleCheckOcrBacklog,
} from './ocr.mjs';
import {
  handleHomeownerLedgerView,
  handleHomeownerClaimPortal,
  handleHomeownerLedgerUpload,
  handleHomeownerLedgerAttachUpload,
  handleHomeownerLedgerSignLink,
  handleHomeownerLedgerSend,
  handleSendFileToHomeowner,
  handleSendPortalInvite,
  handleGetCheckImageUrls,
  handlePublicContractorDirectory,
  handleLookupPartnerCodePublic,
  handleHomeownerUploadCheck,
} from './homeowner.mjs';
import {
  handleHomeownerUploadOtpStart,
  handleHomeownerUploadOtpVerify,
  handleHomeownerUploadSession,
} from './homeowner-otp.mjs';
import { handleSendSms, handleTelnyxSmsStatus } from './sms.mjs';
import {
  handleGenerateChecksopsDoc,
  handleGenerateDocument,
  handleGeneratePolDocx,
  handleContractsPdf,
  handleRetryPdfGeneration,
  handleGenerateInvoice,
  handleGenerateEndorsementPacket,
  handleCompositeEndorsementSignatures,
} from './documents.mjs';
import {
  handleTenantInviteUser,
  handleCreateTenantUser,
  handleDeleteUser,
  handleGetInstanceUsers,
  handleTenantDomainVerify,
  handleTenantDomainCheck,
  handleTenantDomainRecheckCron,
  handleTenantSetOpenaiKey,
  handleTenantValidateOpenaiKey,
  handleTenantRemoveOpenaiKey,
  handleHireMortgageAgent,
} from './tenant-admin.mjs';
import {
  handleTenantEmailBrandingGet,
  handleTenantEmailBrandingSave,
  handleTenantDomainDisable,
  handleTenantSesIdentityDelete,
  handleTenantEmailPreview,
} from './tenant-email-domain-handlers.mjs';
import { handleIngestSharedCheck } from './ingest-shared-check.mjs';
import { handleSendSignatureRequest } from './esign.mjs';
import { handleCheckEndorsement } from './check-endorsement.mjs';
import { handleCheckReconciliation } from './check-reconciliation.mjs';
import { handleSendPaymentDirectionRequest } from './payment-direction-email.mjs';
import { handleAdminResetTotp } from './admin-reset-totp.mjs';
import { handleBillMortgageHandling } from './bill-mortgage-handling.mjs';
import { handleCheckAltDepositPreflight } from './providers/production/checkalt-preflight.mjs';
import { handleTaxProfiles } from './tax-profiles.mjs';
import {
  handleSaveTenantBillingAccount,
  handleSaveTenantCompanyBranding,
} from './tenant-settings-handlers.mjs';

export const CLASS_A_FUNCTIONS = new Set([
  // Email
  'send-email',
  'send-transactional-email',
  'preview-transactional-email',
  'handle-email-unsubscribe',
  'handle-email-suppression',
  'process-email-queue',
  'resend-webhook',
  'notify-mortgage-handling-request',
  'notify-homeowner-lead',
  'notify-homeowner-lead-accepted',
  'send-portal-invite',
  'send-file-to-homeowner',
  // SMS
  'send-sms',
  'telnyx-sms-status',
  // OCR / docs
  'check-ocr-intake',
  'check-ocr-backlog',
  'detect-endorsement-zone',
  'get-check-image-urls',
  'generate-document',
  'generate-checksops-doc',
  'generate-pol-docx',
  'contracts-pdf',
  'retry-pdf-generation',
  'generate-invoice',
  'generate-endorsement-packet',
  'composite-endorsement-signatures',
  // HomeownerOps (non-financial)
  'homeowner-ledger-view',
  'homeowner-claim-portal',
  'homeowner-ledger-upload',
  'homeowner-ledger-sign-link',
  'homeowner-ledger-send',
  'homeowner-ledger-attach-upload',
  'homeowner-upload-check',
  'ingest-shared-check',
  'send-signature-request',
  'check-endorsement',
  'check-reconciliation',
  'send-payment-direction-request',
  'admin-reset-totp',
  'bill-mortgage-handling',
  'checkalt-deposit-preflight',
  'homeowner-upload-otp-start',
  'homeowner-upload-otp-verify',
  'homeowner-upload-session',
  // Tenant admin / domain / BYOK
  'tenant-invite-user',
  'create-tenant-user',
  'delete-user',
  'get-instance-users',
  'tenant-domain-verify',
  'tenant-domain-check',
  'tenant-domain-recheck-cron',
  'tenant-domain-disable',
  'tenant-email-branding-get',
  'tenant-email-branding-save',
  'tenant-email-preview',
  'tenant-ses-identity-delete',
  'tenant-set-openai-key',
  'tenant-validate-openai-key',
  'tenant-remove-openai-key',
  // Mortgage desk hire (Cognito + identity_accounts)
  'hire-mortgage-agent',
  'tenant-tax-profiles',
  'save-tenant-billing-account',
  'tenant-company-branding-save',
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
    case 'handle-email-suppression':
      return handleEmailSuppression(event);
    case 'process-email-queue':
      return handleProcessEmailQueue(event);
    case 'resend-webhook':
      return handleResendWebhook(event);
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
    case 'send-sms':
      return handleSendSms(event);
    case 'telnyx-sms-status':
      return handleTelnyxSmsStatus(event);
    case 'check-ocr-intake':
      return handleCheckOcrIntake(event);
    case 'check-ocr-backlog':
      return handleCheckOcrBacklog(event);
    case 'detect-endorsement-zone':
      return handleDetectEndorsementZone(event);
    case 'get-check-image-urls':
      return handleGetCheckImageUrls(event);
    case 'generate-document':
      return handleGenerateDocument(event);
    case 'generate-checksops-doc':
      return handleGenerateChecksopsDoc(event);
    case 'generate-pol-docx':
      return handleGeneratePolDocx(event);
    case 'contracts-pdf':
      return handleContractsPdf(event);
    case 'retry-pdf-generation':
      return handleRetryPdfGeneration(event);
    case 'generate-invoice':
      return handleGenerateInvoice(event);
    case 'generate-endorsement-packet':
      return handleGenerateEndorsementPacket(event);
    case 'composite-endorsement-signatures':
      return handleCompositeEndorsementSignatures(event);
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
    case 'homeowner-ledger-attach-upload':
      return handleHomeownerLedgerAttachUpload(event);
    case 'ingest-shared-check':
      return handleIngestSharedCheck(event);
    case 'send-signature-request':
      return handleSendSignatureRequest(event);
    case 'check-endorsement':
      return handleCheckEndorsement(event);
    case 'check-reconciliation':
      return handleCheckReconciliation(event);
    case 'send-payment-direction-request':
      return handleSendPaymentDirectionRequest(event);
    case 'admin-reset-totp':
      return handleAdminResetTotp(event);
    case 'bill-mortgage-handling':
      return handleBillMortgageHandling(event);
    case 'checkalt-deposit-preflight':
      return handleCheckAltDepositPreflight(event);
    case 'homeowner-upload-check':
      return handleHomeownerUploadCheck(event);
    case 'homeowner-upload-otp-start':
      return handleHomeownerUploadOtpStart(event);
    case 'homeowner-upload-otp-verify':
      return handleHomeownerUploadOtpVerify(event);
    case 'homeowner-upload-session':
      return handleHomeownerUploadSession(event);
    case 'tenant-invite-user':
      return handleTenantInviteUser(event);
    case 'create-tenant-user':
      return handleCreateTenantUser(event);
    case 'delete-user':
      return handleDeleteUser(event);
    case 'get-instance-users':
      return handleGetInstanceUsers(event);
    case 'tenant-domain-verify':
      return handleTenantDomainVerify(event);
    case 'tenant-domain-check':
      return handleTenantDomainCheck(event);
    case 'tenant-domain-recheck-cron':
      return handleTenantDomainRecheckCron(event);
    case 'tenant-domain-disable':
      return handleTenantDomainDisable(event);
    case 'tenant-email-branding-get':
      return handleTenantEmailBrandingGet(event);
    case 'tenant-email-branding-save':
      return handleTenantEmailBrandingSave(event);
    case 'tenant-email-preview':
      return handleTenantEmailPreview(event);
    case 'tenant-ses-identity-delete':
      return handleTenantSesIdentityDelete(event);
    case 'tenant-set-openai-key':
      return handleTenantSetOpenaiKey(event);
    case 'tenant-validate-openai-key':
      return handleTenantValidateOpenaiKey(event);
    case 'tenant-remove-openai-key':
      return handleTenantRemoveOpenaiKey(event);
    case 'hire-mortgage-agent':
      return handleHireMortgageAgent(event);
    case 'tenant-tax-profiles':
      return handleTaxProfiles(event);
    case 'save-tenant-billing-account':
      return handleSaveTenantBillingAccount(event);
    case 'tenant-company-branding-save':
      return handleSaveTenantCompanyBranding(event);
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
