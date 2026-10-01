import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canMoveTenantChecks } from "../src/lib/tenantCheckUser.ts";
import {
  loadTenantCheckIdentity,
  parseIdentityTenantAccess,
} from "../src/lib/tenantCheckIdentity.ts";

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

test("identity/me membership is tenant-scoped and fails closed", () => {
  const staffOutside = parseIdentityTenantAccess({
    applicationUserId: "u1",
    roles: ["staff"],
    tenants: [{ tenant_id: "other-tenant", role: "member" }],
  }, "current-tenant");
  assert.deepEqual(staffOutside, { roles: ["staff"], isTenantMember: false, tenantRole: null });
  assert.equal(canMoveTenantChecks({
    systemRoles: staffOutside.roles,
    isTenantMember: staffOutside.isTenantMember,
  }), false);

  const member = parseIdentityTenantAccess({
    applicationUserId: "u1",
    roles: [],
    tenants: [{ tenant_id: "current-tenant", role: "member" }],
  }, "current-tenant");
  assert.equal(member.isTenantMember, true);
  assert.equal(member.tenantRole, "member");
  assert.equal(canMoveTenantChecks({
    systemRoles: member.roles,
    isTenantMember: member.isTenantMember,
  }), true);

  assert.deepEqual(parseIdentityTenantAccess({ ok: false, applicationUserId: "u1" }, "t"), {
    roles: [],
    isTenantMember: false,
    tenantRole: null,
  });
});

test("identity/me tenant lookup refuses legacy hosts and fails closed", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ applicationUserId: "u1", roles: ["staff"], tenants: [] }) };
  }) as typeof fetch;

  const refused = await loadTenantCheckIdentity({
    tenantId: "t1",
    apiBaseUrl: "https://nbcqwpysqgyxrrbgtmkw.supabase.co",
    idToken: "token",
    fetchImpl,
  });
  assert.deepEqual(refused, { roles: [], isTenantMember: false, tenantRole: null });
  assert.deepEqual(calls, []);

  const failed = await loadTenantCheckIdentity({
    tenantId: "t1",
    apiBaseUrl: "https://api.example.test",
    idToken: "token",
    fetchImpl: (async () => {
      throw new Error("network");
    }) as typeof fetch,
  });
  assert.deepEqual(failed, { roles: [], isTenantMember: false, tenantRole: null });
});

test("check movement UI uses tenant-user access instead of admin-only", () => {
  const review = readFileSync("src/components/check-review/CheckReviewConsole.tsx", "utf8");
  const command = readFileSync("src/pages/CheckCommandCenter.tsx", "utf8");
  const reupload = readFileSync("src/components/checks/ReuploadCheckImageButton.tsx", "utf8");
  const lossDraft = readFileSync("src/components/loss-draft/detail/LossDraftActionsTab.tsx", "utf8");
  const hook = readFileSync("src/hooks/useCanMoveChecks.ts", "utf8");
  assert.match(review, /useCanMoveChecks/);
  assert.match(command, /useCanMoveChecks/);
  assert.match(reupload, /useCanMoveChecks/);
  assert.match(lossDraft, /useCanMoveChecks/);
  assert.doesNotMatch(review, /isAdmin && \(/);
  assert.doesNotMatch(hook, /@\/integrations\/supabase\/client/);
  assert.doesNotMatch(hook, /from\("tenant_users"\)/);
  assert.doesNotMatch(hook, /isAdmin \|\| isStaff/);
  assert.match(hook, /loadTenantCheckIdentity/);
  assert.match(command, /isWhiteLabel && \["admin", "owner"\]\.includes/);
  assert.doesNotMatch(command, /canAccessManager = canMoveChecks/);
});
