import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("admin_delete_check dispatcher forwards delete body from shared helper", () => {
  const client = fs.readFileSync(path.join(ROOT, "src/integrations/aws/client.ts"), "utf8");
  assert.ok(
    client.includes('import { buildWorkflowDeleteCheckBody } from "./deleteCheckBridge";'),
    "client.ts must import buildWorkflowDeleteCheckBody",
  );
  assert.ok(
    client.includes('if (name === "admin_delete_check") {'),
    "client.ts must implement admin_delete_check dispatcher",
  );
  assert.ok(
    client.includes("const { checkId, body: deleteBody } = buildWorkflowDeleteCheckBody(args);"),
    "admin_delete_check must call shared delete body builder",
  );
  assert.match(client, /apiFetch\(`\/workflow\/checks\/\$\{encodeURIComponent\(checkId\)\}`/);
  assert.match(client, /method:\s*\"DELETE\"/);
  assert.match(client, /body:\s*JSON\.stringify\(deleteBody\)/);
});

