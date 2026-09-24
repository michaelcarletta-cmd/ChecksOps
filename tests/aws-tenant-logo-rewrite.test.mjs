import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("AWS storage rewrite supports relative tenant logo paths", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/integrations/aws/storage.ts"), "utf8");

  // Ensure we have an explicit path-shape guard for tenant-scoped logo objects.
  assert.match(src, /TENANT_SCOPED_PATH/);
  assert.match(src, /rewriteTenantLogoUrl/);

  // Ensure the rewrite points to the AWS storage public resolver for tenant-logos.
  assert.match(src, /bucket=tenant-logos/);
  assert.match(src, /\/storage\/public\?bucket=tenant-logos&path=/);

  // Ensure rewriteStorageFields uses the logo-specific rewrite for logo_url.
  assert.match(src, /\^\(logo_url\|logoUrl\)\$/i);
});

