import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const vite = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
const builder = readFileSync(new URL("../../scripts/build-production-aws-spa.mjs", import.meta.url), "utf8");

test("aws mode still refuses production /prep and production Cognito", () => {
  assert.match(vite, /mode === "aws"/);
  assert.match(vite, /psr19uhop4/);
  assert.match(vite, /us-east-1_h00WorYMT/);
  assert.match(vite, /AWS staging build refused inherited production \/prep/);
});

test("production Cognito mode refuses staging execute-api and staging pool", () => {
  assert.match(vite, /Production Cognito SPA build refused staging execute-api/);
  assert.match(vite, /us-east-1_vPmQ7cL1F/);
  assert.match(vite, /VITE_CHECKSOPS_API_URL=\/prep/);
  assert.match(vite, /VITE_APP_URL=https:\/\/checksops.com/);
});

test("production AWS SPA builder uses --mode production and production Cognito /prep", () => {
  assert.match(builder, /vite', 'build', '--mode', 'production'/);
  assert.match(builder, /VITE_CHECKSOPS_API_URL=\/prep/);
  assert.match(builder, /VITE_APP_URL=https:\/\/checksops.com/);
  assert.match(builder, /us-east-1_h00WorYMT/);
  assert.match(builder, /3ja9fqaq2fjkv3i6up2varcqpe/);
  assert.doesNotMatch(builder, /--mode', 'aws'/);
  assert.match(builder, /entryJs\.includes\('psr19uhop4'\)/);
  assert.match(builder, /entryJs\.includes\('us-east-1_vPmQ7cL1F'\)/);
});
