import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shouldUseAwsChecksOpsBackendFor } from "../src/lib/backendMode.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Freedom Claims hosts never use ChecksOps AWS backend", () => {
  const authProvider = "cognito";
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "freedomclaims.work", authProvider }),
    false,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "www.freedomclaims.work", authProvider }),
    false,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "freedomclaims.lovable.app", authProvider }),
    false,
  );
});

test("ChecksOps platform hosts use AWS backend when authProvider=cognito", () => {
  const authProvider = "cognito";
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "checksops.com", authProvider }),
    true,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "www.checksops.com", authProvider }),
    true,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "staging.checksops.com", authProvider }),
    true,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "mortgage.checksops.com", authProvider }),
    true,
  );
});

test("Local dev uses AWS backend when authProvider=cognito", () => {
  const authProvider = "cognito";
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "localhost", authProvider }),
    true,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "127.0.0.1", authProvider }),
    true,
  );
});

test("Non-cognito auth never uses ChecksOps AWS backend", () => {
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "checksops.com", authProvider: "" }),
    false,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "checksops.com", authProvider: "supabase" }),
    false,
  );
});

test("brandingPublicUrl keeps stored URLs unless ChecksOps AWS backend is active", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/brandingPublicUrl.ts"), "utf8");
  assert.match(src, /shouldUseAwsChecksOpsBackendFor/);
  assert.match(src, /runtimeHostname/);
  assert.match(src, /if\s*\(\s*!shouldRewriteBrandingToAws\(\)\s*\)\s*return raw/);
});

