#!/usr/bin/env node
/**
 * Read-only preflight for the current DyoF/nvXk Files Signature overlay.
 * Fetches live HTTPS assets, applies the check-scoped + Class A patch in memory,
 * and refuses C9Qr/BJZ restore. Does not write S3, CloudFront, or Lambda.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  EXPECTED_CCC_SHA256,
  EXPECTED_ENTRY_SHA256,
  EXPECTED_FILES_SHA256,
  EXPECTED_HTML_SHA256,
  FILES_KEY,
  LIVE_CCC,
  LIVE_ENTRY,
  LIVE_FILES,
  filesInvariants,
  patchDyofNvxkFiles,
} from './lib/sig-dyof-nvxk-files-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const HOST = 'https://checksops.com';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const fetchText = async (url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
};

const main = async () => {
  const html = await fetchText(`${HOST}/`);
  const entryName = (html.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const entry = await fetchText(`${HOST}/assets/${LIVE_ENTRY}`);
  const ccc = await fetchText(`${HOST}/assets/${LIVE_CCC}`);
  const files = await fetchText(`${HOST}/${FILES_KEY}`);

  const pins = {
    html_sha256: sha256(html),
    html_entry: entryName,
    entry_sha256: sha256(entry),
    ccc_sha256: sha256(ccc),
    files_sha256: sha256(files),
    files_imports_dyof: files.includes(`from"./${LIVE_ENTRY}"`),
    ccc_imports_files: ccc.includes(LIVE_FILES),
    already_patched: files.includes('check-intake/${w}/files/'),
    still_has_signatures_claim: files.includes('signatures/${r}/'),
  };

  const errors = [];
  if (pins.html_entry !== `/assets/${LIVE_ENTRY}`) errors.push(`html_entry ${pins.html_entry}`);
  if (pins.html_sha256 !== EXPECTED_HTML_SHA256) errors.push(`index.html ${pins.html_sha256}`);
  if (pins.entry_sha256 !== EXPECTED_ENTRY_SHA256) errors.push(`DyoF ${pins.entry_sha256}`);
  if (pins.ccc_sha256 !== EXPECTED_CCC_SHA256) errors.push(`CCC ${pins.ccc_sha256}`);
  if (pins.files_sha256 !== EXPECTED_FILES_SHA256) errors.push(`Files ${pins.files_sha256}`);
  if (!pins.files_imports_dyof) errors.push('Files lost DyoF import');
  if (!pins.ccc_imports_files) errors.push('CCC lost nvXk Files');
  if (!pins.still_has_signatures_claim) errors.push('Files already lost signatures/${r} sites; refuse blind rewrite');
  if (files.includes('index-C9QrEEkl.js') || files.includes('CheckFilesSection-BJZPqPpX.js')) {
    errors.push('refused C9Qr/BJZ restore over current DyoF/nvXk live');
  }
  if (errors.length) {
    console.error(JSON.stringify({ stop: 'live_drifted', errors, pins }, null, 2));
    process.exit(3);
  }

  const patched = patchDyofNvxkFiles(files);
  acorn.parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  const report = {
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    target: FILES_KEY,
    live_entry: LIVE_ENTRY,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    before_files_sha256: pins.files_sha256,
    patched_files_sha256: sha256(patched),
    pins,
    ...filesInvariants(patched),
    note: 'Read-only preflight. A separately designated release workstream must overlay this patched nvXk Files object onto current live. Do not restore C9Qr/BJZ.',
  };
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
