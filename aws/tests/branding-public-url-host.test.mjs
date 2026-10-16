import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_URL = pathToFileURL(path.join(ROOT, "src") + path.sep).href;

// Minimal stand-in for Vite: resolve "@/..." to src/*.ts and provide
// import.meta.env for src modules (Vite injects it at build time).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const file = path.join(ROOT, "src", rel.endsWith(".ts") ? rel : `${rel}.ts`);
      return nextResolve(pathToFileURL(file).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith(SRC_URL) && url.endsWith(".ts")) {
      const source = String(result.source);
      return {
        ...result,
        source: `import.meta.env = globalThis.__VITE_ENV__ || {};\n${source}`,
      };
    }
    return result;
  },
});

globalThis.__VITE_ENV__ = { MODE: "production", VITE_AUTH_PROVIDER: "cognito" };
const { brandingPublicUrl } = await import("../../src/lib/brandingPublicUrl.ts");

const API = "https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging";
const OBJECT_PATH = "2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/logo-1790801891632.png";
const SUPABASE_LOGO = "https://xyzcompany.supabase.co/storage/v1/object/public/tenant-logos/acme/logo.png";

function onHost(hostname, fn, mode = "aws") {
  const previous = globalThis.window;
  const previousMode = globalThis.__VITE_ENV__.MODE;
  globalThis.__VITE_ENV__.MODE = mode;
  globalThis.window = { location: { hostname, origin: `https://${hostname}` } };
  try {
    return fn();
  } finally {
    globalThis.__VITE_ENV__.MODE = previousMode;
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

const rewritten = (value) => `${API}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(value)}`;

test("AWS build rewrites on every host, tenant custom domains included", () => {
  for (const host of ["checksops.com", "staging.checksops.com", "localhost", "claims.acme-roofing.com", "portal.example.org"]) {
    onHost(host, () => {
      assert.equal(brandingPublicUrl(OBJECT_PATH, "tenant-logos", API), rewritten(OBJECT_PATH), host);
      assert.equal(brandingPublicUrl(SUPABASE_LOGO, "tenant-logos", API), rewritten("acme/logo.png"), host);
      assert.equal(brandingPublicUrl("https://cdn.example/logo.png", "tenant-logos", API), "https://cdn.example/logo.png", host);
    });
  }
});

test("javascript:/data:/blob:/file: values are refused on every host and build", () => {
  const unsafe = ["javascript:alert(1)", "data:image/png;base64,AAAA", "blob:https://x/1", "file:///etc/passwd"];
  for (const mode of ["aws", "production"]) {
    for (const host of ["checksops.com", "claims.acme-roofing.com"]) {
      onHost(host, () => {
        for (const value of unsafe) assert.equal(brandingPublicUrl(value, "tenant-logos", API), null, `${mode} ${host} ${value}`);
        assert.equal(brandingPublicUrl("", "tenant-logos", API), null);
      }, mode);
    }
  }
});

test("non-AWS build: ChecksOps hosts with Cognito still rewrite as before", () => {
  for (const host of ["checksops.com", "staging.checksops.com", "localhost"]) {
    onHost(host, () => {
      assert.equal(brandingPublicUrl(OBJECT_PATH, "tenant-logos", API), rewritten(OBJECT_PATH), host);
    }, "production");
  }
});

test("brandingPublicUrl follows the data client's AWS backend decision", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/brandingPublicUrl.ts"), "utf8");
  assert.match(src, /if \(env\.MODE === "aws"\) return true;/);
  assert.match(src, /shouldUseAwsChecksOpsBackendFor/);
  assert.match(src, /if\s*\(\s*!shouldRewriteBrandingToAws\(\)\s*\)/);
  assert.doesNotMatch(src, /freedom/i);
});
