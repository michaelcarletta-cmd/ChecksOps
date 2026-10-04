import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isEligibleSignatureSourceFile,
  mergeClaimAndCheckSignatureFiles,
  resolveSignatureRequestClaimId,
  shouldUseSignatureClaimFallback,
  signatureRequestDocumentFields,
  signatureRequestsRegionMode,
  signatureSourceFilesQueryKey,
  SIGNATURE_REQUESTS_UNLINKED_COPY,
} from "../src/lib/signature-source-files.ts";

const CHECK_A = "3916f620-9d20-499b-8450-9e1a8e70a3c9";
const CHECK_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CLAIM = "1de2f734-de37-404a-aa3e-d23905f7a6ea";

test("accepts only pdf and docx names", () => {
  assert.equal(isEligibleSignatureSourceFile({ file_name: "UI-SIGNATURE-TEST-UNSIGNED.pdf" }), true);
  assert.equal(isEligibleSignatureSourceFile({ file_name: "Release.DOCX" }), true);
  assert.equal(isEligibleSignatureSourceFile({ file_name: "front.jpg" }), false);
  assert.equal(isEligibleSignatureSourceFile({ file_name: "notes.txt" }), false);
});

test("includes current-check files and linked claim files, then dedupes by path", () => {
  const merged = mergeClaimAndCheckSignatureFiles({
    checkIntakeItemId: CHECK_A,
    checkFiles: [
      {
        id: "check-pdf",
        check_intake_item_id: CHECK_A,
        file_name: "UI-SIGNATURE-TEST-UNSIGNED.pdf",
        file_path: `check-intake/${CHECK_A}/files/ui.pdf`,
      },
      {
        id: "other-check-pdf",
        check_intake_item_id: CHECK_B,
        file_name: "other-check.pdf",
        file_path: `check-intake/${CHECK_B}/files/other.pdf`,
      },
      {
        id: "check-image",
        check_intake_item_id: CHECK_A,
        file_name: "rear.png",
        file_path: `check-intake/${CHECK_A}/files/rear.png`,
      },
    ],
    claimFiles: [
      {
        id: "claim-pdf",
        claim_id: CLAIM,
        file_name: "claim-packet.pdf",
        file_path: `claims/${CLAIM}/packet.pdf`,
      },
      {
        id: "dup-claim",
        claim_id: CLAIM,
        file_name: "UI-SIGNATURE-TEST-UNSIGNED.pdf",
        file_path: `check-intake/${CHECK_A}/files/ui.pdf`,
      },
    ],
  });
  assert.deepEqual(merged.map((row) => row.id), ["check-pdf", "claim-pdf"]);
  assert.equal(merged[0]._source, "check_file");
  assert.equal(merged[1]._source, "claim_file");
});

test("does not include another check's files even if they are eligible", () => {
  const merged = mergeClaimAndCheckSignatureFiles({
    checkIntakeItemId: CHECK_A,
    checkFiles: [{
      id: "foreign",
      check_intake_item_id: CHECK_B,
      file_name: "foreign.pdf",
      file_path: "check-intake/other/foreign.pdf",
    }],
    claimFiles: [],
  });
  assert.equal(merged.length, 0);
});

test("does not invent files from another tenant payload", () => {
  const merged = mergeClaimAndCheckSignatureFiles({
    checkIntakeItemId: CHECK_A,
    checkFiles: [],
    claimFiles: [],
  });
  assert.equal(merged.length, 0);
});

test("signature request fields keep the selected path and check id", () => {
  const fields = signatureRequestDocumentFields({
    claimId: CLAIM,
    checkIntakeItemId: CHECK_A,
    documentName: "UI-SIGNATURE-TEST-UNSIGNED.pdf",
    documentPath: `check-intake/${CHECK_A}/files/ui.pdf`,
  });
  assert.equal(fields.claim_id, CLAIM);
  assert.equal(fields.check_intake_item_id, CHECK_A);
  assert.equal(fields.document_path, `check-intake/${CHECK_A}/files/ui.pdf`);
});

test("Files tab remounts SignatureRequests and the wizard can select check files", () => {
  const wizard = readFileSync("src/components/claim-detail/SignatureRequests.tsx", "utf8");
  const files = readFileSync("src/components/check-review/CheckFilesSection.tsx", "utf8");
  const ccc = readFileSync("src/pages/CheckCommandCenter.tsx", "utf8");
  assert.match(files, /import \{ SignatureRequests \}/);
  assert.match(files, /<SignatureRequests/);
  assert.match(files, /checkIntakeItemId=\{checkIntakeItemId\}/);
  assert.match(files, /claimId\?: string \| null/);
  assert.match(files, /resolveSignatureRequestClaimId\(claimId, null\)/);
  assert.match(files, /resolveSignatureRequestClaimId\(suppliedClaimId, checkClaim\?\.claim_id\)/);
  assert.match(files, /enabled: shouldUseSignatureClaimFallback\(suppliedClaimId\)/);
  assert.match(files, /data-testid="signature-requests-region"/);
  assert.match(files, /data-testid="signature-requests-unlinked"/);
  assert.match(files, /SIGNATURE_REQUESTS_UNLINKED_COPY/);
  assert.match(files, /\.select\("id, claim_id"\)/);
  assert.doesNotMatch(files, /claims:claim_id/);
  assert.doesNotMatch(files, /linkedClaim\?\.id && \(\s*<SignatureRequests/);
  assert.match(files, /signatureSourceFilesQueryKey/);
  assert.match(ccc, /<CheckFilesSection checkIntakeItemId=\{checkId\} claimId=\{check\?\.claim_id \?\? null\} \/>/);
  assert.match(wizard, /signatureSourceFilesQueryKey/);
  assert.match(wizard, /mergeClaimAndCheckSignatureFiles/);
  assert.match(wizard, /Select a file from claim\/check files/);
  assert.match(wizard, /from\("check_files"\)/);
  assert.match(wizard, /check_intake_item_id: checkIntakeItemId \|\| null/);
  assert.match(wizard, /\.from\("signature_requests"\)/);
  assert.match(wizard, /\.from\("signature_signers"\)/);
  assert.match(wizard, /functions\.invoke\("send-signature-request"/);
  assert.doesNotMatch(wizard, /file_name\.ilike\.%\.pdf/);
  assert.equal(signatureSourceFilesQueryKey(CLAIM, CHECK_A)[0], "signature-source-files");
});

test("CCC claim ID wins over a failed or empty secondary lookup", () => {
  assert.equal(resolveSignatureRequestClaimId(CLAIM, null), CLAIM);
  assert.equal(resolveSignatureRequestClaimId(CLAIM, undefined), CLAIM);
  assert.equal(resolveSignatureRequestClaimId(CLAIM, ""), CLAIM);
  assert.equal(shouldUseSignatureClaimFallback(CLAIM), false);
  assert.equal(signatureRequestsRegionMode(resolveSignatureRequestClaimId(CLAIM, null)), "requests");
});

test("secondary lookup is used only when CCC did not supply a claim ID", () => {
  assert.equal(resolveSignatureRequestClaimId(null, CLAIM), CLAIM);
  assert.equal(shouldUseSignatureClaimFallback(null), true);
  assert.equal(shouldUseSignatureClaimFallback(""), true);
  assert.equal(signatureRequestsRegionMode(resolveSignatureRequestClaimId(null, CLAIM)), "requests");
});

test("genuinely unlinked checks stay on the visible empty state", () => {
  assert.equal(resolveSignatureRequestClaimId(null, null), null);
  assert.equal(resolveSignatureRequestClaimId("", undefined), null);
  assert.equal(signatureRequestsRegionMode(null), "unlinked");
  assert.match(SIGNATURE_REQUESTS_UNLINKED_COPY, /not linked to a claim/);
  assert.doesNotMatch(SIGNATURE_REQUESTS_UNLINKED_COPY, /create a claim/i);
});
