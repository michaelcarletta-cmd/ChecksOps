import test from "node:test";
import assert from "node:assert/strict";

import { shouldUseAwsChecksOpsBackendFor } from "../src/lib/backendMode.ts";

test("Non-ChecksOps hosts never use ChecksOps AWS backend", () => {
  const authProvider = "cognito";
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "example.com", authProvider }),
    false,
  );
  assert.equal(
    shouldUseAwsChecksOpsBackendFor({ hostname: "app.example.com", authProvider }),
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

