#!/usr/bin/env node
/**
 * Build the known-good Signature inline transplant against current live Files.
 * Writes only assets/CheckFilesSection-0Fmhwbep.js locally. Does not deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_CURRENT_LIVE } from './lib/live-sig-baseline.mjs';
import {
  assertUntouchedHostGraph,
  transplantKnownGoodSignature,
} from './lib/sig-known-good-inline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DIR = process.env.CHECKSOPS_LIVE_SPA_DIR || '/tmp/prod-now';
const KNOWN_DIR = process.env.CHECKSOPS_KNOWN_GOOD_DIR || '/tmp/sig-hist';
const OUT_DIR = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-sig-known-good-inline/dist';

const read = (dir, name) => {
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) throw new Error(`missing ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
};

const main = () => {
  const indexHtml = read(LIVE_DIR, 'index.html');
  const entryJs = read(LIVE_DIR, 'index-DJNHggvS.js');
  const cccJs = read(LIVE_DIR, 'CheckCommandCenter-M7p55m49.js');
  const dtpJs = read(LIVE_DIR, 'SharedCheckPaymentDirection-CxW2noA2.js');
  const filesJs = read(LIVE_DIR, 'CheckFilesSection-0Fmhwbep.js');
  const knownGood = read(KNOWN_DIR, 'CheckFilesSection-CHseToMm.js');
  assertUntouchedHostGraph({ indexHtml, entryJs, cccJs, dtpJs });
  const result = transplantKnownGoodSignature({
    liveFilesJs: filesJs,
    knownGoodChseJs: knownGood,
  });

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });
  for (const [rel, body] of Object.entries(result.writes)) {
    fs.writeFileSync(path.join(OUT_DIR, rel), body);
  }

  const report = {
    ok: true,
    deployed: false,
    mode: 'known-good-signature-inline-files-only',
    ...result.report,
    live_entry: '/assets/index-DJNHggvS.js',
    live_entry_sha: PINNED_CURRENT_LIVE.djnh_sha256,
    ipdlcpz2_not_deleted: true,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/known-good-sig-inline-build.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

export { main };
