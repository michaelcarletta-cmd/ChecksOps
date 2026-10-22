/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for untyped server payloads */
/**
 * Compliance & Docs (Moov onboarding) SPA tests.
 *
 * Run: node --experimental-strip-types --test tests/moov-onboarding-spa.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DocumentUploadError,
  buildSavePayload,
  businessFormFrom,
  clearSecrets,
  createOnboardingApi,
  describeDocumentStatus,
  describeSyncStatus,
  emptyRepresentativeForm,
  maskedEin,
  maskedSsn,
  normalizeOnboardingState,
  redactSensitive,
  representativeFormFrom,
  resolveComplianceAccess,
  isOnboardingUnavailableCode,
  safeErrorMessage,
  uploadOnboardingDocument,
  validateDocumentFile,
  validateOnboardingForm,
} from "../src/lib/payments/moovOnboarding.ts";
import { MAX_UPLOAD_BYTES, FILE_PURPOSE_OPTIONS } from "../src/lib/payments/verificationFiles.ts";

const read = (p: string) => readFileSync(p, "utf8");
const compliance = read("src/components/settings/ComplianceSettings.tsx");
const businessSection = read("src/components/settings/compliance/BusinessSection.tsx");
const repsSection = read("src/components/settings/compliance/RepresentativesSection.tsx");
const docsSection = read("src/components/settings/compliance/DocumentsSection.tsx");
const bankSection = read("src/components/settings/compliance/BankSection.tsx");
const hook = read("src/hooks/useMoovOnboarding.ts");
const lib = read("src/lib/payments/moovOnboarding.ts");
const files = read("src/lib/payments/verificationFiles.ts");
const adminTenants = read("src/pages/admin/AdminTenants.tsx");
const whiteLabel = read("src/components/white-label/WhiteLabelSettings.tsx");
const flowSources = [compliance, businessSection, repsSection, docsSection, bankSection, hook, lib];

function serverState(overrides: Record<string, unknown> = {}) {
  return normalizeOnboardingState({
    ok: true,
    environment: "sandbox",
    account: { connected: true, status: "active", capabilities: [], tos_accepted: false },
    business: {
      legal_name: "Acme Restoration LLC",
      dba: "",
      type: "privateCorporation",
      ein_masked: "••-•••6789",
      email: "ops@acme.test",
      phone: "555-555-0100",
      website: "",
      description: "Restoration",
      address: { line1: "1 Main St", line2: "", city: "Newark", state: "NJ", postal_code: "07001" },
    },
    representatives: [
      {
        id: "rep_1",
        name: "Pat Owner",
        email: "pat@acme.test",
        phone: "",
        title: "Owner",
        dob_masked: "••/••/1980",
        ssn_last4: "4321",
        address: { line1: "2 Elm", city: "Newark", state: "NJ", postal_code: "07001" },
        is_controller: true,
        ownership_pct: 100,
      },
    ],
    documents: [],
    banks: [],
    sync: { pending: false, last_error_code: null },
    can_submit: true,
    ...overrides,
  });
}

/* ---------------- SSN never stored or re-shown ---------------- */

test("SSN is never prefilled from the server, even if one is (wrongly) returned", () => {
  const rep = representativeFormFrom({ ...serverState().representatives[0], ssn: "123456789" } as any);
  assert.equal(rep.ssn, "");
  assert.equal(rep.dob, "");
  assert.equal(rep.ssn_last4, "4321");
  assert.equal(maskedSsn(rep.ssn_last4), "•••-••-4321");
  assert.equal(maskedSsn("123456789"), "•••-••-6789", "only the last four can ever render");
  assert.equal(businessFormFrom({ ...serverState().business, ein: "123456789" } as any).ein, "");
});

test("SSN/EIN are sent once and are write-only: omitted when unchanged, cleared after submit", () => {
  const state = serverState();
  const biz = businessFormFrom(state.business);
  const reps = state.representatives.map(representativeFormFrom);

  const unchanged = buildSavePayload("t1", biz, reps);
  assert.equal("ein" in unchanged.business, false);
  assert.equal("ssn" in unchanged.representatives[0], false);
  assert.equal("dob" in unchanged.representatives[0], false);
  assert.equal(unchanged.representatives[0].id, "rep_1");

  const typedReps = [{ ...reps[0], ssn: "123-45-6789", dob: "1980-02-03" }];
  const typed = buildSavePayload("t1", { ...biz, ein: "12-3456789" }, typedReps);
  assert.equal(typed.business.ein, "123456789");
  assert.equal(typed.representatives[0].ssn, "123456789");
  assert.equal(typed.representatives[0].dob, "1980-02-03");

  const cleared = clearSecrets({ ...biz, ein: "123456789" }, typedReps);
  assert.equal(cleared.business.ein, "");
  assert.equal(cleared.representatives[0].ssn, "");
  assert.equal(cleared.representatives[0].dob, "");
  assert.doesNotMatch(JSON.stringify(cleared), /123456789|6789"/);
});

test("ComplianceSettings clears secrets from state before awaiting the save and never caches them", () => {
  const save = compliance.slice(compliance.indexOf("async function handleSave"));
  const build = save.indexOf("buildSavePayload(");
  const clear = save.indexOf("clearSecrets(");
  const awaitSave = save.indexOf("await api.save(payload)");
  assert.ok(build > 0 && clear > build && awaitSave > clear, "clear secrets between build and await");
  assert.ok(save.indexOf("setReps(cleared.representatives)") < awaitSave);
  // useMutation would keep the variables (with the SSN) in the mutation cache.
  assert.doesNotMatch(compliance, /useMutation/);
  for (const src of flowSources) {
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
    assert.doesNotMatch(src, /console\.(log|info|debug|warn|error)/);
    assert.doesNotMatch(src, /analytics|posthog|gtag|track\(/i);
  }
});

test("SSN input is password-style, not autofilled, and saved rows render last 4 only", () => {
  const ssnInput = repsSection.slice(repsSection.indexOf('id={`${p}-ssn`}'), repsSection.indexOf('id={`${p}-ssn`}') + 300);
  assert.match(ssnInput, /type="password"/);
  assert.match(ssnInput, /autoComplete="off"/);
  assert.match(repsSection, /maskedSsn\(r\.ssn_last4\)/);
  assert.doesNotMatch(repsSection, /value=\{r\.ssn_last4\}/);
  assert.match(repsSection, /ssn_resubmit_required/);
});

test("ssn_resubmit_required forces re-entry before the next save", () => {
  const rep = { ...representativeFormFrom({ ...serverState().representatives[0], ssn_resubmit_required: true }) };
  const errs = validateOnboardingForm(businessFormFrom(serverState().business), [rep]);
  assert.ok(errs.some((e) => /re-enter the SSN/.test(e)));
  const ok = validateOnboardingForm(businessFormFrom(serverState().business), [{ ...rep, ssn: "123456789" }]);
  assert.deepEqual(ok, []);
});

test("new representatives require SSN + DOB; existing ones do not", () => {
  const biz = businessFormFrom(serverState().business);
  const fresh = { ...emptyRepresentativeForm(true), name: "New Person" };
  const errs = validateOnboardingForm(biz, [fresh]);
  assert.ok(errs.some((e) => /SSN is required/.test(e)));
  assert.ok(errs.some((e) => /date of birth is required/.test(e)));
});

test("SSN/EIN-shaped values are redacted from any toast text", () => {
  assert.equal(redactSensitive("bad ssn 123-45-6789"), "bad ssn [redacted]");
  assert.equal(redactSensitive("ein 12-3456789 invalid"), "ein [redacted] invalid");
  assert.equal(redactSensitive("raw 123456789"), "raw [redacted]");
  assert.equal(safeErrorMessage(new Error("Moov rejected 987654321")), "Moov rejected [redacted]");
  assert.match(lib, /super\(redactSensitive\(message\)\)/);
  // Every toast description in the flow goes through safeErrorMessage.
  for (const src of [compliance, businessSection, docsSection]) {
    assert.doesNotMatch(src, /description:\s*e\.message/);
    assert.doesNotMatch(src, /description:\s*\(e as any\)\.message/);
  }
});

/* ---------------- EIN masked + reveal ---------------- */

test("EIN only ever renders its last 4 digits", () => {
  assert.equal(maskedEin("••-•••6789"), "••-•••6789");
  assert.equal(maskedEin("12-3456789"), "••-•••6789", "even an unmasked server value is re-masked");
  assert.equal(maskedEin(null), "Not on file");
});

test("Reveal is visible whenever the server allows submit (any tenant member or platform owner)", () => {
  assert.equal(resolveComplianceAccess({ canSubmit: true }).canRevealEin, true);
  assert.equal(resolveComplianceAccess({ canSubmit: false }).canRevealEin, false);
  assert.equal(resolveComplianceAccess({ canSubmit: undefined }).canRevealEin, false);
  // Platform owner in Tenant Management can reveal without turning on editing.
  // Tenant Management (edit on behalf or not): no EIN reveal and no terms acceptance.
  assert.equal(resolveComplianceAccess({ canSubmit: true, adminView: true }).canRevealEin, false);
  assert.equal(resolveComplianceAccess({ canSubmit: true, adminView: true, editOnBehalf: true }).canRevealEin, false);
  assert.equal(resolveComplianceAccess({ canSubmit: true, adminView: true, editOnBehalf: true }).canAcceptTerms, false);
  assert.equal(resolveComplianceAccess({ canSubmit: true }).canAcceptTerms, true);
  assert.equal(resolveComplianceAccess({ canSubmit: false }).canAcceptTerms, false);
  assert.match(businessSection, /\{canRevealEin && einMasked && \(/);
  assert.match(compliance, /canRevealEin=\{access\.canRevealEin\}/);
  assert.match(businessSection, /EIN_REVEAL_MS/);
  // The EIN input is write-only and never bound to the masked value.
  assert.match(businessSection, /id="biz-ein"\s+type="password"/);
  assert.doesNotMatch(businessSection, /value=\{einMasked\}/);
});

test("reveal calls moov-ein-reveal with only the tenant id", async () => {
  const calls: Array<[string, any]> = [];
  const api = createOnboardingApi(async (name, body) => {
    calls.push([name, body]);
    return { ein: "123456789" };
  });
  assert.equal(await api.revealEin("t1"), "123456789");
  assert.deepEqual(calls, [["moov-ein-reveal", { tenant_id: "t1" }]]);
});

/* ---------------- Read-only when can_submit is false ---------------- */

test("can_submit fails closed and drives the read-only view", () => {
  assert.equal(normalizeOnboardingState({}).can_submit, false);
  assert.equal(normalizeOnboardingState({ can_submit: "true" }).can_submit, false);
  assert.equal(normalizeOnboardingState({ can_submit: true }).can_submit, true);
  assert.equal(resolveComplianceAccess({ canSubmit: false }).readOnly, true);
  assert.equal(resolveComplianceAccess({ canSubmit: true }).readOnly, false);

  assert.match(compliance, /resolveComplianceAccess\(\{ canSubmit: data\?\.can_submit, adminView, editOnBehalf \}\)/);
  assert.match(compliance, /\{!readOnly && \([\s\S]*Save and submit/);
  for (const src of [repsSection, docsSection, bankSection]) assert.match(src, /readOnly/);
  assert.match(docsSection, /\{!readOnly && \(\s*<div className="space-y-3 rounded-md border/);
  assert.match(repsSection, /\{!readOnly && \(\s*<Input\s+id=\{`\$\{p\}-ssn`\}/);
});

test("every tenant member gets Compliance & Docs and the document library (no role tiers)", () => {
  assert.match(whiteLabel, /const isTenantMember = !!tenantRole;/);
  assert.match(whiteLabel, /const canViewCompliance = isTenantMember \|\| isPlatformOwner\(user\?\.email\);/);
  assert.match(whiteLabel, /import \{ isPlatformOwner \} from "@\/lib\/masterMerchant";/);
  assert.doesNotMatch(whiteLabel, /canViewCompliance = [^;]*isAdmin/);
  assert.doesNotMatch(whiteLabel, /canViewCompliance = canManageTenant/);
  assert.match(whiteLabel, /\{canViewCompliance && <TabsTrigger value="compliance"/);
  const tab = whiteLabel.slice(whiteLabel.indexOf('<TabsContent value="compliance"'));
  const region = tab.slice(0, tab.indexOf("</TabsContent>"));
  assert.match(region, /<TenantDocumentLibrary/);
  assert.doesNotMatch(region, /canManageTenant|owner|"admin"/);
  assert.doesNotMatch(compliance, /owner or an admin/);
  // Editing is the server's can_submit, never a client-side role tier.
  assert.doesNotMatch(compliance, /tenantRole|role === "(owner|admin)"/);
  assert.equal(resolveComplianceAccess({ canSubmit: true }).readOnly, false);
});

/* ---------------- Upload flow ---------------- */

function fakeFile(name: string, size: number) {
  // A Blob stand-in whose reported size can exceed what we allocate.
  const blob = new Blob([new Uint8Array(Math.min(size, 16))]);
  Object.defineProperty(blob, "name", { value: name });
  Object.defineProperty(blob, "size", { value: size });
  return blob as Blob & { name: string; size: number };
}

test("upload goes upload-url -> PUT (exact headers) -> finalize", async () => {
  const order: string[] = [];
  const invokeCalls: Array<[string, any]> = [];
  const api = createOnboardingApi(async (name, body) => {
    invokeCalls.push([name, body]);
    order.push(name);
    if (name === "moov-document-upload-url") {
      return { document_id: "doc_1", upload_url: "https://s3.example/put?sig=1", headers: { "Content-Type": "application/pdf", "x-amz-server-side-encryption": "aws:kms" } };
    }
    if (name === "moov-document-finalize") {
      return { id: "doc_1", purpose: "w9", file_name: "w9.pdf", moov_file_id: "mf_1", moov_status: "pending" };
    }
    throw new Error("unexpected " + name);
  });
  const progress: number[] = [];
  let putArgs: any = null;
  const doc = await uploadOnboardingDocument({
    api,
    tenantId: "t1",
    purpose: "w9",
    file: fakeFile("w9.pdf", 2048),
    onProgress: (p) => progress.push(p),
    put: async (url, headers, body, onProgress) => {
      order.push("PUT");
      putArgs = { url, headers };
      onProgress?.(50);
    },
  });
  assert.deepEqual(order, ["moov-document-upload-url", "PUT", "moov-document-finalize"]);
  assert.deepEqual(invokeCalls[0][1], { tenant_id: "t1", purpose: "w9", file_name: "w9.pdf", content_type: "application/pdf", size: 2048 });
  assert.deepEqual(invokeCalls[1][1], { tenant_id: "t1", document_id: "doc_1" });
  assert.equal(putArgs.url, "https://s3.example/put?sig=1");
  assert.deepEqual(putArgs.headers, { "Content-Type": "application/pdf", "x-amz-server-side-encryption": "aws:kms" });
  assert.deepEqual(progress, [0, 50, 100]);
  assert.equal(doc.moov_file_id, "mf_1");
});

test("a finalize failure is retryable and keeps the document id", async () => {
  const api = {
    requestUploadUrl: async () => ({ document_id: "doc_9", upload_url: "https://s3/x", headers: {} }),
    finalizeDocument: async () => { throw new Error("moov timeout"); },
  };
  await assert.rejects(
    uploadOnboardingDocument({ api, put: async () => {}, tenantId: "t1", purpose: "license", file: fakeFile("l.png", 10) }),
    (e: any) => e instanceof DocumentUploadError && e.stage === "finalize" && e.documentId === "doc_9",
  );
  assert.equal(describeDocumentStatus({ moov_file_id: null, moov_status: null }).retryable, true);
  assert.equal(describeDocumentStatus({ moov_file_id: null, moov_status: "failed" }).retryable, true);
  assert.equal(describeDocumentStatus({ moov_file_id: "mf", moov_status: "pending" }).retryable, false);
  assert.match(docsSection, /api\.finalizeDocument\(tenantId, documentId\)/);
});

test("the SPA no longer builds upload URLs from VITE_SUPABASE_URL or posts multipart", () => {
  assert.doesNotMatch(files, /VITE_SUPABASE_URL|FormData|functions\/v1/);
  assert.doesNotMatch(lib, /VITE_SUPABASE_URL|FormData/);
  assert.match(lib, /xhr\.open\("PUT", url\)/);
  assert.match(docsSection, /xhrPut/);
  assert.equal(existsSync("src/components/payments/VerificationDocumentsPanel.tsx"), false);
  assert.equal(existsSync("src/hooks/useVerificationFiles.ts"), false);
});

/* ---------------- 20 MB and type limits ---------------- */

test("20 MB and pdf/jpg/jpeg/png/csv limits are enforced before any request", async () => {
  assert.equal(MAX_UPLOAD_BYTES, 20 * 1024 * 1024);
  assert.deepEqual(validateDocumentFile({ name: "a.pdf", size: MAX_UPLOAD_BYTES }), { ok: true, contentType: "application/pdf" });
  assert.equal(validateDocumentFile({ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 }).ok, false);
  assert.equal(validateDocumentFile({ name: "a.JPG", size: 10 }).ok, true);
  assert.equal(validateDocumentFile({ name: "a.jpeg", size: 10 }).ok, true);
  assert.equal(validateDocumentFile({ name: "a.png", size: 10 }).ok, true);
  assert.deepEqual(validateDocumentFile({ name: "a.csv", size: 10 }), { ok: true, contentType: "text/csv" });
  for (const bad of ["a.docx", "a.exe", "a.gif", "pdf", "a.pdf.zip"]) {
    assert.equal(validateDocumentFile({ name: bad, size: 10 }).ok, false, bad);
  }
  assert.equal(validateDocumentFile({ name: "a.pdf", size: 0 }).ok, false);

  let called = false;
  const api = {
    requestUploadUrl: async () => { called = true; return { document_id: "d", upload_url: "u", headers: {} }; },
    finalizeDocument: async () => ({}) as any,
  };
  await assert.rejects(
    uploadOnboardingDocument({ api, put: async () => {}, tenantId: "t", purpose: "w9", file: fakeFile("big.pdf", MAX_UPLOAD_BYTES + 1) }),
    (e: any) => e.stage === "validate",
  );
  await assert.rejects(
    uploadOnboardingDocument({ api, put: async () => {}, tenantId: "t", purpose: "not_a_purpose", file: fakeFile("a.pdf", 1) }),
    (e: any) => e.stage === "validate",
  );
  assert.equal(called, false);
  assert.equal(FILE_PURPOSE_OPTIONS.length, 11);
});

/* ---------------- Pending sync display ---------------- */

test("sync status is honest: saving, sending, retry pending (code), synced", () => {
  assert.equal(describeSyncStatus({ saving: true }).label, "Saving…");
  assert.equal(
    describeSyncStatus({ saving: false, lastSave: { saved: true, moov_synced: false, pending: true, error_code: null } }).label,
    "Saved, submitting…",
  );
  assert.equal(
    describeSyncStatus({ saving: false, lastSave: { saved: true, moov_synced: false, pending: true, error_code: "moov_timeout" } }).label,
    "Saved, submission retry pending (timeout)",
  );
  assert.equal(
    describeSyncStatus({ saving: false, lastSave: { saved: true, moov_synced: true, pending: false, error_code: null } }).label,
    "Synced",
  );
  assert.equal(describeSyncStatus({ saving: false, sync: { pending: true, last_error_code: null } }).label, "Saved, submitting…");
  assert.equal(describeSyncStatus({ saving: false, sync: { pending: true, last_error_code: "rate_limited" } }).label, "Saved, submission retry pending (rate_limited)");
  assert.equal(describeSyncStatus({ saving: false, sync: { pending: false, last_error_code: null }, accountConnected: false }).label, "Not yet submitted");
  assert.equal(describeSyncStatus({ saving: false, sync: { pending: false, last_error_code: null }, accountConnected: true }).label, "Synced");
  // A pending sync is never shown as "Synced".
  assert.notEqual(describeSyncStatus({ saving: false, sync: { pending: true, last_error_code: null }, accountConnected: true }).label, "Synced");

  assert.match(hook, /refetchInterval: \(query\) => \(query\.state\.data\?\.sync\?\.pending \? 5000 : false\)/);
  assert.match(compliance, /aria-live="polite" role="status"/);
});

/* ---------------- Tenant Management ---------------- */

test("AdminTenants renders the same flow read-only by default with an explicit edit toggle", () => {
  assert.match(adminTenants, /<ComplianceSettings tenantId=\{tenant\.id\} adminView \/>/);
  assert.match(compliance, /const \[editOnBehalf, setEditOnBehalf\] = useState\(false\)/);
  assert.match(compliance, /Edit on behalf of tenant/);
  assert.equal(resolveComplianceAccess({ canSubmit: true, adminView: true }).readOnly, true);
  assert.equal(resolveComplianceAccess({ canSubmit: true, adminView: true, editOnBehalf: true }).readOnly, false);
  assert.equal(resolveComplianceAccess({ canSubmit: false, adminView: true, editOnBehalf: true }).readOnly, true);
  assert.equal(resolveComplianceAccess({ canSubmit: true, adminView: true }).showEditOnBehalfToggle, true);
  assert.equal(resolveComplianceAccess({ canSubmit: true }).showEditOnBehalfToggle, false);
  // Documents list with View is available in read-only mode.
  assert.match(docsSection, /api\.viewDocument\(tenantId, documentId\)/);
  assert.match(docsSection, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  const viewBtn = docsSection.slice(docsSection.indexOf("onClick={() => handleView(d.id)}") - 200, docsSection.indexOf("onClick={() => handleView(d.id)}"));
  assert.doesNotMatch(viewBtn, /readOnly/);
});

/* ---------------- Old paths removed ---------------- */

test("Save KYC tenants write, glba insert and paste-a-URL field are gone", () => {
  assert.doesNotMatch(compliance, /from\("tenants"\)/);
  assert.doesNotMatch(compliance, /glba_security_events/);
  assert.doesNotMatch(compliance, /ID document URL|beneficial_owner_id_url/);
  assert.doesNotMatch(compliance, /Save KYC/);
  assert.match(compliance, /Save and submit/);
  assert.doesNotMatch(compliance, /useProviderProfile|PaymentOnboardingDialog|VerificationDocumentsPanel/);
  assert.equal(existsSync("src/hooks/useProviderProfile.ts"), false);
  assert.equal(existsSync("src/components/payments/PaymentOnboardingDialog.tsx"), false);
});

test("every call uses functions.invoke with the contract function names", async () => {
  assert.match(hook, /supabase\.functions\.invoke\(name, \{ body \}\)/);
  const calls: string[] = [];
  const api = createOnboardingApi(async (name) => {
    calls.push(name);
    if (name === "moov-document-view") return { url: "https://s3/get" };
    return { ok: true };
  });
  await api.get("t");
  await api.save({ tenant_id: "t", business: {} as any, representatives: [] });
  await api.viewDocument("t", "d");
  await api.acceptTerms("t");
  assert.deepEqual(calls, ["moov-onboarding-get", "moov-onboarding-save", "moov-document-view", "moov-tos-accept"]);
});

test("Compliance tab: production onboarding switched off reads as not available yet, not an error", () => {
  assert.equal(isOnboardingUnavailableCode("production_execution_blocked"), true);
  assert.equal(isOnboardingUnavailableCode("provider_disabled"), true);
  assert.equal(isOnboardingUnavailableCode("cross_tenant_denied"), false);
  assert.equal(isOnboardingUnavailableCode(null), false);
  const compliance = readFileSync(new URL("../src/components/settings/ComplianceSettings.tsx", import.meta.url), "utf8");
  assert.match(compliance, /Payment account setup is not available yet/);
  assert.match(compliance, /isOnboardingUnavailableCode\(code\)/);
});
