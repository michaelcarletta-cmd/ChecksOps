/**
 * Accepted Tenant Email Preview contract.
 *
 * The live production SPA SHA/VersionId recorded here are provenance, not
 * permanent rollback pins. Future overlays start from the then-current live
 * SPA. A change that does not explicitly supersede this contract must
 * preserve it. Do not copy this worktree's esign.mjs into a Lambda package.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EMAIL_PREVIEW_SOURCE_PINS = {
  'src/lib/signatureRequestSender.ts':
    'e7829efd58fdd310ad43f359a3da6f646586cbcbb476c6bc0c33cc2a795bd587',
  'src/components/settings/SignatureRequestEmailPreview.tsx':
    '22c76d610d0743640bda542c64e25a308467fea86525178ec8989d7119f56a91',
};

export const EMAIL_PREVIEW_MOUNT_FILE = 'src/components/settings/TenantBrandingSettings.tsx';

export const R4A_LOGO_RESOLVER_PINS = {
  'src/lib/tenantLogoUrl.ts':
    '4a7d568ba509c7913d1ceb19e7dca1ac8e980cae2749a2ca9f1ef18cd65f41b5',
  'src/components/branding/TenantLogo.tsx':
    'aff9c277cbbffcab018c0bf0959a7a6018e5bb6e56552cc880b28cfa0a498371',
};

export const ACCEPTED_PRODUCTION_SPA = {
  sha256: '58c867a066a32813e47f454aeadf7166c609ca9b7b3bb17be6c9f1a6a71d109b',
  versionId: 'KoqxddGRI3swQom6uSEhLcRASAgwbkR9',
  entry: '/assets/index-BAD1KYoF.js',
  graph: { present: 103, total: 103, missing: 0, html_fallbacks: 0 },
  role: 'current_accepted_provenance_not_rollback_pin',
};

export const HISTORICAL_R4A_SPA = {
  sha256: '6b211037ae70b510a9b5cfe316f006dbbc308ee3c94687ccea943b24cfd09f2e',
  versionId: 'advEv5N0JfqM41odUraOM7kCH6Z2snP3',
  entry: '/assets/index-CS_JpvZg.js',
  role: 'historical_provenance_only',
  must_not_automatically_replace_current: true,
};

export const HISTORICAL_STAGING_PREVIEW_SPA = {
  sha256: '3201c90ca4ca8ae9b1e854fa666b17d8a04c18e01771f358ade2907e95548773',
  role: 'staging_preview_only_never_production_authority',
};

export const ACCEPTED_LIVE_ESIGN = {
  sha256: 'b8f707dfc724a54fb5d973a11cb26380f3381baea26324c08aa30dc93cb5656e',
  lambda: 'checksops-production-prep-api',
  CodeSha256: '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=',
  RevisionId: 'a6a23fc9-a7cb-4e7c-b1c8-db9cb80ea150',
};

export const REJECTED_HISTORICAL_ESIGN_SHA256 =
  '37c5c742f516ce750a402c53214307eee429742e8eed8d4ef9399772516209c5';

export const PLATFORM_SUPPORT_EMAIL = 'support@checksops.com';

export const FORBIDDEN_FROM = Object.freeze([
  'Freedom Adjustment via ChecksOps <support@checksops.com>',
  'Freedom Adjustment <noreply@checksops.com>',
  'ChecksOps <support@checksops.com>',
]);

export const FORBIDDEN_INFRA_MARKERS = Object.freeze([
  'Sending Domain',
  'Sending Subdomain',
  'Sending subdomain',
  'EmailSenderSettings',
  'tenant-domain-verify',
  'tenant-domain-check',
  'tenant-domain-disable',
  'DKIM',
  'SPF',
  'mailFromRecords',
  'dnsRecords',
  'SES identity',
  'Start domain verification',
]);

export const EMAIL_PREVIEW_MARKERS = {
  'src/lib/signatureRequestSender.ts': [
    'PLATFORM_SUPPORT_EMAIL',
    'support@checksops.com',
    'formatSignatureRequestFrom',
    'stripViaChecksOps',
  ],
  'src/components/settings/SignatureRequestEmailPreview.tsx': [
    'data-testid="signature-request-email-preview"',
    'Email Preview',
    'formatSignatureRequestFrom',
    'TenantLogo',
    'PLATFORM_SUPPORT_EMAIL',
  ],
  mount: [
    'SignatureRequestEmailPreview',
    'tenantName={tenant.name',
    'logoUrl={logoUrl}',
    'resolveTenantLogoUrl',
  ],
};

export const FUTURE_OVERLAY_RULES = Object.freeze({
  start_from_then_current_live_spa: true,
  sha_version_are_provenance_not_rollback_pins: true,
  historical_r4a_spa_must_not_auto_replace: true,
  staging_spa_never_production_authority: true,
  changing_protected_preview_files_requires_explicit_allowlist: true,
  preserve_email_preview_unless_explicitly_superseded: true,
  preserve_tenant_isolation: true,
  preserve_signature_sender_contract: true,
  use_guarded_spa_promotion: true,
  prove_production_dataplane: true,
  prove_complete_recursive_asset_graph: true,
  never_copy_worktree_esign_into_lambda: true,
});

const fail = (errors) => ({ ok: false, errors });
const ok = (extra = {}) => ({ ok: true, errors: [], ...extra });

export const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');
export const sha256File = (abs) => sha256Bytes(fs.readFileSync(abs));

export const formatSignatureRequestFrom = (tenantName) => {
  const name = String(tenantName || '').replace(/\s+via\s+ChecksOps\s*$/i, '').trim();
  return `${name} <${PLATFORM_SUPPORT_EMAIL}>`;
};

export const assertMarkers = (source, markers, label) => {
  const text = String(source || '');
  const missing = (markers || []).filter((marker) => !text.includes(marker));
  return missing.length
    ? fail(missing.map((marker) => `${label} missing Email Preview marker: ${marker}`))
    : ok();
};

export const assertAbsent = (source, needles, label) => {
  const text = String(source || '');
  const present = (needles || []).filter((needle) => text.includes(needle));
  return present.length
    ? fail(present.map((needle) => `${label} restored forbidden token: ${needle}`))
    : ok();
};

export const assertFromContract = (tenantName, expected) => {
  const actual = formatSignatureRequestFrom(tenantName);
  const errors = [];
  if (actual !== expected) errors.push(`From ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  if (/via ChecksOps/i.test(actual)) errors.push(`From still contains via ChecksOps: ${actual}`);
  if (/noreply@checksops\.com/i.test(actual)) errors.push(`From uses noreply: ${actual}`);
  if (FORBIDDEN_FROM.includes(actual)) errors.push(`From is a forbidden regression: ${actual}`);
  return errors.length ? fail(errors) : ok({ from: actual });
};

export const assertPreviewSource = (source, extra = {}) => {
  const errors = [];
  errors.push(...assertMarkers(source, EMAIL_PREVIEW_MARKERS['src/lib/signatureRequestSender.ts'], extra.label || 'signatureRequestSender.ts').errors);
  errors.push(...assertAbsent(source, ['noreply@checksops.com', 'via ChecksOps <'], extra.label || 'signatureRequestSender.ts').errors);
  if (extra.hash && extra.hash !== EMAIL_PREVIEW_SOURCE_PINS['src/lib/signatureRequestSender.ts'] && extra.requirePin) {
    errors.push(`${extra.label || 'signatureRequestSender.ts'} hash ${extra.hash} is not the frozen pin`);
  }
  return errors.length ? fail(errors) : ok();
};

export const assertPreviewComponent = (source, extra = {}) => {
  const errors = [];
  errors.push(...assertMarkers(source, EMAIL_PREVIEW_MARKERS['src/components/settings/SignatureRequestEmailPreview.tsx'], extra.label || 'SignatureRequestEmailPreview.tsx').errors);
  errors.push(...assertAbsent(source, ['noreply@checksops.com', 'via ChecksOps', ...FORBIDDEN_INFRA_MARKERS], extra.label || 'SignatureRequestEmailPreview.tsx').errors);
  if (extra.hash && extra.hash !== EMAIL_PREVIEW_SOURCE_PINS['src/components/settings/SignatureRequestEmailPreview.tsx'] && extra.requirePin) {
    errors.push(`${extra.label || 'SignatureRequestEmailPreview.tsx'} hash ${extra.hash} is not the frozen pin`);
  }
  return errors.length ? fail(errors) : ok();
};

export const assertPreviewMount = (source, extra = {}) => {
  const errors = [];
  errors.push(...assertMarkers(source, EMAIL_PREVIEW_MARKERS.mount, extra.label || 'TenantBrandingSettings.tsx').errors);
  errors.push(...assertAbsent(source, FORBIDDEN_INFRA_MARKERS, extra.label || 'TenantBrandingSettings.tsx').errors);
  return errors.length ? fail(errors) : ok();
};

export const assertNoSupabaseRuntime = (source, label) =>
  assertAbsent(source, ['createClient', '@supabase/supabase-js', 'VITE_SUPABASE_URL', 'functions.invoke("tenant-email-preview"'], label);

export const assertHistoricalSpaCannotSatisfy = (candidate) => {
  const sha = candidate?.sha256 || candidate?.hash || null;
  const errors = [];
  if (sha === HISTORICAL_R4A_SPA.sha256) {
    errors.push(`historical R4A SPA ${sha} cannot silently satisfy the accepted Email Preview contract`);
  }
  if (sha === HISTORICAL_STAGING_PREVIEW_SPA.sha256) {
    errors.push(`staging preview SPA ${sha} is never production authority`);
  }
  const text = String(candidate?.source || candidate?.html || candidate?.js || '');
  if (text) {
    const hasPreview = EMAIL_PREVIEW_MARKERS['src/components/settings/SignatureRequestEmailPreview.tsx']
      .every((marker) => text.includes(marker));
    const hasSender = EMAIL_PREVIEW_MARKERS['src/lib/signatureRequestSender.ts']
      .every((marker) => text.includes(marker));
    if (!hasPreview || !hasSender) {
      errors.push('old SPA/source without Email Preview cannot satisfy the current accepted contract');
    }
  }
  if (!errors.length && (sha === HISTORICAL_R4A_SPA.sha256 || sha === HISTORICAL_STAGING_PREVIEW_SPA.sha256)) {
    errors.push('historical bundle cannot become current accepted SPA without an explicit supersede');
  }
  return errors.length ? fail(errors) : fail(['candidate is not a historical Email Preview regression']);
};

export const assertCurrentSpaProvenance = (live) => {
  const errors = [];
  if (live?.sha256 !== ACCEPTED_PRODUCTION_SPA.sha256) {
    errors.push(`live SPA SHA ${live?.sha256} is not the recorded Email Preview provenance ${ACCEPTED_PRODUCTION_SPA.sha256}`);
  }
  if (live?.versionId !== ACCEPTED_PRODUCTION_SPA.versionId) {
    errors.push(`live SPA VersionId ${live?.versionId} is not the recorded provenance`);
  }
  if (live?.entry !== ACCEPTED_PRODUCTION_SPA.entry) {
    errors.push(`live SPA entry ${live?.entry} is not ${ACCEPTED_PRODUCTION_SPA.entry}`);
  }
  if (live?.sha256 === HISTORICAL_R4A_SPA.sha256) {
    errors.push('current live SPA must not roll back to the historical R4A bundle');
  }
  if (live?.sha256 === HISTORICAL_STAGING_PREVIEW_SPA.sha256) {
    errors.push('staging preview SPA must never be treated as production authority');
  }
  return errors.length ? fail(errors) : ok({ provenance: ACCEPTED_PRODUCTION_SPA });
};

export const assertRejectedHistoricalEsign = (hash, source = '') => {
  const errors = [];
  if (hash === REJECTED_HISTORICAL_ESIGN_SHA256) {
    errors.push(`historical pre-fix esign.mjs ${hash} must never become production authority`);
  }
  if (source && !source.includes('signatureRequestFromHeader') && hash === REJECTED_HISTORICAL_ESIGN_SHA256) {
    errors.push('pre-fix esign.mjs lacks signatureRequestFromHeader');
  }
  if (hash === ACCEPTED_LIVE_ESIGN.sha256) return ok();
  return errors.length ? fail(errors) : fail([`esign hash ${hash} is not the accepted live package and is not an explicit historical reject`]);
};

export const assertOverlayAllowlist = ({ changedFiles = [], allowlisted = [], supersede = false }) => {
  const protectedFiles = [
    ...Object.keys(EMAIL_PREVIEW_SOURCE_PINS),
    EMAIL_PREVIEW_MOUNT_FILE,
  ];
  const hits = changedFiles.filter((rel) => protectedFiles.includes(rel));
  const unauthorized = hits.filter((rel) => !allowlisted.includes(rel));
  if (unauthorized.length) {
    return fail(unauthorized.map((rel) => `Email Preview file ${rel} changed without explicit allowlist`));
  }
  if (hits.length && !supersede) {
    return ok({ preserve_required: true, hits });
  }
  return ok({ hits, superseded: Boolean(supersede) });
};

export const assertCompleteGraph = (graph) => {
  const present = Number(graph?.present ?? graph?.present_count);
  const total = Number(graph?.total ?? graph?.object_count);
  const missing = Number(graph?.missing ?? graph?.missing_count);
  const fallbacks = Number(graph?.html_fallbacks ?? graph?.html_fallback_count);
  const errors = [];
  if (present !== total || total < 1) errors.push(`incomplete SPA graph ${present}/${total}`);
  if (missing !== 0) errors.push(`SPA graph missing ${missing}`);
  if (fallbacks !== 0) errors.push(`SPA graph HTML fallbacks ${fallbacks}`);
  return errors.length ? fail(errors) : ok({ graph: `${present}/${total}` });
};

export const assertEmailPreviewSourcePins = (root) => {
  const errors = [];
  for (const [rel, expected] of Object.entries(EMAIL_PREVIEW_SOURCE_PINS)) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath)) {
      errors.push(`accepted Email Preview file missing: ${rel}`);
      continue;
    }
    const body = fs.readFileSync(filePath);
    const hash = sha256Bytes(body);
    if (hash !== expected) errors.push(`${rel} hash ${hash} != frozen ${expected}`);
    if (rel.endsWith('signatureRequestSender.ts')) {
      errors.push(...assertPreviewSource(body.toString('utf8'), { hash, requirePin: true }).errors);
    } else {
      errors.push(...assertPreviewComponent(body.toString('utf8'), { hash, requirePin: true }).errors);
    }
    errors.push(...assertNoSupabaseRuntime(body.toString('utf8'), rel).errors);
  }
  const mountPath = path.join(root, EMAIL_PREVIEW_MOUNT_FILE);
  if (!fs.existsSync(mountPath)) {
    errors.push(`Email Preview mount file missing: ${EMAIL_PREVIEW_MOUNT_FILE}`);
  } else {
    errors.push(...assertPreviewMount(fs.readFileSync(mountPath, 'utf8')).errors);
  }
  for (const [rel, expected] of Object.entries(R4A_LOGO_RESOLVER_PINS)) {
    const filePath = path.join(root, rel);
    const hash = sha256File(filePath);
    if (hash !== expected) errors.push(`${rel} hash ${hash} != accepted R4A pin ${expected}`);
  }
  return errors.length ? fail(errors) : ok();
};
