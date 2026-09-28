import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveTenantLogoUrl } from "../src/lib/tenantLogoUrl.ts";
import {
  PLATFORM_SUPPORT_EMAIL,
  formatSignatureRequestFrom,
  signatureRequestSubject,
} from "../src/lib/signatureRequestSender.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sha256 = (rel) => createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");

const PREVIEW = "src/components/settings/SignatureRequestEmailPreview.tsx";
const BRANDING = "src/components/settings/TenantBrandingSettings.tsx";
const SETTINGS = "src/components/white-label/WhiteLabelSettings.tsx";
const ADMIN = "src/pages/admin/AdminTenants.tsx";
const RESOLVER = "src/lib/tenantLogoUrl.ts";
const LOGO = "src/components/branding/TenantLogo.tsx";
const SENDER = "src/lib/signatureRequestSender.ts";

const UNTOUCHED_BACKEND = {
  "aws/functions/api/esign.mjs": "37c5c742f516ce750a402c53214307eee429742e8eed8d4ef9399772516209c5",
  "aws/functions/api/email.mjs": "e7ff4c1aa46cfd90d188e3ed56a7a066f62b5c79a3a77b45be013d9bf384adac",
};

const UNTOUCHED_IMAGE_COMPAT = {
  "src/lib/checkImageInvariants.ts": "41a42c8df6f61b52b2683a300310c3f0498531ee991c5492347e216dc418d802",
  "src/pages/CheckCommandCenter.tsx": "32436906507f3e8f183a0f393dd43ea66bd7eeb4dd2fca33087e737a6b7984d4",
};

const UNTOUCHED_R4A_TENANT_LOGO = {
  "src/components/branding/TenantLogo.tsx": "aff9c277cbbffcab018c0bf0959a7a6018e5bb6e56552cc880b28cfa0a498371",
};

test("Freedom preview From uses tenant name and support@checksops.com", () => {
  assert.equal(
    formatSignatureRequestFrom("Freedom Adjustment"),
    "Freedom Adjustment <support@checksops.com>",
  );
  assert.equal(PLATFORM_SUPPORT_EMAIL, "support@checksops.com");
});

test("preview From never appends via ChecksOps or uses noreply", () => {
  const from = formatSignatureRequestFrom("Freedom Adjustment via ChecksOps");
  assert.equal(from, "Freedom Adjustment <support@checksops.com>");
  assert.doesNotMatch(from, /via ChecksOps/);
  assert.doesNotMatch(from, /noreply@checksops\.com/);
  assert.notEqual(from, "Freedom Adjustment via ChecksOps <support@checksops.com>");
  assert.notEqual(from, "ChecksOps <support@checksops.com>");
  assert.notEqual(from, "Freedom Adjustment <noreply@checksops.com>");
});

test("another tenant previews its own name", () => {
  assert.equal(
    formatSignatureRequestFrom("Condition One Commercial"),
    "Condition One Commercial <support@checksops.com>",
  );
  assert.notEqual(
    formatSignatureRequestFrom("Condition One Commercial"),
    formatSignatureRequestFrom("Freedom Adjustment"),
  );
});

test("representative subject uses the existing signature-request template", () => {
  assert.equal(signatureRequestSubject("Release"), "Action Required: Sign Release");
});

test("preview is mounted in Branding & Appearance and uses the R4A logo resolver", () => {
  const branding = read(BRANDING);
  const preview = read(PREVIEW);
  const settings = read(SETTINGS);
  const logo = read(LOGO);
  const resolver = read(RESOLVER);
  const sender = read(SENDER);

  assert.match(settings, /<TenantBrandingSettings tenant=\{tenant\} \/>/);
  assert.match(branding, /SignatureRequestEmailPreview/);
  assert.match(branding, /tenantName=\{tenant\.name/);
  assert.match(preview, /data-testid="signature-request-email-preview"/);
  assert.match(preview, /formatSignatureRequestFrom/);
  assert.match(preview, /TenantLogo/);
  assert.match(preview, /resolveTenantLogoUrl|TenantLogo/);
  assert.match(preview, /Sent by ChecksOps/);
  assert.match(preview, /Review and sign/);
  assert.match(logo, /resolveTenantLogoUrl/);
  assert.match(resolver, /export function resolveTenantLogoUrl/);
  assert.match(sender, /support@checksops\.com/);
  assert.doesNotMatch(sender, /noreply@checksops\.com/);
  assert.doesNotMatch(preview, /noreply@checksops\.com/);
  assert.doesNotMatch(preview, /via ChecksOps/);
});

test("missing logo still uses the existing R4A fallback", () => {
  assert.equal(resolveTenantLogoUrl("", "/prep"), null);
  assert.equal(resolveTenantLogoUrl(null, "/prep"), null);
  const preview = read(PREVIEW);
  assert.match(preview, /fallback=\{<div className="text-sm font-medium text-slate-700">\{displayName\}<\/div>\}/);
});

test("no Sending-domain, DNS, SES, or verification controls are restored", () => {
  const files = [read(BRANDING), read(PREVIEW), read(SETTINGS), read(ADMIN), read(SENDER)];
  for (const src of files) {
    assert.doesNotMatch(src, /EmailSenderSettings/);
    assert.doesNotMatch(src, /Sending subdomain/);
    assert.doesNotMatch(src, /Sending Domain/);
    assert.doesNotMatch(src, /tenant-domain-verify|tenant-domain-check|tenant-domain-disable/);
    assert.doesNotMatch(src, /DKIM|SPF/);
    assert.doesNotMatch(src, /domain verification|Start domain verification/i);
    assert.doesNotMatch(src, /mailFromRecords|dnsRecords/);
    assert.doesNotMatch(src, /SES identity|ses identity/i);
  }
  assert.doesNotMatch(read(SETTINGS), /CompanyBrandingSettings/);
});

test("preview does not introduce a Supabase runtime dependency", () => {
  const preview = read(PREVIEW);
  const sender = read(SENDER);
  const resolver = read(RESOLVER);
  for (const src of [preview, sender, resolver]) {
    assert.doesNotMatch(src, /createClient/);
    assert.doesNotMatch(src, /@supabase\/supabase-js/);
    assert.doesNotMatch(src, /VITE_SUPABASE_URL/);
    assert.doesNotMatch(src, /functions\.invoke\("tenant-email-preview"/);
  }
});

test("R4A logo resolver contract and TenantLogo stay intact", () => {
  for (const [rel, expected] of Object.entries(UNTOUCHED_R4A_TENANT_LOGO)) {
    assert.equal(sha256(rel), expected, `${rel} must remain the accepted TenantLogo`);
  }
  const resolver = read(RESOLVER);
  assert.match(resolver, /export function resolveTenantLogoUrl/);
  assert.match(resolver, /canonicalStoredTenantLogo/);
  assert.match(resolver, /\/storage\/public\?bucket=/);
  const branding = read(BRANDING);
  assert.match(branding, /resolveTenantLogoUrl\(logoUrl\)/);
  assert.match(branding, /<TenantLogo src=\{logoUrl\}/);
  assert.match(branding, /<SignatureRequestEmailPreview/);
  assert.match(branding, /logoUrl=\{logoUrl\}/);
  const emailBranding = read("aws/functions/api/email-branding.mjs");
  assert.match(emailBranding, /resolveEmailTenantLogoUrl/);
  assert.doesNotMatch(emailBranding, /safeHttpUrl\(tenant\.logo_url\)/);
});

test("protected backend and Claim Check files stay byte-identical", () => {
  for (const [rel, expected] of Object.entries({ ...UNTOUCHED_BACKEND, ...UNTOUCHED_IMAGE_COMPAT })) {
    assert.equal(sha256(rel), expected, `${rel} must remain untouched`);
  }
});
