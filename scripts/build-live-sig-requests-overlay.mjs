#!/usr/bin/env node
/**
 * Rebuild SignatureRequests from current source against the CURRENT live
 * production SPA (single React entry). Rewrites only:
 *   assets/CheckFilesSection-0Fmhwbep.js  (same URL)
 *   assets/SignatureRequests-<hash>.js    (new asset)
 *   optional SignatureRequests CSS
 * Does not write index.html, index-*.js, or CheckCommandCenter-*.js.
 * Does not deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import {
  LIVE_CCC,
  LIVE_DTP,
  LIVE_FILES,
  PINNED_CURRENT_LIVE,
  REFUSE_PROD_DEPLOY,
  assertCurrentLiveGraph,
  assertSingleEntryWrites,
  rewriteFilesSignatureImport,
  sha256,
  viteHash,
} from './lib/live-sig-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DIR = process.env.CHECKSOPS_LIVE_SPA_DIR || '/tmp/prod-live-now';
const OUT_DIR = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-live-sig-requests/dist';
const shimDir = path.join(ROOT, 'scripts/overlays/restore-sig-files-ui/shims');
const srcRoot = path.join(ROOT, 'src');

const readLive = (name) => {
  const filePath = path.join(LIVE_DIR, name);
  if (!fs.existsSync(filePath)) throw new Error(`live file missing: ${filePath}`);
  return fs.readFileSync(filePath);
};

const main = async () => {
  if (process.env.CHECKSOPS_ALLOW_PROD_WRITE) {
    throw new Error(REFUSE_PROD_DEPLOY);
  }

  const indexHtml = readLive('index.html');
  const entryJs = readLive('index-DJNHggvS.js');
  const cccJs = readLive('CheckCommandCenter-M7p55m49.js');
  const filesJs = readLive('CheckFilesSection-0Fmhwbep.js');
  const dtpJs = fs.existsSync(path.join(LIVE_DIR, 'SharedCheckPaymentDirection-CxW2noA2.js'))
    ? readLive('SharedCheckPaymentDirection-CxW2noA2.js')
    : null;
  assertCurrentLiveGraph({ indexHtml, entryJs, cccJs, filesJs, dtpJs });

  const tmpOut = path.join('/tmp/prod-live-sig-requests', 'sig-bundle.js');
  const tmpCss = path.join('/tmp/prod-live-sig-requests', 'sig-bundle.css');
  fs.mkdirSync('/tmp/prod-live-sig-requests', { recursive: true });

  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, 'scripts/overlays/restore-sig-files-ui/entry.ts')],
    bundle: true,
    format: 'esm',
    outfile: tmpOut,
    jsx: 'automatic',
    platform: 'browser',
    target: 'es2020',
    legalComments: 'none',
    sourcemap: false,
    minify: true,
    external: ['index-DJNHggvS'],
    plugins: [
      {
        name: 'live-vendor-and-src-alias',
        setup(build) {
          const aliases = new Map([
            ['react', path.join(shimDir, 'react.js')],
            ['react/jsx-runtime', path.join(shimDir, 'jsx-runtime.js')],
            ['react/jsx-dev-runtime', path.join(shimDir, 'jsx-runtime.js')],
            ['@tanstack/react-query', path.join(shimDir, 'react-query.js')],
            ['@/integrations/supabase/client', path.join(shimDir, 'supabase.js')],
            ['@/hooks/use-toast', path.join(shimDir, 'use-toast.js')],
            ['@/hooks/useAuth', path.join(shimDir, 'useAuth.js')],
          ]);
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === 'index-DJNHggvS') return { path: 'index-DJNHggvS', external: true };
            if (aliases.has(args.path)) return { path: aliases.get(args.path) };
            if (!args.path.startsWith('@/')) return null;
            const base = path.join(srcRoot, args.path.slice(2));
            const candidates = [
              base,
              `${base}.ts`,
              `${base}.tsx`,
              `${base}.js`,
              `${base}.jsx`,
              path.join(base, 'index.ts'),
              path.join(base, 'index.tsx'),
            ];
            const hit = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
            if (!hit) return null;
            return { path: hit };
          });
        },
      },
    ],
    loader: {
      '.png': 'empty',
      '.svg': 'empty',
      '.woff2': 'empty',
    },
    logOverride: { 'empty-import-meta': 'silent' },
  });
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.text).join('\n'));

  let sigJs = fs.readFileSync(tmpOut, 'utf8').replaceAll('from"index-DJNHggvS"', 'from"./index-DJNHggvS.js"');
  if (!sigJs.includes('from"./index-DJNHggvS.js"')) {
    throw new Error('SignatureRequests bundle did not import canonical index-DJNHggvS.js');
  }
  if (sigJs.includes('index-QKetcACR') || sigJs.includes('index-CHCA-uIh') || sigJs.includes('index-Ci-gXTsO')) {
    throw new Error('SignatureRequests bundle points at a retired or wholesale entry');
  }
  if (!sigJs.includes('Send for Signature') || !sigJs.includes('Request Signature')) {
    throw new Error('SignatureRequests bundle missing required copy');
  }
  if (!sigJs.includes('checkIntakeItemId') || !sigJs.includes('signature-source-files')) {
    throw new Error('SignatureRequests bundle lost check-scoped source-file wiring');
  }

  const sigName = `SignatureRequests-${viteHash(sigJs)}.js`;
  const repairedFiles = rewriteFilesSignatureImport(filesJs.toString(), sigName);

  const writes = {
    [`assets/${sigName}`]: sigJs,
    'assets/CheckFilesSection-0Fmhwbep.js': repairedFiles,
  };
  if (fs.existsSync(tmpCss) && fs.statSync(tmpCss).size > 0) {
    const css = fs.readFileSync(tmpCss);
    writes[`assets/SignatureRequests-${viteHash(css)}.css`] = css;
  }
  assertSingleEntryWrites(writes);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });
  for (const [rel, body] of Object.entries(writes)) {
    fs.writeFileSync(path.join(OUT_DIR, rel), body);
  }

  const report = {
    ok: true,
    mode: 'current-live-sig-requests-same-entry',
    deployed: false,
    live_entry: '/assets/index-DJNHggvS.js',
    live_entry_sha: PINNED_CURRENT_LIVE.djnh_sha256,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    live_dtp: LIVE_DTP,
    live_files_sha: PINNED_CURRENT_LIVE.files_sha256,
    candidate_files: '/assets/CheckFilesSection-0Fmhwbep.js',
    candidate_files_sha: sha256(repairedFiles),
    candidate_sig: `/assets/${sigName}`,
    candidate_sig_sha: sha256(sigJs),
    uploaded_keys_only: Object.keys(writes),
    index_html_untouched: true,
    djn_untouched: true,
    ccc_untouched: true,
    qketcacr_left_in_place: true,
    single_react_entry_preserved: true,
    older_spa_not_restored: true,
    source_matches_live_sig: sha256(sigJs) === PINNED_CURRENT_LIVE.sig_sha256,
    source_matches_live_files: sha256(repairedFiles) === PINNED_CURRENT_LIVE.files_sha256,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/live-sig-requests-overlay-build.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main };
