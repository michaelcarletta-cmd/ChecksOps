import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canMoveTenantChecks } from "../src/lib/tenantCheckUser.ts";

test("a tenant user can move checks without an admin role", () => {
  assert.equal(canMoveTenantChecks({ systemRoles: ["staff"], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ systemRoles: [], isTenantMember: true }), true);
});

test("platform admin can move checks without tenant membership", () => {
  assert.equal(canMoveTenantChecks({ systemRoles: ["admin"], isTenantMember: false }), true);
});

test("outsiders without a tenant_users row cannot move checks", () => {
  assert.equal(canMoveTenantChecks({ systemRoles: ["client"], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ systemRoles: ["contractor"], isTenantMember: false }), false);
  assert.equal(canMoveTenantChecks({ systemRoles: ["staff"], isTenantMember: false }), false);
});

test("check movement UI uses tenant-user access instead of admin-only", () => {
  const review = readFileSync("src/components/check-review/CheckReviewConsole.tsx", "utf8");
  const command = readFileSync("src/pages/CheckCommandCenter.tsx", "utf8");
  const reupload = readFileSync("src/components/checks/ReuploadCheckImageButton.tsx", "utf8");
  const lossDraft = readFileSync("src/components/loss-draft/detail/LossDraftActionsTab.tsx", "utf8");
  assert.match(review, /useCanMoveChecks/);
  assert.match(command, /useCanMoveChecks/);
  assert.match(reupload, /useCanMoveChecks/);
  assert.match(lossDraft, /useCanMoveChecks/);
  assert.doesNotMatch(review, /isAdmin && \(/);
});
