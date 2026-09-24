import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("tenant logo upload paths are tenant-scoped in WhiteLabelSettings", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/components/white-label/WhiteLabelSettings.tsx"), "utf8");
  assert.match(src, /from\("tenant-logos"\)/);
  assert.match(src, /\$\{tenant\.id\}\/logo-\$\{Date\.now\(\)\}\./);
  assert.ok(src.includes("upload(path, file"), "expected logo upload to call upload(path, file)");
  assert.ok(src.includes("upsert: true"), "expected logo upload to be upsert: true");
  assert.ok(src.includes("getPublicUrl(path)"), "expected getPublicUrl(path) after upload");
  assert.ok(src.includes("logo_url:"), "expected logo_url to be persisted to tenants");
  assert.ok(src.includes('.eq("id", tenant.id)'), "expected update scoped to tenant.id");
});

test("tenant logo upload paths are tenant-scoped in TenantManagement", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/components/settings/TenantManagement.tsx"), "utf8");
  assert.match(src, /from\("tenant-logos"\)/);
  assert.match(src, /\$\{editingId\}\/logo-\$\{Date\.now\(\)\}/);
  assert.ok(src.includes("getPublicUrl(path)"), "expected getPublicUrl(path) after upload");
  assert.ok(src.includes("logo_url:"), "expected logo_url to be persisted to tenants");
  assert.ok(src.includes('.eq("id", id)'), "expected update scoped by id");
});

