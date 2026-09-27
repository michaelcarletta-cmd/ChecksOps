/**
 * Recursive SPA dependency graph walker.
 *
 * Starts at index.html and follows module scripts, stylesheets, static and
 * dynamic JS imports, Vite preload maps, and CSS url()/import references.
 * External absolute URLs are ignored. This is the complete-graph validator
 * that makes a missing lazy chunk fail before index.html can switch.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ASSET_RE = /(?:\/)?(?:assets\/[A-Za-z0-9_.@-]+-[A-Za-z0-9_-]{3,}\.[A-Za-z0-9]{1,8})/g;
const HTML_REF_RE = /(?:src|href)=["']([^"']+)["']/g;
const CSS_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g;
const JS_FROM_RE = /(?:import|export)\s+[^'"]*from\s*['"]([^'"]+)['"]/g;
const JS_BARE_IMPORT_RE = /import\s*['"]([^'"]+)['"]/g;
const JS_DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_PRELOAD_RE = /__vite__mapDeps[\s\S]{0,8000}?/g;

const LOCAL_PREFIXES = ['/', './', '../', 'assets/'];

export const REQUIRED_SURFACE_PREFIXES = {
  claim_check: ['assets/CheckCommandCenter-'],
  payee_endorsements: ['assets/EndorsementChecklist-', 'assets/Endorse-', 'assets/SharedCheckEndorsements-'],
  mortgage_desk: [
    'assets/AdminMortgageOps-',
    'assets/MortgageOpsQueue-',
    'assets/MortgageOpsLogin-',
    'assets/MortgageCompaniesDirectory-',
    'assets/MortgageCompanyEditorDialog-',
  ],
  admin_tenant_moov_billing: [
    'assets/AdminTenants-',
    'assets/AdminFinancialModel-',
    'assets/TenantBilling',
    'assets/WalletOps-',
  ],
};

export const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');

export const looksLikeHtml = (bytes, contentType = '') => {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const head = Buffer.from(bytes).subarray(0, 256).toString('utf8').trim().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
};

const isExternal = (ref) => /^(https?:|data:|blob:|mailto:)/i.test(ref);

const normalizeKey = (ref, fromKey = 'index.html') => {
  if (!ref || isExternal(ref)) return null;
  let cleaned = String(ref).split('?')[0].split('#')[0];
  if (!cleaned || cleaned.includes('${') || cleaned.includes('`')) return null;
  if (cleaned.startsWith('/')) cleaned = cleaned.slice(1);
  else if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
    cleaned = path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), cleaned));
  } else if (!cleaned.startsWith('assets/') && LOCAL_PREFIXES.some((p) => fromKey.startsWith('assets/'))) {
    cleaned = path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), cleaned));
  }
  if (cleaned.startsWith('../') || cleaned.includes('://')) return null;
  cleaned = cleaned.replace(/^\/+/, '');
  if (cleaned !== 'index.html' && !/\.[A-Za-z0-9]{1,8}$/.test(cleaned)) return null;
  return cleaned;
};

const pushRef = (out, ref, fromKey) => {
  const key = normalizeKey(ref, fromKey);
  if (key) out.add(key);
};

export const extractHtmlRefs = (html) => {
  const out = new Set();
  for (const match of String(html).matchAll(HTML_REF_RE)) pushRef(out, match[1], 'index.html');
  return [...out];
};

export const extractJsRefs = (source, fromKey) => {
  const out = new Set();
  const text = String(source);
  for (const re of [JS_FROM_RE, JS_BARE_IMPORT_RE, JS_DYNAMIC_RE]) {
    for (const match of text.matchAll(re)) pushRef(out, match[1], fromKey);
  }
  for (const chunk of text.matchAll(JS_PRELOAD_RE)) {
    for (const match of chunk[0].matchAll(ASSET_RE)) pushRef(out, match[0], fromKey);
  }
  for (const match of text.matchAll(ASSET_RE)) pushRef(out, match[0], fromKey);
  return [...out];
};

export const extractCssRefs = (source, fromKey) => {
  const out = new Set();
  const text = String(source);
  for (const match of text.matchAll(CSS_URL_RE)) pushRef(out, match[1], fromKey);
  for (const match of text.matchAll(CSS_IMPORT_RE)) pushRef(out, match[1], fromKey);
  for (const match of text.matchAll(ASSET_RE)) pushRef(out, match[0], fromKey);
  return [...out];
};

export const extractRefs = (key, bytes) => {
  const text = Buffer.from(bytes).toString('utf8');
  if (key.endsWith('.html')) return extractHtmlRefs(text);
  if (key.endsWith('.css')) return extractCssRefs(text, key);
  if (/\.(js|mjs|cjs)$/.test(key)) return extractJsRefs(text, key);
  return [];
};

export const walkGraph = ({ readObject, startKey = 'index.html' }) => {
  const seen = new Set();
  const missing = [];
  const objects = [];
  const edges = [];
  const queue = [startKey];
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const loaded = readObject(key);
    if (!loaded || loaded.missing) {
      missing.push(key);
      objects.push({ key, missing: true });
      continue;
    }
    const { bytes, contentType = '', extra = {} } = loaded;
    const html = looksLikeHtml(bytes, contentType);
    const sha256 = sha256Bytes(bytes);
    objects.push({
      key,
      bytes: bytes.length,
      sha256,
      contentType,
      htmlFallback: html && key !== 'index.html',
      ...extra,
    });
    if (html && key !== 'index.html') continue;
    for (const ref of extractRefs(key, bytes)) {
      edges.push({ from: key, to: ref });
      if (!seen.has(ref)) queue.push(ref);
    }
  }
  return { objects, missing, edges, startKey };
};

export const walkLocalDirectory = (rootDir, startKey = 'index.html') => walkGraph({
  startKey,
  readObject: (key) => {
    const filePath = path.join(rootDir, key);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { missing: true };
    return { bytes: fs.readFileSync(filePath) };
  },
});

export const requiredSurfaces = (objects) => {
  const keys = objects.filter((row) => !row.missing).map((row) => row.key);
  const report = {};
  for (const [name, prefixes] of Object.entries(REQUIRED_SURFACE_PREFIXES)) {
    const files = keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    report[name] = { present: files.length > 0, files };
  }
  return report;
};

export const graphStats = (graph) => ({
  object_count: graph.objects.length,
  present_count: graph.objects.filter((row) => !row.missing).length,
  missing_count: graph.missing.length,
  html_fallback_count: graph.objects.filter((row) => row.htmlFallback).length,
  missing: graph.missing,
});
