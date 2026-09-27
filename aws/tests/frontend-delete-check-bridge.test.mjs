import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildWorkflowDeleteCheckBody } from "../../src/integrations/aws/deleteCheckBridge.ts";

test("admin_delete_check bridge sends reason + actor_id in workflow delete body (trimmed)", () => {
  const { checkId, body } = buildWorkflowDeleteCheckBody({
    p_check_id: "33333333-3333-4333-8333-333333333333",
    p_actor_id: "11111111-1111-4111-8111-111111111111",
    p_reason: "  duplicate  ",
  });
  assert.equal(checkId, "33333333-3333-4333-8333-333333333333");
  assert.equal(body.check_id, checkId);
  assert.equal(body.actor_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(body.reason, "duplicate");
});

test("admin_delete_check bridge omits empty reason key (backend remains authority)", () => {
  const { body } = buildWorkflowDeleteCheckBody({
    p_check_id: "33333333-3333-4333-8333-333333333333",
    p_actor_id: "11111111-1111-4111-8111-111111111111",
    p_reason: "   ",
  });
  assert.equal(body.check_id, "33333333-3333-4333-8333-333333333333");
  assert.ok(!("reason" in body));
});

test("AWS admin_delete_check request payload includes check_id and supplied deletion reason", () => {
  const { body } = buildWorkflowDeleteCheckBody({
    p_check_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    p_reason: "duplicate",
  });
  const payload = JSON.stringify(body);
  assert.match(payload, /"check_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"/);
  assert.match(payload, /"reason":"duplicate"/);

  const client = readFileSync(new URL("../../src/integrations/aws/client.ts", import.meta.url), "utf8");
  assert.match(client, /buildWorkflowDeleteCheckBody/);
  assert.match(client, /JSON\.stringify\(deleteBody\)/);
  assert.doesNotMatch(client, /JSON\.stringify\(\{\s*check_id:\s*checkId\s*\}\)/);
});
