#!/usr/bin/env node
/**
 * Pre-publish key match check.
 *
 * Prevents the "unregistered api key" outage from recurring by verifying
 * that .env.production ships the same Supabase publishable key and URL
 * that .env (source of truth from the Lovable Cloud binding) has.
 *
 * If the values drift, the build fails loudly instead of publishing a
 * bundle with a dead key.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REQUIRED_KEYS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PROJECT_ID",
];

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const out = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

const envPath = path.join(ROOT, ".env");
const prodPath = path.join(ROOT, ".env.production");

const env = parseEnv(envPath);
const prod = parseEnv(prodPath);

if (!env) {
  // .env is only present in the Lovable editor sandbox. In the hosted build
  // environment it doesn't exist — skip the drift check there.
  console.log("[check-publish-keys] .env not present (hosted build) — skipping drift check.");
  process.exit(0);
}
if (!prod) {
  console.error("[check-publish-keys] .env.production not found — production bundle would ship without Supabase keys.");
  process.exit(1);
}

const problems = [];
for (const key of REQUIRED_KEYS) {
  const a = env[key];
  const b = prod[key];
  if (!a) problems.push(`.env is missing ${key}`);
  if (!b) problems.push(`.env.production is missing ${key}`);
  if (a && b && a !== b) {
    problems.push(
      `${key} mismatch: .env has "${a.slice(0, 12)}…" but .env.production has "${b.slice(0, 12)}…"`
    );
  }
}

if (problems.length) {
  console.error("\n[check-publish-keys] Publish blocked — key drift detected:");
  for (const p of problems) console.error("  - " + p);
  console.error(
    "\nFix: copy the current values from .env into .env.production, then rebuild.\n"
  );
  process.exit(1);
}

console.log("[check-publish-keys] ✓ .env and .env.production Supabase keys match.");
