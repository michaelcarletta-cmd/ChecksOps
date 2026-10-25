import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AWS_PROHIBITED_INTAKE_COLUMNS,
  pickAwsSafeIntakeUpdates,
} from "../src/integrations/aws/safeIntakeFields.ts";
import {
  STAGING_UAT_CREATE_REVIEW_NOTE,
  STAGING_UAT_SYNTHETIC_AMOUNT,
  buildAwsStagingCheckCreateValues,
} from "../src/integrations/aws/uatSyntheticCheck.ts";

test("ordinary staging upload omits amount, routing, and account", () => {
  const values = buildAwsStagingCheckCreateValues({
    isAwsStaging: true,
    syntheticUat: false,
    skipAi: false,
  });
  assert.equal("amount" in values, false);
  assert.equal("routing_number" in values, false);
  assert.equal("account_number" in values, false);
  assert.equal(values.review_notes, "AWS staging intake");
});

test("ordinary staging manual-entry upload still omits amount", () => {
  const values = buildAwsStagingCheckCreateValues({
    isAwsStaging: true,
    syntheticUat: false,
    skipAi: true,
  });
  assert.equal("amount" in values, false);
  assert.equal(values.review_notes, "AWS staging intake — manual entry (OCR skipped)");
});

test("explicit staging UAT opt-in sends create-time $1.00 only", () => {
  const values = buildAwsStagingCheckCreateValues({
    isAwsStaging: true,
    syntheticUat: true,
    skipAi: true,
  });
  assert.equal(values.amount, 1.0);
  assert.equal(values.amount, STAGING_UAT_SYNTHETIC_AMOUNT);
  assert.equal(values.review_notes, STAGING_UAT_CREATE_REVIEW_NOTE);
  assert.equal("routing_number" in values, false);
  assert.equal("account_number" in values, false);
  assert.deepEqual(Object.keys(values).sort(), ["amount", "review_notes"]);
});

test("production path never receives a $1.00 default from this helper", () => {
  const values = buildAwsStagingCheckCreateValues({
    isAwsStaging: false,
    syntheticUat: true,
    skipAi: false,
  });
  assert.deepEqual(values, {});
});

test("post-create allowlist still rejects amount, routing, and account", () => {
  assert.equal(AWS_PROHIBITED_INTAKE_COLUMNS.has("amount"), true);
  assert.equal(AWS_PROHIBITED_INTAKE_COLUMNS.has("routing_number"), true);
  assert.equal(AWS_PROHIBITED_INTAKE_COLUMNS.has("account_number"), true);
  const persist = pickAwsSafeIntakeUpdates({
    amount: 1,
    routing_number: "000000000",
    account_number: "000000000000",
    carrier_name: "UAT TEST CARRIER",
  });
  assert.deepEqual(persist.safe, { carrier_name: "UAT TEST CARRIER" });
  assert.deepEqual(persist.skipped, ["amount", "routing_number", "account_number"]);
});

test("CheckUploadForm uses the UAT helper and does not hardcode amount on create", () => {
  const source = readFileSync("src/pages/CheckCommandCenter.tsx", "utf8");
  assert.match(source, /buildAwsStagingCheckCreateValues/);
  assert.match(source, /syntheticUat/);
  assert.match(source, /Synthetic UAT \/ VOID check/);
  assert.doesNotMatch(source, /createAwsCheck\([^)]*amount\s*:/);
  assert.doesNotMatch(
    source,
    /createAwsCheck\(token, \{\s*review_notes: skipAi \? "AWS staging intake — manual entry \(OCR skipped\)" : "AWS staging intake",\s*\}\)/,
  );
});
