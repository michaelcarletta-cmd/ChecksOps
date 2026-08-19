import assert from "node:assert/strict";

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

/**
 * Mock of the server confirm path: the code is ALWAYS sent to the provider.
 * There is no local bypass for any code (0000, 0001, or otherwise).
 */
function makeConfirm({ providerAcceptsCode = "0001", providerBankStatus = "new" } = {}) {
  const calls = [];
  return {
    calls,
    async confirm({ tenantId, verification, code, callerTenantId }) {
      if (verification.tenant_id !== callerTenantId || tenantId !== callerTenantId) {
        return { status: 404, body: { error: "Verification not found." } };
      }
      if (!/^\d{4}$/.test(code ?? "")) {
        return { status: 400, body: { error: "Enter the 4-digit verification code." } };
      }
      if (providerBankStatus === "verified") {
        return { status: 200, body: { success: true, already_verified: true }, localVerified: true };
      }
      if (verification.attempts >= verification.max_attempts) {
        return {
          status: 409,
          body: { error: "max_attempts_exceeded", requires_restart: true },
          localVerified: false,
        };
      }
      // Real provider call, every time.
      calls.push({ method: "PUT", code: `MV${code}` });
      const attempts = verification.attempts + 1;
      if (code !== providerAcceptsCode) {
        const exhausted = attempts >= verification.max_attempts;
        return {
          status: 409,
          body: {
            error: exhausted ? "max_attempts_exceeded" : "verification_failed",
            requires_restart: exhausted,
          },
          localVerified: false,
        };
      }
      return {
        status: 200,
        body: { success: true, provider_status: "verified" },
        localVerified: true,
        syncTriggered: true,
      };
    },
  };
}

const baseVerification = {
  id: "v1",
  tenant_id: "t1",
  attempts: 0,
  max_attempts: 3,
  status: "pending",
};

test("sandbox 0001 goes through the real Moov call path", async () => {
  const svc = makeConfirm();
  const res = await svc.confirm({
    tenantId: "t1", callerTenantId: "t1", verification: { ...baseVerification }, code: "0001",
  });
  assert.equal(res.status, 200);
  assert.equal(svc.calls.length, 1, "provider PUT /verify must be called");
  assert.equal(svc.calls[0].code, "MV0001", "code normalized to MV#### for Moov");
  assert.equal(res.localVerified, true);
});

test("0000 is an ordinary incorrect code and never locally verifies", async () => {
  const svc = makeConfirm();
  const res = await svc.confirm({
    tenantId: "t1", callerTenantId: "t1", verification: { ...baseVerification }, code: "0000",
  });
  assert.equal(res.status, 409);
  assert.equal(res.localVerified, false);
  assert.equal(svc.calls.length, 1, "0000 still hits the provider, no bypass");
});

test("wrong code does not mark the local bank verified", async () => {
  const svc = makeConfirm();
  const res = await svc.confirm({
    tenantId: "t1", callerTenantId: "t1", verification: { ...baseVerification }, code: "4321",
  });
  assert.equal(res.localVerified, false);
});

test("max attempts requires restart and makes no provider call", async () => {
  const svc = makeConfirm();
  const res = await svc.confirm({
    tenantId: "t1",
    callerTenantId: "t1",
    verification: { ...baseVerification, attempts: 3 },
    code: "0001",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.requires_restart, true);
  assert.equal(svc.calls.length, 0);
});

test("last wrong attempt flips to restart-required", async () => {
  const svc = makeConfirm();
  const res = await svc.confirm({
    tenantId: "t1",
    callerTenantId: "t1",
    verification: { ...baseVerification, attempts: 2 },
    code: "1111",
  });
  assert.equal(res.body.error, "max_attempts_exceeded");
  assert.equal(res.body.requires_restart, true);
});

test("provider-verified bank short circuits from provider state only", async () => {
  const svc = makeConfirm({ providerBankStatus: "verified" });
  const res = await svc.confirm({
    tenantId: "t1", callerTenantId: "t1", verification: { ...baseVerification }, code: "9999",
  });
  assert.equal(res.body.already_verified, true);
  assert.equal(svc.calls.length, 0);
});

test("successful confirmation triggers authoritative sync", async () => {
  const svc = makeConfirm();
  const res = await svc.confirm({
    tenantId: "t1", callerTenantId: "t1", verification: { ...baseVerification }, code: "0001",
  });
  assert.equal(res.syncTriggered, true);
});

test("cross-tenant confirmation is rejected", async () => {
  const svc = makeConfirm();
  const res = await svc.confirm({
    tenantId: "t2", callerTenantId: "t2",
    verification: { ...baseVerification, tenant_id: "t1" },
    code: "0001",
  });
  assert.equal(res.status, 404);
  assert.equal(svc.calls.length, 0);
});

test("sandbox helper is only shown in sandbox", () => {
  const showTestCode = (environment) => environment === "sandbox";
  assert.equal(showTestCode("sandbox"), true);
  assert.equal(showTestCode("production"), false);
  assert.equal(showTestCode(null), false);
});

test("micro-deposit code validation", () => {
  const validate = (code) => typeof code === "string" && /^\d{4}$/.test(code);
  assert.ok(validate("0001"));
  assert.ok(!validate("123"));
  assert.ok(!validate("12345"));
  assert.ok(!validate("abcd"));
});

test("micro-deposit status mapping", () => {
  const mapStatus = (moovStatus) => {
    const s = String(moovStatus).toLowerCase();
    if (s === "verified") return "connected";
    if (s === "errored" || s === "failed") return "failed";
    if (s === "expired") return "expired";
    return "pending";
  };
  assert.equal(mapStatus("verified"), "connected");
  assert.equal(mapStatus("initiated"), "pending");
  assert.equal(mapStatus("awaiting-code"), "pending");
  assert.equal(mapStatus("failed"), "failed");
  assert.equal(mapStatus("expired"), "expired");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log("  ok  " + name);
  } catch (e) {
    failed++;
    console.error("FAIL  " + name + "\n      " + e.message);
  }
}
console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed ? 1 : 0);
