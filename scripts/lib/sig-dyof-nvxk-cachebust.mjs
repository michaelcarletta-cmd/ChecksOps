/**
 * Cache-bust the already-applied DyoF/nvXk Files Signature overlay.
 *
 * Production already serves the patched CheckFilesSection-nvXkZh5q.js bytes, but
 * that same hashed URL is Cache-Control: immutable. Normal browsers keep the
 * pre-overlay wizard; private windows do not. This builder leaves DyoF, CCC,
 * Sign, DTP, and Lambda untouched. It copies the patched Files bytes to a new
 * hashed URL and remaps the old URL from index.html via an import map so the
 * next regular visit loads the working overlay without rewriting the module graph.
 */
import { createHash } from 'node:crypto';
import {
  EXPECTED_CCC_SHA256,
  EXPECTED_ENTRY_SHA256,
  EXPECTED_FILES_SHA256,
  EXPECTED_HTML_SHA256,
  LIVE_CCC,
  LIVE_ENTRY,
  LIVE_FILES,
  filesInvariants,
  patchDyofNvxkFiles,
} from './sig-dyof-nvxk-files-patch.mjs';

export const LIVE_CSS = 'index-C6onCFE-.css';
export const LIVE_SIGN = 'Sign-CPLc-MwJ.js';
export const LIVE_DTP = 'SharedCheckPaymentDirection-CDUDGHWu.js';

export const PATCHED_FILES_SHA256 =
  'd029f3a4bb1073846730a0deedcedc3677edd9b62404e7238ab12959bdbb8087';

export {
  EXPECTED_CCC_SHA256,
  EXPECTED_ENTRY_SHA256,
  EXPECTED_FILES_SHA256,
  EXPECTED_HTML_SHA256,
  LIVE_CCC,
  LIVE_ENTRY,
  LIVE_FILES,
  filesInvariants,
  patchDyofNvxkFiles,
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const newFilesNameFor = (source) =>
  `CheckFilesSection-${sha256(source).slice(0, 8)}.js`;

export const ENTRY_SCRIPT =
  `<script type="module" crossorigin src="/assets/${LIVE_ENTRY}"></script>`;

export const importMapTag = (fromFile, toFile) =>
  `<script type="importmap">{"imports":{"/assets/${fromFile}":"/assets/${toFile}"}}</script>`;

export const htmlInvariants = (source, newFiles) => {
  const html = String(source);
  return {
    keeps_dyof_entry: html.includes(ENTRY_SCRIPT),
    keeps_live_css: html.includes(`/assets/${LIVE_CSS}`),
    has_importmap: html.includes('type="importmap"'),
    remaps_nvxk: html.includes(`"/assets/${LIVE_FILES}":"/assets/${newFiles}"`),
    no_c9qr: !html.includes('index-C9QrEEkl.js'),
    no_bjz: !html.includes('CheckFilesSection-BJZPqPpX.js'),
    single_module_entry: (html.match(/type="module"/g) || []).length === 1,
  };
};

export const resolvePatchedFiles = (source) => {
  const js = String(source);
  if (js.includes('index-C9QrEEkl.js') || js.includes('CheckFilesSection-BJZPqPpX.js')) {
    throw new Error('refused C9Qr/BJZ restore over current DyoF/nvXk live');
  }
  const alreadyPatched = js.includes('check-intake/${w}/files/') && !js.includes('signatures/${r}/');
  const patched = alreadyPatched ? js : patchDyofNvxkFiles(js);
  const invariants = filesInvariants(patched);
  const failed = Object.entries(invariants).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) {
    throw new Error(`cachebust Files invariants failed: ${failed.join(',')}`);
  }
  return patched;
};

export const injectNvXkImportMap = (html, newFiles) => {
  const source = String(html);
  if (source.includes('type="importmap"')) {
    throw new Error('index.html already has an import map; refuse double overlay');
  }
  if (!source.includes(ENTRY_SCRIPT)) {
    throw new Error('index.html lost the current DyoF entry script');
  }
  if (source.includes('index-C9QrEEkl.js') || source.includes('CheckFilesSection-BJZPqPpX.js')) {
    throw new Error('index.html references retired C9Qr/BJZ; refuse restore');
  }
  if (!newFiles || newFiles === LIVE_FILES) {
    throw new Error('cachebust requires a new Files filename');
  }
  const next = source.replace(ENTRY_SCRIPT, `${importMapTag(LIVE_FILES, newFiles)}\n  ${ENTRY_SCRIPT}`);
  const invariants = htmlInvariants(next, newFiles);
  const failed = Object.entries(invariants).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) {
    throw new Error(`cachebust HTML invariants failed: ${failed.join(',')}`);
  }
  return next;
};

export const buildNvXkCachebust = ({ html, files }) => {
  const patched = resolvePatchedFiles(files);
  const newFiles = newFilesNameFor(patched);
  if (newFiles === LIVE_FILES) {
    throw new Error('patched Files hashed to the live nvXk filename');
  }
  const nextHtml = injectNvXkImportMap(html, newFiles);
  return {
    new_files: newFiles,
    new_files_key: `assets/${newFiles}`,
    files: patched,
    html: nextHtml,
    files_sha256: sha256(patched),
    html_sha256: sha256(nextHtml),
    writes: {
      [`assets/${newFiles}`]: patched,
      'index.html': nextHtml,
    },
    files_invariants: filesInvariants(patched),
    html_invariants: htmlInvariants(nextHtml, newFiles),
  };
};
