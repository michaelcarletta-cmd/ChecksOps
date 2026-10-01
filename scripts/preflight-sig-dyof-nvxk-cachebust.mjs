#!/usr/bin/env node
/**
 * Read-only HTTPS preflight for the DyoF/nvXk Files cache-bust.
 * Confirms current live still mounts DyoF/CCC/nvXk with the patched overlay,
 * then builds the import-map candidate in memory. Does not write AWS.
 */
import { createRequire } from 'node:module';
import {
  EXPECTED_CCC_SHA256,
  EXPECTED_ENTRY_SHA256,
  EXPECTED_HTML_SHA256,
  LIVE_CCC,
  LIVE_ENTRY,
  LIVE_FILES,
  PATCHED_FILES_SHA256,
  buildNvXkCachebust,
  sha256,
} from './lib/sig-dyof-nvxk-cachebust.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const HOST = 'https://checksops.com';

const fetchText = async (url) => {
  const res = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
};

const main = async () => {
  const html = await fetchText(`${HOST}/`);
  const entryName = (html.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
  const entry = await fetchText(`${HOST}/assets/${LIVE_ENTRY}`);
  const ccc = await fetchText(`${HOST}/assets/${LIVE_CCC}`);
  const files = await fetchText(`${HOST}/assets/${LIVE_FILES}`);

  const pins = {
    html_sha256: sha256(html),
    html_entry: entryName,
    entry_sha256: sha256(entry),
    ccc_sha256: sha256(ccc),
    files_sha256: sha256(files),
    has_importmap: html.includes('type="importmap"'),
    ccc_imports_nvxk: ccc.includes(LIVE_FILES),
    files_check_scoped: files.includes('check-intake/${w}/files/'),
    files_has_signatures_claim: files.includes('signatures/${r}/'),
  };

  const errors = [];
  if (pins.html_entry !== `/assets/${LIVE_ENTRY}`) errors.push(`html_entry ${pins.html_entry}`);
  if (pins.html_sha256 !== EXPECTED_HTML_SHA256) errors.push(`index.html ${pins.html_sha256}`);
  if (pins.entry_sha256 !== EXPECTED_ENTRY_SHA256) errors.push(`DyoF ${pins.entry_sha256}`);
  if (pins.ccc_sha256 !== EXPECTED_CCC_SHA256) errors.push(`CCC ${pins.ccc_sha256}`);
  if (pins.files_sha256 !== PATCHED_FILES_SHA256 && pins.files_has_signatures_claim === false) {
    errors.push(`Files ${pins.files_sha256} is neither the live overlay nor the pre-overlay nvXk`);
  }
  if (pins.has_importmap) errors.push('index.html already has an import map');
  if (!pins.ccc_imports_nvxk) errors.push('CCC lost nvXk Files');
  if (files.includes('index-C9QrEEkl.js') || files.includes('CheckFilesSection-BJZPqPpX.js')) {
    errors.push('refused C9Qr/BJZ restore over current DyoF/nvXk live');
  }
  if (errors.length) {
    console.error(JSON.stringify({ stop: 'live_drifted', errors, pins }, null, 2));
    process.exit(3);
  }

  const built = buildNvXkCachebust({ html, files });
  acorn.parse(built.files, { ecmaVersion: 'latest', sourceType: 'module' });
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    writes: Object.keys(built.writes),
    live_entry: LIVE_ENTRY,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    new_files: built.new_files,
    files_sha256: built.files_sha256,
    html_sha256: built.html_sha256,
    pins,
    files_invariants: built.files_invariants,
    html_invariants: built.html_invariants,
    note: 'Read-only preflight. A designated release workstream must put the new Files object and index.html last. Do not restore C9Qr/BJZ. Do not rewrite DyoF/CCC/Sign/DTP/Lambda.',
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
