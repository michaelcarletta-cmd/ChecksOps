import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VITE = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function resolveChromeBin() {
  const candidates = [
    process.env.CHECKSOPS_CHROME_BIN,
    process.env.CHROME_BIN,
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function entryFromIndexHtml(html) {
  const match = String(html || '').match(/\/assets\/index-[^"'\s]+\.js/);
  return match ? match[0] : null;
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(dir);
  return out;
}

function startStaticServer({ rootDir }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const rel = pathname.replace(/^\//, '');
    const abs = rel ? path.join(rootDir, rel) : path.join(rootDir, 'index.html');
    const indexAbs = path.join(rootDir, 'index.html');

    const sendFile = (file) => {
      try {
        const buf = fs.readFileSync(file);
        const contentType = file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.js')
            ? 'application/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream';
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }
    };

    // Serve direct file if present; otherwise SPA fallback to index.html.
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return sendFile(abs);
    } catch {
      /* ignore */
    }
    return sendFile(indexAbs);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/`,
      });
    });
  });
}

function buildAwsProductionSpa({ outDir, env }) {
  const mergedEnv = {
    ...process.env,
    ...env,
  };
  execFileSync(VITE, ['build', '--mode', 'aws', '--outDir', outDir, '--emptyOutDir'], {
    cwd: REPO_ROOT,
    env: mergedEnv,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

test('AWS production SPA build hardening: config, bundle scan, and bootstrap', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-aws-prod-spa-'));
  buildAwsProductionSpa({
    outDir,
    env: {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://checksops.com',
      VITE_CHECKSOPS_API_URL: '/prep',
      VITE_AWS_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
      // Explicitly ensure no Supabase vars exist in the build env.
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_PUBLISHABLE_KEY: '',
    },
  });

  const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const entry = entryFromIndexHtml(indexHtml);
  assert.ok(entry, 'dist index.html must reference an /assets/index-*.js entry bundle');
  const entryAbs = path.join(outDir, entry.replace(/^\//, ''));
  const entryJs = fs.readFileSync(entryAbs, 'utf8');

  // Required build-time selectors must be inlined effectively.
  assert.ok(/"cognito"\.toLowerCase\(\)==="cognito"/.test(entryJs), 'AWS build must inline auth provider as cognito');
  assert.ok(entryJs.includes('"/prep"'), 'AWS production build must include /prep API base');
  assert.ok(!/""\.toLowerCase\(\)==="cognito"/.test(entryJs), 'AWS build must never inline empty auth provider');

  // AWS mode must not embed production Supabase endpoints or publishable tokens.
  const forbidden = [
    /\.supabase\.co/i,
    /sb_publishable_/i,
    /PRODUCTION_ANON_FALLBACK/i,
    /nbcqwpysqgyxrrbgtmkw/i,
  ];
  for (const file of listFiles(outDir)) {
    if (!/\.(js|html|css)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const re of forbidden) {
      assert.ok(!re.test(text), `AWS build must not embed Supabase material: ${re} in ${path.basename(file)}`);
    }
  }

  // Browser bootstrap: no uncaught exception and must progress beyond "Loading…".
  const chrome = resolveChromeBin();
  assert.ok(
    chrome,
    'Chrome/Chromium not found for puppeteer-core. Set CHECKSOPS_CHROME_BIN or install google-chrome in CI.',
  );
  const { server, url } = await startStaticServer({ rootDir: outDir });
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: chrome,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 10_000));

      assert.equal(pageErrors.length, 0, `bootstrap threw: ${pageErrors.map((e) => e.message).join(' | ')}`);

      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      assert.ok(!/Loading/i.test(bodyText), 'candidate remained on Loading…');
      assert.ok(/Sign in/i.test(bodyText), 'expected marketing shell to render (Sign in CTA)');
      // Hash for debugging stability (not asserted against a fixed value).
      assert.ok(sha256Text(bodyText).length === 64);
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('AWS production SPA build hardening: missing selector fails fast', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-aws-prod-spa-misconfig-'));
  assert.throws(() => {
    buildAwsProductionSpa({
      outDir,
      env: {
        // Missing/invalid selector (root cause of the incident).
        VITE_AUTH_PROVIDER: '',
        VITE_APP_URL: 'https://checksops.com',
        VITE_CHECKSOPS_API_URL: '/prep',
        VITE_AWS_REGION: 'us-east-1',
        VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
        VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
      },
    });
  }, /AWS frontend build misconfigured/i);
});

