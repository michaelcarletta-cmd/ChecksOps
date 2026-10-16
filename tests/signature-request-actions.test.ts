import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  canDeleteSignatureRequest,
  canResendRequest,
  canResendSigner,
  requestAlreadySigned,
} from "../src/lib/signature-request-actions.ts";

test("Resend is offered only for pending or failed requests that are not signed", () => {
  assert.equal(canResendRequest({ status: "pending", signature_signers: [{ status: "pending" }] }), true);
  assert.equal(canResendRequest({ status: "failed", signature_signers: [{ status: "pending" }] }), true);
  assert.equal(canResendRequest({ status: "completed", signature_signers: [{ status: "signed" }] }), false);
  assert.equal(canResendRequest({ status: "signed", signature_signers: [] }), false);
  assert.equal(canResendRequest({ status: "pending", signature_signers: [{ status: "signed" }] }), false);
  assert.equal(canResendRequest({ status: "draft", signature_signers: [] }), false);
  assert.equal(canResendRequest(null), false);
});

test("per-signer Retry is hidden once the signer or the request is signed", () => {
  const pending = { status: "pending", signature_signers: [{ status: "pending" }, { status: "signed" }] };
  assert.equal(canResendSigner(pending, { status: "pending", delivery_status: "failed" }), true);
  assert.equal(canResendSigner(pending, { status: "signed", delivery_status: "failed" }), false);
  assert.equal(canResendSigner(pending, { status: "pending", delivery_status: "sent" }), false);
  assert.equal(canResendSigner({ status: "completed" }, { status: "pending", delivery_status: "failed" }), false);
  assert.equal(requestAlreadySigned({ status: "pending", signature_signers: [{ status: "signed" }] }), true);
});

test("Delete is offered only for drafts and unsent requests", () => {
  assert.equal(canDeleteSignatureRequest({ status: "draft", signature_signers: [{ status: "pending" }] }), true);
  assert.equal(canDeleteSignatureRequest({ status: "failed", sent_at: null, signature_signers: [{ delivery_status: "failed" }] }), true);
  assert.equal(canDeleteSignatureRequest({ status: "pending", sent_at: "2026-10-01" }), false);
  assert.equal(canDeleteSignatureRequest({ status: "pending", delivery_mode: "manual_bypass" }), false);
  assert.equal(canDeleteSignatureRequest({ status: "completed", final_pdf_path: "signed/x.pdf" }), false);
  assert.equal(canDeleteSignatureRequest({ status: "draft", signature_signers: [{ viewed_at: "2026-10-01" }] }), false);
});

test("SignatureRequests.tsx gates Resend, signer Retry and Delete on the shared rules", () => {
  const src = readFileSync(new URL("../src/components/claim-detail/SignatureRequests.tsx", import.meta.url), "utf8");
  assert.match(src, /canResendRequest\(request\) && \(/);
  assert.match(src, /canResendSigner\(request, signer\) && \(/);
  assert.match(src, /canDeleteSignatureRequest\(request\) && \(/);
  assert.equal(src.includes('request.status === "failed" || request.status === "pending"'), false);
});
