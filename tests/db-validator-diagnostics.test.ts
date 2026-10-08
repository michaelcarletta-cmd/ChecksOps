import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  fetchDbValidatorDiagnostics,
  isDbValidatorUiEnabled,
  sanitizeDbValidatorResult,
} from "../src/lib/dbValidatorDiagnostics.ts";

const res = (status: number, body: unknown) =>
  ({ status, json: async () => body }) as unknown as Response;

test("issues GET without body and with bearer authorization only", async () => {
  let call: { url: string; init: RequestInit } | null = null;
  const out = await fetchDbValidatorDiagnostics({
    baseUrl: "https://api.example",
    getToken: async () => "tok",
    fetchImpl: async (url, init) => {
      call = { url: String(url), init: init as RequestInit };
      return res(200, { ok: true, readOnly: true, issues: [] });
    },
  });
  assert.equal(out.status, "success");
  assert.equal(call!.url, "https://api.example/db-readonly-validate");
  assert.equal(call!.init.method, "GET");
  assert.equal("body" in call!.init, false);
  assert.deepEqual(call!.init.headers, { authorization: "Bearer " + "tok" });
});

test("missing token never calls the network", async () => {
  let called = false;
  const out = await fetchDbValidatorDiagnostics({
    baseUrl: "x",
    getToken: async () => null,
    fetchImpl: async () => { called = true; return res(200, {}); },
  });
  assert.equal(out.status, "unauthorized");
  assert.equal(called, false);
});

test("401/403 show a safe unauthorized message; other failures are generic", async () => {
  for (const status of [401, 403]) {
    const out = await fetchDbValidatorDiagnostics({ baseUrl: "x", getToken: async () => "t", fetchImpl: async () => res(status, { secret: "s" }) });
    assert.equal(out.status, "unauthorized");
  }
  const err = await fetchDbValidatorDiagnostics({ baseUrl: "x", getToken: async () => "t", fetchImpl: async () => { throw new Error("tok leaked"); } });
  assert.equal(err.status, "error");
  assert.ok(!JSON.stringify(err).includes("leaked"));
});

test("503 body is sanitized to allowlisted fields", async () => {
  const out = await fetchDbValidatorDiagnostics({
    baseUrl: "x",
    getToken: async () => "t",
    fetchImpl: async () => res(503, {
      ok: false,
      password: "hunter2",
      tables: [{ table: "claims", count: 5 }],
      issues: [{ kind: "permission", severity: "error", code: "42501", table: "claims", message: "host=db.internal pw=x" }],
    }),
  });
  assert.equal(out.status, "success");
  assert.deepEqual((out as any).summary.issues, [{ kind: "permission", severity: "error", code: "42501", table: "claims", probe: null }]);
  assert.ok(!JSON.stringify(out).includes("hunter2"));
  assert.ok(!JSON.stringify(out).includes("db.internal"));
});

test("sanitizer rejects unsafe identifiers", () => {
  const s = sanitizeDbValidatorResult({ issues: [{ kind: "<script>", severity: "x", code: "bad", table: "a;drop" }] });
  assert.deepEqual(s.issues[0], { kind: "unknown", severity: "unknown", code: null, table: null, probe: null });
});

test("admin and staging gates", () => {
  const base = { authProvider: "cognito", hostname: "staging.checksops.com", isAdmin: true };
  assert.equal(isDbValidatorUiEnabled(base), true);
  assert.equal(isDbValidatorUiEnabled({ ...base, isAdmin: false }), false);
  assert.equal(isDbValidatorUiEnabled({ ...base, hostname: "www.checksops.com" }), false);
  assert.equal(isDbValidatorUiEnabled({ ...base, authProvider: "supabase" }), false);
});

test("Review/Endorsing sources do not reference the validator", () => {
  for (const f of [
    "../src/components/check-review/CheckReviewConsole.tsx",
  ]) {
    assert.ok(!readFileSync(new URL(f, import.meta.url), "utf8").includes("db-readonly-validate"));
  }
});

test("App route remains wired for the staging admin page", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes('path="/admin/db-validator"'));
  assert.ok(app.includes("AdminDbValidator"));
});
