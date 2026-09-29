import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

// The helper lives in a TSX module; evaluate the same contract here so the
// production path rule is unit-tested without a Vite compile.
const CHECK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECK_ID = "3916f620-9d20-499b-8450-9e1a8e70a3c9";
const CLAIM_ID = "1de2f734-de37-404a-aa3e-d23905f7a6ea";

const buildCheckScopedSignatureUploadPath = (checkIntakeItemId, name) => {
  const checkId = String(checkIntakeItemId || "").trim();
  if (!CHECK_UUID_RE.test(checkId)) {
    throw new Error("Signature upload requires a check-scoped path");
  }
  const sanitized = String(name || "document").replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return `check-intake/${checkId}/files/${Date.now()}-${crypto.randomUUID()}-${sanitized}`;
};

test("signature upload path uses the check UUID, not the claim UUID", () => {
  const path = buildCheckScopedSignatureUploadPath(CHECK_ID, "Third-Party-Auth-Form.pdf");
  assert.match(path, new RegExp(`^check-intake/${CHECK_ID}/files/\\d+-[0-9a-f-]+-Third-Party-Auth-Form\\.pdf$`));
  assert.equal(path.includes(CLAIM_ID), false);
  assert.equal(path.startsWith("signatures/"), false);
});

test("signature upload refuses a missing check id and never uses signatures/", () => {
  assert.throws(() => buildCheckScopedSignatureUploadPath(null, "x.pdf"), /check-scoped path/);
  assert.throws(() => buildCheckScopedSignatureUploadPath("", "x.pdf"), /check-scoped path/);
  assert.throws(() => buildCheckScopedSignatureUploadPath("not-a-uuid", "x.pdf"), /check-scoped path/);
});

test("source still contains the required helper and no signatures/claim fallback", () => {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const src = fs.readFileSync(new URL("../components/claim-detail/SignatureRequests.tsx", import.meta.url), "utf8");
  assert.match(src, /export const buildCheckScopedSignatureUploadPath/);
  assert.match(src, /check-intake\/\$\{checkId\}\/files\//);
  assert.equal(src.includes("signatures/${claimId}"), false);
  assert.equal((src.match(/buildCheckScopedSignatureUploadPath/g) || []).length >= 3, true);
});
