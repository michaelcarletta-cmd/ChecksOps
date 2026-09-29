import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("retired production overlay promote cannot restore the older SPA", () => {
  const script = readFileSync("scripts/promote-production-restore-sig-files-ui-spa.mjs", "utf8");
  assert.match(script, /REFUSE_OLDER_SPA/);
  assert.match(script, /REFUSE_PROD_DEPLOY/);
  assert.match(script, /forbidden Lambda mutation/);
  assert.doesNotMatch(script, /update-function-code/);
});

test("retired overlay builder is blocked from the pre-repair SPA graph", () => {
  const script = readFileSync("scripts/build-production-restore-sig-files-overlay.mjs", "utf8");
  assert.match(script, /REFUSE_OLDER_SPA/);
  assert.match(script, /CheckFilesSection-DC3uOrqc\.js/);
  assert.match(script, /CheckCommandCenter-B-yV-W5w\.js/);
  assert.doesNotMatch(script, /s3api/);
});
