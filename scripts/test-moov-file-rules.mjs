/**
 * Moov verification-document rules tests — pure logic + static guarantees.
 *
 * Run:  bun scripts/test-moov-file-rules.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_FILE_BYTES,
  normalizeReviewStatus,
  rateLimitExceeded,
  requiresRepresentative,
  sanitizeFileName,
  validateUpload,
} from "../supabase/functions/_shared/moovFileRules.ts";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const base = {
  purpose: "business_verification",
  fileName: "articles.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
};

test("successful business verification upload", () => {
  const r = validateUpload(base);
  assert.equal(r.ok, true);
  assert.equal(r.value.purpose, "business_verification");
  assert.equal(r.value.representativeId, null);
});

test("successful representative upload with mapping", () => {
  const r = validateUpload({
    ...base,
    purpose: "representative_verification",
    fileName: "id.jpg",
    mimeType: "image/jpeg",
    representativeId: "rep_123",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.representativeId, "rep_123");
});

test("representative purpose without representative is rejected", () => {
  const r = validateUpload({ ...base, purpose: "representative_verification" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "representative_required");
});

test("identity/individual KYC purposes are accepted", () => {
  for (const p of ["identity_verification", "individual_verification"]) {
    assert.equal(validateUpload({ ...base, purpose: p }).ok, true);
  }
});

test("invalid purpose is rejected", () => {
  const r = validateUpload({ ...base, purpose: "bank_statement" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_purpose");
});

test("csv and png are accepted, others are not", () => {
  assert.equal(validateUpload({ ...base, fileName: "list.csv", mimeType: "text/csv" }).ok, true);
  assert.equal(validateUpload({ ...base, fileName: "id.png", mimeType: "image/png" }).ok, true);
  const bad = validateUpload({ ...base, fileName: "doc.docx", mimeType: "application/msword" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid_type");
});

test("mime/extension mismatch is rejected", () => {
  const r = validateUpload({ ...base, fileName: "id.png", mimeType: "application/pdf" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_type");
});

test("size limits", () => {
  assert.equal(validateUpload({ ...base, sizeBytes: MAX_FILE_BYTES }).ok, true);
  const big = validateUpload({ ...base, sizeBytes: MAX_FILE_BYTES + 1 });
  assert.equal(big.code, "file_too_large");
  assert.equal(validateUpload({ ...base, sizeBytes: 0 }).code, "empty_file");
});

test("filenames are sanitized and path-stripped", () => {
  assert.equal(sanitizeFileName("../../etc/pa$$wd.pdf"), "pa__wd.pdf");
  assert.equal(sanitizeFileName(""), "document");
});

test("review status normalization", () => {
  assert.equal(normalizeReviewStatus("approved"), "approved");
  assert.equal(normalizeReviewStatus("rejected"), "rejected");
  assert.equal(normalizeReviewStatus("pending review"), "pending");
  assert.equal(normalizeReviewStatus(null), "pending");
  assert.equal(normalizeReviewStatus("weird"), "pending");
});

test("rate limit trips at the configured max", () => {
  assert.equal(rateLimitExceeded(19), false);
  assert.equal(rateLimitExceeded(20), true);
});

test("only representative_verification requires a representative", () => {
  assert.equal(requiresRepresentative("representative_verification"), true);
  assert.equal(requiresRepresentative("business_verification"), false);
});

/* ---- static guarantees: server-side auth + tenant isolation ---- */

const upload = readFileSync("supabase/functions/moov-account-file-upload/index.ts", "utf8");
const list = readFileSync("supabase/functions/moov-account-files/index.ts", "utf8");
const client = readFileSync("src/lib/payments/verificationFiles.ts", "utf8");
const panel = readFileSync("src/components/payments/VerificationDocumentsPanel.tsx", "utf8");

test("cross-tenant denial: both functions gate on requireMoovCaller", () => {
  assert.ok(upload.includes("requireMoovCaller"));
  assert.ok(list.includes("requireMoovCaller"));
});

test("account mapping is looked up by tenant, never taken from the client", () => {
  assert.ok(upload.includes('.eq("tenant_id", tenantId)'));
  assert.ok(!upload.includes('form.get("provider_account_id")'));
});

test("representative mapping is verified against the provider", () => {
  assert.ok(upload.includes("representativeBelongsToAccount"));
});

test("provider credentials never appear in frontend code", () => {
  for (const src of [client, panel]) {
    assert.ok(!/MOOV_SECRET_KEY|MOOV_PUBLIC_KEY|moovToken|api\.moov\.io/.test(src));
  }
});

test("frontend cannot retrieve document contents", () => {
  assert.ok(!/download|getFileContents|files\/.*\/content/.test(client));
  assert.ok(!list.includes("/content"));
});

test("raw document bytes are not persisted", () => {
  assert.ok(!upload.includes("storage.from("));
  assert.ok(!upload.includes("file_bytes"));
});

test("audit event carries no document contents", () => {
  const idx = upload.indexOf("logPaymentEvent");
  const block = upload.slice(idx, idx + 600);
  assert.ok(block.includes("provider_file_id"));
  assert.ok(!block.includes("bytes,"));
});

test("explicit Moov API version handling is used for file calls", () => {
  const files = readFileSync("supabase/functions/_shared/moovFiles.ts", "utf8");
  assert.equal((files.match(/apiVersion: moovApiVersion\(\)/g) ?? []).length >= 3, true);
});

test("provider errors surface as safe messages, not raw provider text", () => {
  assert.ok(upload.includes("We couldn't submit that document"));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
