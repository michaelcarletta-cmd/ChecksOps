import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatSignatureRequestFrom } from "../src/lib/signatureRequestSender.ts";
import { resolveTenantLogoUrl } from "../src/lib/tenantLogoUrl.ts";
import { assertNoSyncDelete, localManifest, simulatePromotion } from "../scripts/lib/spa-promote-guard.mjs";
import {
  assertProductionBuilderSource,
  assertProductionSpaBuild,
} from "../scripts/lib/spa-production-build-guard.mjs";
import { assertSpaOnlyArgv } from "../scripts/promote-production-email-preview-spa.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sha256 = (rel) => createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");

test("Freedom preview remains Freedom Adjustment <support@checksops.com>", () => {
  assert.equal(
    formatSignatureRequestFrom("Freedom Adjustment"),
    "Freedom Adjustment <support@checksops.com>",
  );
});

test("preview never uses via ChecksOps or noreply", () => {
  const from = formatSignatureRequestFrom("Freedom Adjustment via ChecksOps");
  assert.equal(from, "Freedom Adjustment <support@checksops.com>");
  assert.doesNotMatch(from, /via ChecksOps/);
  assert.doesNotMatch(from, /noreply@checksops\.com/);
  assert.doesNotMatch(read("src/components/settings/SignatureRequestEmailPreview.tsx"), /noreply@checksops\.com/);
  assert.doesNotMatch(read("src/lib/signatureRequestSender.ts"), /noreply@checksops\.com/);
});

test("second tenant resolves independently", () => {
  assert.equal(
    formatSignatureRequestFrom("Condition One Commercial"),
    "Condition One Commercial <support@checksops.com>",
  );
  assert.notEqual(
    formatSignatureRequestFrom("Condition One Commercial"),
    formatSignatureRequestFrom("Freedom Adjustment"),
  );
});

test("R4A logo resolver and Sending-domain absence stay intact", () => {
  const resolver = read("src/lib/tenantLogoUrl.ts");
  assert.match(resolver, /export function resolveTenantLogoUrl/);
  assert.match(resolver, /canonicalStoredTenantLogo/);
  assert.match(resolver, /\/storage\/public\?bucket=/);
  assert.equal(resolveTenantLogoUrl("", "/prep"), null);
  const branding = read("src/components/settings/TenantBrandingSettings.tsx");
  const settings = read("src/components/white-label/WhiteLabelSettings.tsx");
  for (const src of [branding, settings]) {
    assert.doesNotMatch(src, /Sending Domain|Sending subdomain|DKIM|SPF|SES identity|dnsRecords/);
    assert.doesNotMatch(src, /EmailSenderSettings/);
  }
});

test("production dataplane builder refuses staging and requires /prep", () => {
  const builder = read("scripts/build-production-aws-spa.mjs");
  assert.equal(assertProductionBuilderSource(builder).ok, true);
  assert.equal(assertProductionSpaBuild({
    mode: "production",
    env: {
      VITE_AUTH_PROVIDER: "cognito",
      VITE_APP_URL: "https://checksops.com",
      VITE_CHECKSOPS_API_URL: "/prep",
      VITE_COGNITO_USER_POOL_ID: "us-east-1_h00WorYMT",
      VITE_COGNITO_USER_POOL_CLIENT_ID: "3ja9fqaq2fjkv3i6up2varcqpe",
    },
  }).ok, true);
  assert.equal(assertProductionSpaBuild({
    mode: "aws",
    env: {
      VITE_CHECKSOPS_API_URL: "https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging",
      VITE_COGNITO_USER_POOL_ID: "us-east-1_vPmQ7cL1F",
    },
  }).ok, false);
});

test("SPA promotion cannot package or deploy Lambda", () => {
  const promote = read("scripts/promote-production-email-preview-spa.mjs");
  const builder = read("scripts/build-production-aws-spa.mjs");
  for (const src of [promote, builder]) {
    assert.doesNotMatch(src, /['"]update-function-code['"]/);
    assert.doesNotMatch(src, /['"]update-function-configuration['"]/);
    assert.doesNotMatch(src, /aws\/functions\/api\/esign\.mjs/);
    assert.doesNotMatch(src, /lambda update-function/i);
  }
  assert.match(promote, /ZERO Lambda authority/);
  assert.match(promote, /lambdaAuthority: false/);
  assert.match(promote, /forbidden Lambda/);
  assert.match(promote, /ChecksOpsProductionSpaDeploy/);
  assert.match(promote, /ZERO Lambda authority by design/);
  assert.match(promote, /tenant-email-preview-prod-lambda-ro/);
  assert.match(promote, /planUploadOrder/);
  assert.match(promote, /indexLast/);
  assert.match(promote, /syncDelete: false/);
  assert.doesNotMatch(promote, /s3',\s*'sync'/);
  assert.equal(assertNoSyncDelete(["aws", "s3", "sync", "dist", "s3://bucket", "--delete"]).ok, false);
  assert.equal(assertSpaOnlyArgv(["node", "scripts/promote-production-email-preview-spa.mjs", "update-function-code"]).ok, false);
  assert.equal(assertSpaOnlyArgv(["node", "scripts/promote-production-email-preview-spa.mjs", "aws/functions/api/esign.mjs"]).ok, false);
  assert.equal(
    sha256("aws/functions/api/esign.mjs"),
    "37c5c742f516ce750a402c53214307eee429742e8eed8d4ef9399772516209c5",
    "worktree esign.mjs stays historical pre-fix and is never an upload input",
  );
});

test("Claim Check/image-compat files stay byte-identical", () => {
  assert.equal(sha256("src/lib/checkImageInvariants.ts"), "41a42c8df6f61b52b2683a300310c3f0498531ee991c5492347e216dc418d802");
  assert.equal(sha256("src/pages/CheckCommandCenter.tsx"), "32436906507f3e8f183a0f393dd43ea66bd7eeb4dd2fca33087e737a6b7984d4");
});

test("existing promote guard still requires complete graph and index last", () => {
  const dist = path.join(ROOT, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    const simulated = simulatePromotion({
      distDir: dist,
    });
    assert.equal(simulated.ok, false);
    return;
  }
  const manifest = localManifest(dist);
  const simulated = simulatePromotion({ distDir: dist });
  assert.equal(manifest.ok, true, manifest.errors.join("\n"));
  assert.equal(simulated.ok, true, simulated.errors.join("\n"));
  assert.equal(simulated.uploadSequence.at(-1), "index.html");
});
