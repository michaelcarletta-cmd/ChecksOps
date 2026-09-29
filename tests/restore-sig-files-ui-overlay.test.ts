import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("production overlay promote is TOCTOU-pinned to DJNHggvS and forbids wholesale/Lambda writes", () => {
  const script = readFileSync("scripts/promote-production-restore-sig-files-ui-spa.mjs", "utf8");
  assert.match(script, /LIVE_ENTRY = '\/assets\/index-DJNHggvS\.js'/);
  assert.match(script, /f7d5696b275fe6d2dbd1227c8e054c67a5ae5f3696708d685d6de9a583c18f94/);
  assert.match(script, /badfee4ae6331d5b3080f9cad174218f1cd62d0e419ee8fd06f3fc8063f2cc20/);
  assert.match(script, /l7jbBJFMdg6glEyXkcUuUaSJlLiZGkZi/);
  assert.match(script, /SharedCheckPaymentDirection-CxW2noA2\.js/);
  assert.match(script, /forbidden Lambda mutation/);
  assert.match(script, /index-CHCA-uIh/);
  assert.match(script, /index-Ci-gXTsO/);
  assert.match(script, /spa_drift/);
  assert.doesNotMatch(script, /update-function-code/);
});

test("overlay builder rewires live Files/CCC only and keeps DTP", () => {
  const script = readFileSync("scripts/build-production-restore-sig-files-overlay.mjs", "utf8");
  assert.match(script, /index-DJNHggvS\.js/);
  assert.match(script, /CheckFilesSection-DC3uOrqc\.js/);
  assert.match(script, /CheckCommandCenter-B-yV-W5w\.js/);
  assert.match(script, /SharedCheckPaymentDirection-CxW2noA2\.js/);
  assert.match(script, /Send for Signature/);
  assert.match(script, /wholesale_candidate_not_used/);
  assert.doesNotMatch(script, /s3api/);
});
