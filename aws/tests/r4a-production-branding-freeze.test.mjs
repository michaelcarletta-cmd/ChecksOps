import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveTenantLogoUrl } from "../../src/lib/tenantLogoUrl.ts";

const settings = readFileSync(new URL("../../src/components/white-label/WhiteLabelSettings.tsx", import.meta.url), "utf8");
const branding = readFileSync(new URL("../../src/components/settings/TenantBrandingSettings.tsx", import.meta.url), "utf8");
const logo = readFileSync(new URL("../../src/components/branding/TenantLogo.tsx", import.meta.url), "utf8");
const resolver = readFileSync(new URL("../../src/lib/tenantLogoUrl.ts", import.meta.url), "utf8");
const admin = readFileSync(new URL("../../src/pages/admin/AdminTenants.tsx", import.meta.url), "utf8");
const freeze = JSON.parse(readFileSync(new URL("../audit/post-image-production-freeze.json", import.meta.url), "utf8"));

test("R4A relative logo paths resolve through production /prep public storage", () => {
  const url = resolveTenantLogoUrl("freedom/logo.png", "/prep");
  assert.equal(url, "/prep/storage/public?bucket=tenant-logos&path=freedom%2Flogo.png");
  assert.equal(url.includes("supabase"), false);
});

test("R4A keeps valid absolute logos and rewrites legacy Supabase public URLs", () => {
  const abs = "https://cdn.example.com/logo.png";
  assert.equal(resolveTenantLogoUrl(abs, "/prep"), abs);
  const legacy = "https://nbcqwpysqgyxrrbgtmkw.supabase.co/storage/v1/object/public/tenant-logos/freedom/logo.png";
  const rewritten = resolveTenantLogoUrl(legacy, "/prep");
  assert.match(rewritten, /\/prep\/storage\/public\?bucket=tenant-logos/);
  assert.equal(rewritten.includes("supabase.co"), false);
});

test("R4A missing logo is fallback and page-relative escape is rejected", () => {
  assert.equal(resolveTenantLogoUrl("", "/prep"), null);
  assert.equal(resolveTenantLogoUrl("../escape.png", "/prep"), null);
});

test("R4A BrandingSettings stays mounted and Sending-domain UI stays removed", () => {
  assert.match(settings, /<TenantBrandingSettings tenant=\{tenant\} \/>/);
  assert.match(branding, /data-testid="tenant-branding-settings"/);
  assert.doesNotMatch(settings, /CompanyBrandingSettings/);
  assert.doesNotMatch(settings, /EmailSenderSettings/);
  assert.doesNotMatch(settings, /Sending subdomain/);
  assert.doesNotMatch(admin, /EmailSenderSettings/);
  assert.match(logo, /resolveTenantLogoUrl/);
});

test("R4A resolver does not restore Supabase SDK usage", () => {
  assert.doesNotMatch(resolver, /createClient/);
  assert.doesNotMatch(resolver, /@supabase\/supabase-js/);
  assert.doesNotMatch(resolver, /VITE_SUPABASE_URL/);
});

test("freeze records the accepted R4A SPA and forbids silent restore", () => {
  assert.equal(freeze.accepted_r4a_branding.status, "PRODUCTION_ACCEPTED");
  assert.deepEqual(freeze.accepted_r4a_branding.contract.forbidden_restore, [
    "page-relative tenant logo URLs",
    "CompanyBrandingSettings on tenant branding tab",
    "EmailSenderSettings / Sending-domain UI",
    "Supabase logo resolution",
  ]);
  assert.equal(freeze.safeguards.reject_page_relative_tenant_logos, true);
  assert.equal(freeze.safeguards.require_tenant_branding_settings, true);
  assert.equal(freeze.safeguards.reject_sending_domain_ui, true);
});
