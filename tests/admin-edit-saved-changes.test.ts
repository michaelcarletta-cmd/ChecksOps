import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pickAwsSafeIntakeUpdates } from "../src/integrations/aws/safeIntakeFields.ts";
import {
  omitSkippedAdminEditChanges,
  summarizeAdminEditSave,
} from "../src/components/check-review/adminEditSavedChanges.ts";

test("drops leftover AWS-prohibited intake keys from the success toast after a status RPC", () => {
  const persist = pickAwsSafeIntakeUpdates({
    amount: 1250.5,
    routing_number: "021000021",
    account_number: "123456789",
  });
  assert.deepEqual(persist.safe, {});
  assert.deepEqual(persist.skipped, ["amount", "routing_number", "account_number"]);

  const summary = summarizeAdminEditSave(
    [
      "status → needs review",
      "amount → $1250.50",
      "routing # → ***0021",
      "account # → ***6789",
    ],
    persist.skipped,
  );

  assert.deepEqual(summary.savedMessages, ["status → needs review"]);
  assert.equal(summary.toast.kind, "success");
  assert.equal(summary.toast.message, "Saved: status → needs review");
  assert.equal(
    summary.warning,
    "AWS staging cannot save amount, routing number, or account number",
  );
  assert.match(summary.toast.message, /status → needs review/);
  assert.doesNotMatch(summary.toast.message, /amount/);
  assert.doesNotMatch(summary.toast.message, /routing/);
  assert.doesNotMatch(summary.toast.message, /account/);
});

test("keeps persisted descriptive fields when a mixed AWS save skips financial columns", () => {
  const persist = pickAwsSafeIntakeUpdates({
    payee_line: "Jane Doe",
    amount: 99,
    routing_number: "021000021",
  });
  assert.deepEqual(persist.safe, { payee_line: "Jane Doe" });
  assert.deepEqual(persist.skipped, ["amount", "routing_number"]);

  const summary = summarizeAdminEditSave(
    ["payee → Jane Doe", "amount → $99.00", "routing # → ***0021"],
    persist.skipped,
  );

  assert.deepEqual(summary.savedMessages, ["payee → Jane Doe"]);
  assert.equal(summary.toast.message, "Saved: payee → Jane Doe");
  assert.equal(summary.warning, "AWS staging cannot save amount or routing number");
});

test("reports no changes when every leftover key was skipped", () => {
  const summary = summarizeAdminEditSave(
    ["amount → $10.00"],
    ["amount"],
  );
  assert.deepEqual(summary.savedMessages, []);
  assert.equal(summary.toast.kind, "info");
  assert.equal(summary.toast.message, "No changes to save");
  assert.equal(summary.warning, "AWS staging cannot save amount");
});

test("does not treat an unrelated status message as a skipped amount", () => {
  assert.deepEqual(
    omitSkippedAdminEditChanges(["status → needs review"], ["amount"]),
    ["status → needs review"],
  );
});

test("admin edit dialog filters skipped keys before the success toast", () => {
  const source = readFileSync("src/components/check-review/CheckAdminEditDialog.tsx", "utf8");
  assert.match(source, /summarizeAdminEditSave/);
  assert.match(source, /skippedIntakeFields/);
  assert.match(source, /saveSummary\.toast/);
  assert.doesNotMatch(
    source,
    /toast\.success\(`Saved: \$\{changes\.join\(", "\)\}`\)/,
  );
});
