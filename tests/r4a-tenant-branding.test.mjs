import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTenantLogoUrl, rewriteTenantLogoUrl } from "../src/lib/tenantLogoUrl.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging";
const PREP = "/prep";

test("relative tenant logo path resolves through the AWS public resolver", () => {
  const url = resolveTenantLogoUrl("freedom/logo.png", API);
  assert.equal(
    url,
    `${API}/storage/public?bucket=tenant-logos&path=${encodeURIComponent("freedom/logo.png")}`,
  );
  const uuidPath = resolveTenantLogoUrl("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/logo-1.png", PREP);
  assert.equal(
    uuidPath,
    `/prep/storage/public?bucket=tenant-logos&path=${encodeURIComponent("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/logo-1.png")}`,
  );
  const prefixed = resolveTenantLogoUrl("files/tenant-logos/freedom/logo.png", API);
  assert.equal(
    prefixed,
    `${API}/storage/public?bucket=tenant-logos&path=${encodeURIComponent("freedom/logo.png")}`,
  );
});

test("already-valid absolute logo URLs stay usable", () => {
  const cdn = "https://cdn.example.com/logos/freedom.png";
  assert.equal(resolveTenantLogoUrl(cdn, API), cdn);
  const aws = `${API}/storage/public?bucket=tenant-logos&path=freedom%2Flogo.png`;
  assert.equal(resolveTenantLogoUrl(aws, API), aws);
  const data = "data:image/png;base64,aaa";
  assert.equal(resolveTenantLogoUrl(data, API), data);
});

test("legacy Supabase logo URLs rewrite to AWS public storage and never stay on supabase.co", () => {
  const supabase = "https://nbcqwpysqgyxrrbgtmkw.supabase.co/storage/v1/object/public/tenant-logos/freedom/logo.png";
  const resolved = resolveTenantLogoUrl(supabase, API);
  assert.match(resolved, /\/storage\/public\?bucket=tenant-logos/);
  assert.equal(resolved.includes("supabase.co"), false);
  assert.equal(resolved.includes("supabase"), false);
});

test("missing or unusable logo uses fallback (null)", () => {
  assert.equal(resolveTenantLogoUrl(null, API), null);
  assert.equal(resolveTenantLogoUrl("", API), null);
  assert.equal(resolveTenantLogoUrl("   ", API), null);
  assert.equal(resolveTenantLogoUrl("../escape.png", API), null);
});

test("another tenant's branding stays isolated", () => {
  const freedom = resolveTenantLogoUrl("freedom/logo.png", API);
  const other = resolveTenantLogoUrl("acme/logo.png", API);
  assert.notEqual(freedom, other);
  assert.match(freedom, /freedom%2Flogo\.png/);
  assert.match(other, /acme%2Flogo\.png/);
  assert.notEqual(
    rewriteTenantLogoUrl("freedom/logo.png", API),
    rewriteTenantLogoUrl("acme/logo.png", API),
  );
  const storage = fs.readFileSync(path.join(ROOT, "src/integrations/aws/storage.ts"), "utf8");
  assert.match(storage, /rewriteTenantLogoUrl/);
  assert.match(storage, /\^\(logo_url\|logoUrl\)\$/);
});

test("tenant BrandingSettings is mounted in tenant settings and sending-domain UI is gone", () => {
  const settings = fs.readFileSync(path.join(ROOT, "src/components/white-label/WhiteLabelSettings.tsx"), "utf8");
  const branding = fs.readFileSync(path.join(ROOT, "src/components/settings/TenantBrandingSettings.tsx"), "utf8");
  const admin = fs.readFileSync(path.join(ROOT, "src/pages/admin/AdminTenants.tsx"), "utf8");
  assert.match(settings, /TenantBrandingSettings/);
  assert.match(settings, /<TenantBrandingSettings tenant=\{tenant\} \/>/);
  assert.doesNotMatch(settings, /CompanyBrandingSettings/);
  assert.doesNotMatch(settings, /EmailSenderSettings/);
  assert.doesNotMatch(settings, /Sending subdomain/);
  assert.doesNotMatch(settings, /sending_domain|sendingDomain/);
  assert.doesNotMatch(admin, /EmailSenderSettings/);
  assert.doesNotMatch(admin, /Sending subdomain/);
  assert.match(branding, /data-testid="tenant-branding-settings"/);
  assert.match(branding, /\.eq\("id", tenant\.id\)/);
  assert.match(branding, /from\("tenant-logos"\)/);
});

test("Freedom login and header still render TenantLogo", () => {
  const login = fs.readFileSync(path.join(ROOT, "src/components/white-label/WhiteLabelLogin.tsx"), "utf8");
  const header = fs.readFileSync(path.join(ROOT, "src/components/white-label/WhiteLabelCheckCenter.tsx"), "utf8");
  const settings = fs.readFileSync(path.join(ROOT, "src/components/white-label/WhiteLabelSettings.tsx"), "utf8");
  const logo = fs.readFileSync(path.join(ROOT, "src/components/branding/TenantLogo.tsx"), "utf8");
  assert.match(login, /TenantLogo/);
  assert.match(login, /src=\{tenant\.logo_url\}/);
  assert.match(header, /TenantLogo/);
  assert.match(header, /src=\{tenant\?\.logo_url\}/);
  assert.match(settings, /TenantLogo/);
  assert.match(logo, /resolveTenantLogoUrl/);
});

test("resolver does not introduce a Supabase runtime URL or SDK", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/tenantLogoUrl.ts"), "utf8");
  assert.doesNotMatch(src, /createClient/);
  assert.doesNotMatch(src, /@supabase\/supabase-js/);
  assert.doesNotMatch(src, /VITE_SUPABASE_URL/);
  const resolved = resolveTenantLogoUrl("freedom/logo.png", PREP);
  assert.doesNotMatch(resolved, /supabase/);
  assert.equal(rewriteTenantLogoUrl("freedom/logo.png", PREP).includes("supabase"), false);
});
