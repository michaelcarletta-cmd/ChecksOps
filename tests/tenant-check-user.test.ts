import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canMoveTenantChecks } from "../src/lib/tenantCheckUser.ts";
import {
  loadTenantCheckIdentity,
  parseIdentityTenantAccess,
} from "../src/lib/tenantCheckIdentity.ts";

test("any company user can move checks without an admin role", () => {
  assert.equal(canMoveTenantChecks({ systemRoles: ["staff"], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ systemRoles: [], isTenantMember: true }), true);
  assert.equal(canMoveTenantChecks({ systemRoles: ["read_only"], isTenantMember: true }), true);
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
    tenants: [{ tenant_id: "current-tenant", role: "viewer" }],
  }, "current-tenant");
  assert.equal(member.isTenantMember, true);
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

test("check movement UI treats every company user the same", () => {
  const review = readFileSync("src/components/check-review/CheckReviewConsole.tsx", "utf8");
  const command = readFileSync("src/pages/CheckCommandCenter.tsx", "utf8");
  const reupload = readFileSync("src/components/checks/ReuploadCheckImageButton.tsx", "utf8");
  const lossDraft = readFileSync("src/components/loss-draft/detail/LossDraftActionsTab.tsx", "utf8");
  const hook = readFileSync("src/hooks/useCanMoveChecks.ts", "utf8");
  const helper = readFileSync("src/lib/tenantCheckUser.ts", "utf8");
  assert.match(review, /useCanMoveChecks/);
  assert.match(command, /useCanMoveChecks/);
  assert.match(reupload, /useCanMoveChecks/);
  assert.match(lossDraft, /useCanMoveChecks/);
  assert.doesNotMatch(review, /isAdmin && \(/);
  assert.match(hook, /isAwsStaging/);
  assert.match(hook, /loadTenantCheckIdentity/);
  assert.match(hook, /@\/integrations\/supabase\/client/);
  assert.match(hook, /from\("tenant_users"\)/);
  assert.doesNotMatch(hook, /isAdmin \|\| isStaff/);
  assert.match(command, /canAccessManager = canMoveChecks/);
  assert.doesNotMatch(command, /\["admin", "owner"\]/);
  assert.doesNotMatch(helper, /OPERATING_TENANT_ROLES/);
  assert.doesNotMatch(helper, /VIEW_ONLY_TENANT_ROLES/);
});

test("SQL override uses tenant membership, not role titles", () => {
  const sql = readFileSync(
    "supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql",
    "utf8",
  );
  assert.match(sql, /user_can_move_tenant_checks/);
  assert.match(sql, /user_belongs_to_tenant\(_user_id, _tenant_id\)/);
  assert.doesNotMatch(sql, /lower\(role::text\)/);
  assert.doesNotMatch(sql, /'deposited'/);
});
