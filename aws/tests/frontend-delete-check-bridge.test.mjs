import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowDeleteCheckBody } from "../../src/integrations/aws/deleteCheckBridge.ts";

test("bridge sends reason + actor_id (trimmed)", () => {
  const checkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { checkId: outId, body } = buildWorkflowDeleteCheckBody({
    check_id: checkId,
    reason: " duplicate ",
    actor_id: " actor ",
  });

  assert.equal(outId, checkId);
  assert.equal(body.check_id, checkId);
  assert.equal(body.reason, "duplicate");
  assert.equal(body.actor_id, "actor");
});

test("bridge forwards trimmed reason from supabase rpc args shape", () => {
  const checkId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { checkId: outId, body } = buildWorkflowDeleteCheckBody({
    p_check_id: checkId,
    p_reason: " duplicate ",
  });

  assert.equal(outId, checkId);
  assert.equal(body.check_id, checkId);
  assert.equal(body.reason, "duplicate");
});

test("bridge does not validate reason min length; backend remains authority", () => {
  const checkId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const { body } = buildWorkflowDeleteCheckBody({ check_id: checkId, reason: "ab" });
  assert.equal(body.reason, "ab");
});

test("bridge omits empty reason after trimming", () => {
  const checkId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const { body } = buildWorkflowDeleteCheckBody({ check_id: checkId, reason: "   " });
  assert.equal(body.check_id, checkId);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "reason"), false);
});

