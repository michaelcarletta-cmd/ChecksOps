#!/usr/bin/env node
/**
 * Build a narrow production overlay on live index-DJNHggvS.js.
 * Bundles SignatureRequests against live vendor export letters and
 * rewires only CheckFilesSection → CheckCommandCenter → index.html.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DIR = process.env.CHECKSOPS_LIVE_SPA_DIR || '/tmp/prod-sig-overlay/live';
const OUT_DIR = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-sig-overlay/dist';
const LIVE_ENTRY = 'index-DJNHggvS.js';
const LIVE_CSS = 'index-D9SwIqYu.css';
const LIVE_FILES = 'CheckFilesSection-DC3uOrqc.js';
const LIVE_CCC = 'CheckCommandCenter-B-yV-W5w.js';
const LIVE_DTP = 'SharedCheckPaymentDirection-CxW2noA2.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const viteHash = (buf) => {
  const b64 = createHash('sha256').update(buf).digest('base64url').replace(/[^A-Za-z0-9_-]/g, '');
  return b64.slice(0, 8);
};

const shimDir = path.join(ROOT, 'scripts/overlays/restore-sig-files-ui/shims');
const srcRoot = path.join(ROOT, 'src');

const main = async () => {
  const liveIndex = path.join(LIVE_DIR, LIVE_ENTRY);
  const liveFiles = path.join(LIVE_DIR, LIVE_FILES);
  const liveCcc = path.join(LIVE_DIR, LIVE_CCC);
  const liveHtml = path.join(LIVE_DIR, 'index.html');
  if (!fs.existsSync(liveIndex) || !fs.existsSync(liveFiles) || !fs.existsSync(liveCcc) || !fs.existsSync(liveHtml)) {
    throw new Error(`live SPA files missing under ${LIVE_DIR}`);
  }
  const liveIndexSha = sha256(fs.readFileSync(liveIndex));
  if (liveIndexSha !== 'f7d5696b275fe6d2dbd1227c8e054c67a5ae5f3696708d685d6de9a583c18f94') {
    throw new Error(`live index sha drift ${liveIndexSha}`);
  }

  const tmpOut = path.join('/tmp/prod-sig-overlay', 'sig-bundle.js');
  const tmpCss = path.join('/tmp/prod-sig-overlay', 'sig-bundle.css');
  fs.mkdirSync('/tmp/prod-sig-overlay', { recursive: true });

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
    throw new Error('overlay bundle did not import live index-DJNHggvS.js');
  }
  if (!sigJs.includes('Send for Signature') || !sigJs.includes('Use Existing Claim/Check File')) {
    throw new Error('overlay bundle missing accepted Signature copy');
  }
  if (sigJs.includes('index-CHCA-uIh') || sigJs.includes('index-Ci-gXTsO') || sigJs.includes('index-D6clKLTq')) {
    throw new Error('overlay bundle still points at a wholesale candidate index');
  }

  const sigName = `SignatureRequests-${viteHash(sigJs)}.js`;
  const filesLive = fs.readFileSync(liveFiles, 'utf8');
  if (filesLive.includes('Send for Signature') || filesLive.includes('SignatureRequests')) {
    throw new Error('live files chunk unexpectedly already has Signature UI');
  }

  let filesJs = filesLive;
  filesJs = filesJs.replace(
    'import"./CheckImageCropper-BlGyQebC.js";',
    `import"./CheckImageCropper-BlGyQebC.js";import{SignatureRequests as sigReq}from"./${sigName}";`,
  );
  if (!filesJs.includes(`from"./${sigName}"`)) throw new Error('failed to import overlay SignatureRequests');

  const injectQuery = ',{data:checkClaim}=T({queryKey:["check-signature-claim",l],queryFn:async()=>{const{data:s2,error:t2}=await o.from("check_intake_items").select("id, claim_id, claims:claim_id(id, claim_number, policyholder_name, policyholder_email)").eq("id",l).maybeSingle();if(t2)throw t2;return s2}}),nestedClaim=checkClaim&&checkClaim.claims||null,resolvedClaimId=nestedClaim&&nestedClaim.id||checkClaim&&checkClaim.claim_id||null,linkedClaim=nestedClaim||(resolvedClaimId?{id:resolvedClaimId,claim_number:null,policyholder_name:null,policyholder_email:null}:null)';
  if (!filesJs.includes('return s??[]}}),S=async s=>{')) {
    throw new Error('live files query splice point missing');
  }
  filesJs = filesJs.replace('return s??[]}}),S=async s=>{', `return s??[]}}${injectQuery},S=async s=>{`);

  filesJs = filesJs.replaceAll(
    'y.invalidateQueries({queryKey:["check-files",l]})',
    'y.invalidateQueries({queryKey:["check-files",l]}),y.invalidateQueries({queryKey:["signature-source-files",resolvedClaimId||null,l]})',
  );

  const downloadNeedle = 'title:"Download",children:e.jsx(R,{className:"h-3.5 w-3.5"})}),e.jsx(d,{size:"sm",variant:"ghost",className:"h-7 w-7 p-0 text-primary",onClick:()=>{confirm(`Send "';
  const downloadInsert = 'title:"Download",children:e.jsx(R,{className:"h-3.5 w-3.5"})}),/\\.pdf$/i.test(s.file_name)&&linkedClaim&&linkedClaim.id&&e.jsx(d,{size:"sm",variant:"ghost",className:"h-7 w-7 p-0 text-primary",onClick:()=>{localStorage.setItem("preselected_sig_file",JSON.stringify({id:s.id,file_name:s.file_name,file_path:s.file_path})),window.dispatchEvent(new Event("preselected-sig-file"))},title:"Send for Homeowner Signature",children:e.jsx(K,{className:"h-3.5 w-3.5"})}),e.jsx(d,{size:"sm",variant:"ghost",className:"h-7 w-7 p-0 text-primary",onClick:()=>{confirm(`Send "';
  if (!filesJs.includes(downloadNeedle)) throw new Error('live files download splice point missing');
  filesJs = filesJs.replace(downloadNeedle, downloadInsert);

  const dialogNeedle = 'e.jsx(W,{open:!!n,onOpenChange:()=>v(null)';
  const dialogInsert = 'linkedClaim&&linkedClaim.id&&e.jsx(sigReq,{claimId:linkedClaim.id,claim:linkedClaim,checkIntakeItemId:l}),e.jsx(W,{open:!!n,onOpenChange:()=>v(null)';
  if (!filesJs.includes(dialogNeedle)) throw new Error('live files dialog splice point missing');
  filesJs = filesJs.replace(dialogNeedle, dialogInsert);

  if (!filesJs.includes('sigReq') || !filesJs.includes('Send for Homeowner Signature') || !filesJs.includes('check-signature-claim')) {
    throw new Error('files overlay missing mount/query');
  }

  const filesName = `CheckFilesSection-${viteHash(filesJs)}.js`;
  let cccJs = fs.readFileSync(liveCcc, 'utf8');
  if (!cccJs.includes(LIVE_FILES) || !cccJs.includes(LIVE_DTP)) {
    throw new Error('live CCC missing expected Files/DTP chunks');
  }
  cccJs = cccJs.replaceAll(LIVE_FILES, filesName);
  if (cccJs.includes(LIVE_FILES) || !cccJs.includes(filesName) || !cccJs.includes(LIVE_DTP)) {
    throw new Error('CCC rewrite failed or DTP import was lost');
  }
  const cccName = `CheckCommandCenter-${viteHash(cccJs)}.js`;

  let entryJs = fs.readFileSync(liveIndex, 'utf8');
  if (!entryJs.includes(LIVE_CCC)) throw new Error('live entry missing CCC');
  entryJs = entryJs.replaceAll(LIVE_CCC, cccName);
  if (entryJs.includes(LIVE_CCC) || !entryJs.includes(cccName)) {
    throw new Error('entry CCC rewrite failed');
  }
  const entryName = `index-${viteHash(entryJs)}.js`;

  const html = fs.readFileSync(liveHtml, 'utf8').replaceAll(`/assets/${LIVE_ENTRY}`, `/assets/${entryName}`);
  if (!html.includes(`/assets/${entryName}`) || html.includes(LIVE_ENTRY) || !html.includes(LIVE_CSS)) {
    throw new Error('index.html rewrite failed or lost live CSS');
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });
  const writes = {
    [`assets/${sigName}`]: sigJs,
    [`assets/${filesName}`]: filesJs,
    [`assets/${cccName}`]: cccJs,
    [`assets/${entryName}`]: entryJs,
    'index.html': html,
  };
  if (fs.existsSync(tmpCss) && fs.statSync(tmpCss).size > 0) {
    const css = fs.readFileSync(tmpCss);
    const cssName = `SignatureRequests-${viteHash(css)}.css`;
    writes[`assets/${cssName}`] = css;
    writes['index.html'] = writes['index.html'].replace(
      `href="/assets/${LIVE_CSS}">`,
      `href="/assets/${LIVE_CSS}">\n  <link rel="stylesheet" crossorigin href="/assets/${cssName}">`,
    );
  }
  for (const [rel, body] of Object.entries(writes)) {
    fs.writeFileSync(path.join(OUT_DIR, rel), body);
  }

  const report = {
    ok: true,
    mode: 'live-djnh-overlay',
    live_entry: `/assets/${LIVE_ENTRY}`,
    live_entry_sha: liveIndexSha,
    live_files: `/assets/${LIVE_FILES}`,
    live_ccc: `/assets/${LIVE_CCC}`,
    live_dtp: `/assets/${LIVE_DTP}`,
    live_css: `/assets/${LIVE_CSS}`,
    candidate_entry: `/assets/${entryName}`,
    candidate_entry_sha: sha256(Buffer.from(entryJs)),
    candidate_index_sha: sha256(fs.readFileSync(path.join(OUT_DIR, 'index.html'))),
    candidate_files: `/assets/${filesName}`,
    candidate_files_sha: sha256(Buffer.from(filesJs)),
    candidate_ccc: `/assets/${cccName}`,
    candidate_sig: `/assets/${sigName}`,
    candidate_sig_sha: sha256(Buffer.from(sigJs)),
    uploaded_keys_only: Object.keys(writes),
    dtp_untouched: LIVE_DTP,
    wholesale_candidate_not_used: true,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/prod-restore-sig-files-overlay-build.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
