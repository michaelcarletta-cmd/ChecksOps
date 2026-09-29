import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isEligibleSignatureSourceFile,
  mergeClaimAndCheckSignatureFiles,
  signatureRequestDocumentFields,
  signatureSourceFilesQueryKey,
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
  assert.match(files, /import \{ SignatureRequests \}/);
  assert.match(files, /<SignatureRequests/);
  assert.match(files, /checkIntakeItemId=\{checkIntakeItemId\}/);
  assert.match(files, /signatureSourceFilesQueryKey/);
  assert.match(wizard, /signatureSourceFilesQueryKey/);
  assert.match(wizard, /mergeClaimAndCheckSignatureFiles/);
  assert.match(wizard, /Select a file from claim\/check files/);
  assert.match(wizard, /from\("check_files"\)/);
  assert.match(wizard, /check_intake_item_id: checkIntakeItemId \|\| null/);
  assert.doesNotMatch(wizard, /file_name\.ilike\.%\.pdf/);
  assert.equal(signatureSourceFilesQueryKey(CLAIM, CHECK_A)[0], "signature-source-files");
});
