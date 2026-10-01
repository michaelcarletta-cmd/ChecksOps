import assert from "node:assert/strict";
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

