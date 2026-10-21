#!/usr/bin/env node
/**
 * Read-only hash report for ChecksOps: where every pinned hash comes from, and whether the
 * working tree, HEAD, origin/main and the pins agree.
 *
 * Usage:
 *   node scripts/hash-report.mjs                    # every production pin + the release-lock tree hashes
 *   node scripts/hash-report.mjs sql109             # one migration (pin file name, migration key or SQL path)
 *   node scripts/hash-report.mjs --file <path>      # any file: working tree / HEAD / origin/main sha256, CRLF
 *   node scripts/hash-report.mjs --hash <hex>       # where a sha256 is recorded and what it is the hash of
 *   node scripts/hash-report.mjs --json             # machine-readable
 *   node scripts/hash-report.mjs --root <dir>       # another checkout of this repository
 *
 * The report writes nothing and connects to nothing. It never prints a value to copy into a
 * pin or a test: a hash that differs is a question (which bytes changed, and why), not a
 * number to update. See .claude/skills/hashes/SKILL.md and AGENTS.md ("When CI fails").
 *
 * Hash kinds it knows:
 *   source_sha256                 sha256 of the migration file bytes on an LF checkout
 *   intended_replacement_sha256   releaseIntendedHash(key, file bytes): the code-derived fingerprint
 *                                 of the state the file leaves (release engine keys only)
 *   expected_live_definition_sha256
 *                                 the live pre-state read by an inspect; never derivable from code
 *   tree_hash                     release-lock ownership group: sha256 over "<rel>\0<sha256>" lines
 *   required_sql[].source_sha256  a locked component's pinned SQL bytes
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PATHS,
  computeOwnershipHashes,
  loadJson,
  repoRootFrom,
} from './lib/release-locks.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_PINS,
  RELEASE_SQL_SPECS,
  releaseIntendedHash,
} from './deployment-guard/lib/release-sql-state.mjs';

const PIN_DIR = 'ops/deployment-guard';
const PIN_SUFFIX = '-production-apply.json';
const SHA_RE = /^[0-9a-f]{64}$/;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (h) => (typeof h === 'string' && SHA_RE.test(h) ? `${h.slice(0, 12)}…` : JSON.stringify(h ?? null));

function git(root, args, { allowFail = true } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

function gitBytes(root, ref, rel) {
  try {
    return execFileSync('git', ['-C', root, 'show', `${ref}:${rel}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function refExists(root, ref) {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
}

/** sha256 of a file in the working tree, with its CRLF state and the LF-normalised hash. */
function fileHashes(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { exists: false };
  const bytes = fs.readFileSync(abs);
  const text = bytes.toString('latin1');
  const crlf = text.includes('\r\n');
  const out = { exists: true, sha256: sha(bytes), crlf };
  if (crlf) out.sha256_lf = sha(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
  return out;
}

function refHashes(root, rel, refs) {
  const out = {};
  for (const ref of refs) {
    const bytes = gitBytes(root, ref, rel);
    out[ref] = bytes ? sha(bytes) : null;
  }
  return out;
}

export function checkoutReport(root) {
  const branch = (git(root, ['branch', '--show-current']) || '').trim() || '(detached)';
  const head = (git(root, ['rev-parse', 'HEAD']) || '').trim();
  const autocrlf = (git(root, ['config', '--get', 'core.autocrlf']) || '').trim() || '(unset)';
  const eol = git(root, ['ls-files', '--eol']) || '';
  const crlfFiles = eol.split('\n').filter((line) => /^i\/\S*\s+w\/crlf\s/.test(line)).map((line) => line.split('\t').pop());
  const dirty = (git(root, ['status', '--porcelain']) || '').split('\n').filter(Boolean);
  const hasMain = refExists(root, 'origin/main');
  const shallow = (git(root, ['rev-parse', '--is-shallow-repository']) || '').trim() === 'true';
  let behind = null;
  let ahead = null;
  if (hasMain) {
    const counts = (git(root, ['rev-list', '--left-right', '--count', 'origin/main...HEAD']) || '').trim().split(/\s+/);
    behind = Number(counts[0] ?? 0);
    ahead = Number(counts[1] ?? 0);
  }
  const problems = [];
  if (autocrlf === 'true') problems.push('core.autocrlf=true: every pinned hash differs locally; set `git config core.autocrlf false` and re-checkout');
  if (crlfFiles.length) problems.push(`${crlfFiles.length} tracked file(s) have CRLF in the working tree; hashes computed from them are wrong`);
  if (!hasMain) problems.push('origin/main is not fetched: comparisons against main are skipped (`git fetch origin main`)');
  return { branch, head, autocrlf, shallow, crlf_files: crlfFiles, dirty_files: dirty, origin_main: hasMain, behind_main: behind, ahead_of_main: ahead, problems };
}

function listPins(root) {
  const dir = path.join(root, PIN_DIR);
  return fs.readdirSync(dir).filter((f) => f.endsWith(PIN_SUFFIX)).sort().map((f) => `${PIN_DIR}/${f}`);
}

function releaseKeyForPin(rel, pin) {
  const bySpec = RELEASE_SQL_KEYS.find((key) => RELEASE_SQL_SPECS[key].production_pin_rel === rel);
  if (bySpec) return bySpec;
  const key = pin.migration;
  return typeof key === 'string' && RELEASE_SQL_KEYS.includes(key) ? key : null;
}

/** One production pin: every hash it records and what the bytes say now. */
export function pinReport(root, rel, refs, { shallow = false } = {}) {
  const pin = loadJson(path.join(root, rel));
  const file = pin.filename;
  const report = {
    pin: rel,
    migration: pin.migration ?? null,
    filename: file ?? null,
    execute: pin.execute ?? null,
    authorization: pin.authorization ?? null,
    applied: Boolean(pin.applied),
    staging_acceptance_ok: pin.staging_acceptance?.ok ?? null,
    recorded: {
      source_sha256: pin.source_sha256 ?? null,
      expected_live_definition_sha256: pin.expected_live_definition_sha256 ?? null,
      intended_replacement_sha256: pin.intended_replacement_sha256 ?? null,
    },
    actual: {},
    findings: [],
  };
  if (!file) {
    report.findings.push({ level: 'info', text: 'pin names no migration file; nothing to hash' });
    return report;
  }
  const work = fileHashes(root, file);
  report.actual.working_tree = work.exists ? work.sha256 : null;
  report.actual.crlf = work.exists ? work.crlf : null;
  if (work.crlf) report.actual.working_tree_lf = work.sha256_lf;
  Object.assign(report.actual, refHashes(root, file, refs));

  if (!work.exists) {
    report.findings.push({ level: 'error', text: `${file} is missing from the working tree` });
    return report;
  }
  if (work.crlf) {
    const lfMatches = work.sha256_lf === pin.source_sha256;
    report.findings.push({
      level: 'error',
      text: `${file} has CRLF line endings in the working tree${lfMatches ? '; its LF bytes do match the pin, so this is the checkout, not the file' : ''}. Fix the checkout (.gitattributes, core.autocrlf false), never the hash.`,
    });
  }
  if (pin.source_sha256 && work.sha256 !== pin.source_sha256) {
    const mainSha = report.actual['origin/main'];
    const where = mainSha === pin.source_sha256
      ? 'origin/main still carries the pinned bytes, so the change is local to this branch or working tree'
      : mainSha === null
        ? 'origin/main is unavailable for comparison'
        : 'origin/main differs from the pin as well';
    report.findings.push({
      level: pin.applied ? 'error' : 'warn',
      text: `source_sha256 differs from the file bytes (${where}). ${pin.applied
        ? 'The pin records an applied migration: its bytes are history. A fix is a new numbered migration.'
        : 'If the change is intended, the pin and every test that pins this file change in the same reviewed PR, with the new hash derived from the bytes.'}`,
    });
  }
  const key = releaseKeyForPin(rel, pin);
  if (key) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const intended = releaseIntendedHash(key, text);
    report.release_key = key;
    report.actual.intended_replacement_sha256 = intended;
    if (pin.intended_replacement_sha256 && intended !== pin.intended_replacement_sha256) {
      report.findings.push({
        level: pin.applied ? 'error' : 'warn',
        text: `intended_replacement_sha256 differs from releaseIntendedHash('${key}', file bytes): the file now leaves a different state (function body, ACL, policy or rendering). The staging pin, the production pin and ${(pin.tooling?.tests || []).join(', ') || 'the executor tests'} all derive it; re-derive from the bytes, never copy from a failing test.`,
      });
    }
    const staging = RELEASE_SQL_PINS[key];
    if (staging) {
      report.staging_pin = {
        commit: staging.commit ?? null,
        source_sha256: staging.source_sha256 ?? null,
        intended_replacement_sha256: staging.intended_replacement_sha256 ?? null,
        expected_live_definition_sha256: staging.expected_live_definition_sha256 ?? null,
        execute: staging.execute ?? null,
      };
      if (staging.source_sha256 !== pin.source_sha256) {
        report.findings.push({ level: 'error', text: `the staging pin (sql-executor-auth.mjs) and the production pin disagree on source_sha256 (${short(staging.source_sha256)} vs ${short(pin.source_sha256)})` });
      }
      if (staging.intended_replacement_sha256 !== pin.intended_replacement_sha256) {
        report.findings.push({ level: 'error', text: `the staging pin and the production pin disagree on intended_replacement_sha256 (${short(staging.intended_replacement_sha256)} vs ${short(pin.intended_replacement_sha256)})` });
      }
      if (staging.commit && /^[0-9a-f]{40}$/.test(staging.commit)) {
        const bytes = gitBytes(root, staging.commit, file);
        report.staging_pin.commit_bytes_sha256 = bytes ? sha(bytes) : null;
        if (bytes && sha(bytes) !== staging.source_sha256) {
          report.findings.push({ level: 'error', text: `the staging pin's commit ${staging.commit.slice(0, 12)} does not carry the pinned bytes (${short(sha(bytes))} vs ${short(staging.source_sha256)}): the commit field must name the commit that last authored the file` });
        }
        if (!bytes && !shallow) report.findings.push({ level: 'info', text: `staging pin commit ${staging.commit.slice(0, 12)} is not in this clone; its bytes were not compared` });
      }
      if (pin.staging_pin_commit && staging.commit && pin.staging_pin_commit !== staging.commit) {
        report.findings.push({ level: 'error', text: `production pin staging_pin_commit ${pin.staging_pin_commit.slice(0, 12)} differs from the staging pin's commit ${staging.commit.slice(0, 12)}` });
      }
    }
  }
  if (pin.expected_live_definition_sha256 && pin.intended_replacement_sha256 && pin.expected_live_definition_sha256 === pin.intended_replacement_sha256 && !pin.applied) {
    report.findings.push({ level: 'warn', text: 'expected_live_definition_sha256 equals intended_replacement_sha256: the live state already is the intended one (already_applied); an apply would refuse' });
  }
  return report;
}

/** Release-lock tree hashes and required SQL rows against the working tree. */
export function releaseLockReport(root, refs) {
  const protectedPaths = loadJson(path.join(root, DEFAULT_PATHS.protectedPaths));
  const manifest = loadJson(path.join(root, DEFAULT_PATHS.manifest));
  const hashes = computeOwnershipHashes(root, protectedPaths);
  const hasMain = refs.includes('origin/main');
  const changedVsMain = new Set(hasMain ? (git(root, ['diff', '--name-only', 'origin/main...HEAD']) || '').split('\n').filter(Boolean) : []);
  const changedVsHead = new Set((git(root, ['diff', '--name-only', 'HEAD']) || '').split('\n').filter(Boolean));
  const components = [];
  for (const [id, component] of Object.entries(manifest.components || {})) {
    const group = hashes.groups[component.ownership_group];
    const entry = {
      component: id,
      ownership_group: component.ownership_group,
      classification: component.classification,
      recorded_tree_hash: component.source?.tree_hash ?? null,
      actual_tree_hash: group?.tree_hash ?? null,
      missing: group?.missing ?? [],
      files_changed_vs_main: [],
      files_changed_uncommitted: [],
      required_sql: [],
      findings: [],
    };
    if (group) {
      entry.files_changed_vs_main = group.files.filter((f) => changedVsMain.has(f));
      entry.files_changed_uncommitted = group.files.filter((f) => changedVsHead.has(f));
      if (group.tree_hash && group.tree_hash !== entry.recorded_tree_hash) {
        const why = entry.files_changed_uncommitted.length
          ? `uncommitted changes in ${entry.files_changed_uncommitted.join(', ')}`
          : entry.files_changed_vs_main.length
            ? `this branch changes ${entry.files_changed_vs_main.join(', ')}`
            : hasMain ? 'no file of the group differs from origin/main, so the recorded hash was stale before this branch (check origin/main with the validator)' : 'origin/main is not available to locate the change';
        entry.findings.push({
          level: 'warn',
          text: `tree_hash differs: ${why}. If the change is intended, this PR updates components.${id}.source.tree_hash (OPERATOR.md "Intentionally updating a protected component"), and the overlap check must pass against other open PRs.`,
        });
      }
    } else {
      entry.findings.push({ level: 'error', text: `ownership group ${component.ownership_group} is missing from protected-paths.json` });
    }
    for (const row of component.required_sql || []) {
      const work = fileHashes(root, row.path);
      const sqlRow = { path: row.path, recorded: row.source_sha256, actual: work.exists ? work.sha256 : null, applied: row.applied ?? null };
      if (!work.exists) entry.findings.push({ level: 'error', text: `required SQL ${row.path} is missing` });
      else if (work.sha256 !== row.source_sha256) entry.findings.push({ level: row.applied ? 'error' : 'warn', text: `required SQL ${row.path} bytes differ from the recorded source_sha256${row.applied ? ' and the row is applied: the file is history, write a new migration' : ''}` });
      entry.required_sql.push(sqlRow);
    }
    components.push(entry);
  }
  return { components, errors: hashes.errors };
}

/** Any file: its hashes in the working tree and at each ref, and every record that names it. */
export function fileReport(root, rel, refs) {
  const normalized = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const work = fileHashes(root, normalized);
  const report = { file: normalized, working_tree: work, refs: refHashes(root, normalized, refs), referenced_by: [], findings: [] };
  if (!work.exists) report.findings.push({ level: 'error', text: 'file is missing from the working tree' });
  if (work.crlf) report.findings.push({ level: 'error', text: 'CRLF line endings in the working tree: the hash above is not the one CI computes; sha256_lf is' });
  for (const ref of refs) {
    const at = report.refs[ref];
    if (work.exists && at && at !== work.sha256) report.findings.push({ level: 'info', text: `differs from ${ref}` });
  }
  for (const record of recordIndex(root)) {
    if (record.path === normalized) report.referenced_by.push(record);
  }
  return report;
}

/** Every (path, sha256, where) triple recorded in the pins, the ledger and the manifest. */
function recordIndex(root) {
  const out = [];
  const walk = (value, where, pathHint) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${where}[${i}]`, pathHint));
    } else if (value && typeof value === 'object') {
      const hint = typeof value.filename === 'string' ? value.filename : typeof value.path === 'string' ? value.path : pathHint;
      for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`, hint);
    } else if (typeof value === 'string' && SHA_RE.test(value)) {
      out.push({ where, sha256: value, path: pathHint ?? null });
    }
  };
  for (const rel of listPins(root)) walk(loadJson(path.join(root, rel)), rel, null);
  for (const rel of [DEFAULT_PATHS.ledger, DEFAULT_PATHS.manifest]) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) walk(loadJson(abs), rel, null);
  }
  for (const key of RELEASE_SQL_KEYS) walk(RELEASE_SQL_PINS[key], `scripts/deployment-guard/lib/sql-executor-auth.mjs:RELEASE_SQL_PINS.${key}`, RELEASE_SQL_PINS[key]?.filename ?? null);
  return out;
}

/** What a sha256 is: where it is recorded and which bytes or derived state produce it. */
export function hashReport(root, hex, refs) {
  const wanted = String(hex).trim().toLowerCase();
  const report = { sha256: wanted, recorded_at: [], produced_by: [], findings: [] };
  if (!SHA_RE.test(wanted)) {
    report.findings.push({ level: 'error', text: 'not a sha256 hex string' });
    return report;
  }
  for (const record of recordIndex(root)) if (record.sha256 === wanted) report.recorded_at.push(record.where);
  const candidates = new Set();
  for (const record of recordIndex(root)) if (record.path) candidates.add(record.path);
  const protectedPaths = loadJson(path.join(root, DEFAULT_PATHS.protectedPaths));
  const hashes = computeOwnershipHashes(root, protectedPaths);
  for (const [group, info] of Object.entries(hashes.groups)) {
    if (info.tree_hash === wanted) report.produced_by.push(`tree_hash of ownership group ${group} (working tree)`);
    for (const f of info.files) candidates.add(f);
  }
  for (const key of RELEASE_SQL_KEYS) {
    const file = RELEASE_SQL_PINS[key]?.filename;
    if (!file || !fs.existsSync(path.join(root, file))) continue;
    if (releaseIntendedHash(key, fs.readFileSync(path.join(root, file), 'utf8')) === wanted) report.produced_by.push(`releaseIntendedHash('${key}', ${file} working tree)`);
    for (const ref of refs) {
      const bytes = gitBytes(root, ref, file);
      if (bytes && releaseIntendedHash(key, bytes.toString('utf8')) === wanted) report.produced_by.push(`releaseIntendedHash('${key}', ${file} at ${ref})`);
    }
  }
  for (const file of [...candidates].sort()) {
    const work = fileHashes(root, file);
    if (work.exists && work.sha256 === wanted) report.produced_by.push(`sha256 of ${file} (working tree)`);
    if (work.exists && work.crlf && work.sha256_lf === wanted) report.produced_by.push(`sha256 of ${file} with LF line endings (the working tree has CRLF)`);
    for (const ref of refs) {
      const bytes = gitBytes(root, ref, file);
      if (bytes && sha(bytes) === wanted) report.produced_by.push(`sha256 of ${file} at ${ref}`);
    }
  }
  if (!report.recorded_at.length && !report.produced_by.length) {
    report.findings.push({ level: 'info', text: 'not recorded in any pin, ledger or manifest, and not the hash of any pinned file, tree or intended state at HEAD or origin/main. A live hash (expected_live_definition_sha256, receipts) comes from an inspect, not from code.' });
  }
  return report;
}

function selectPins(root, selector) {
  const pins = listPins(root);
  if (!selector) return pins;
  const s = selector.toLowerCase();
  return pins.filter((rel) => {
    if (rel.toLowerCase().includes(s)) return true;
    const pin = loadJson(path.join(root, rel));
    return [pin.migration, pin.filename, pin.migration_id, pin.id].some((v) => typeof v === 'string' && v.toLowerCase().includes(s));
  });
}

function levelMark(level) {
  return level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN ' : 'info ';
}

function printText(result) {
  const lines = [];
  if (result.checkout) {
    const c = result.checkout;
    lines.push(`checkout: ${c.branch} @ ${c.head.slice(0, 12)}  core.autocrlf=${c.autocrlf}  crlf files=${c.crlf_files.length}  dirty=${c.dirty_files.length}${c.origin_main ? `  behind main=${c.behind_main} ahead=${c.ahead_of_main}` : '  (origin/main not fetched)'}${c.shallow ? '  shallow clone (pinned commits may be absent)' : ''}`);
    for (const p of c.problems) lines.push(`  ${levelMark('error')} ${p}`);
  }
  if (result.file) {
    const f = result.file;
    lines.push(`file: ${f.file}`);
    lines.push(`  working tree: ${f.working_tree.exists ? f.working_tree.sha256 : '(missing)'}${f.working_tree.crlf ? `  CRLF! lf=${f.working_tree.sha256_lf}` : ''}`);
    for (const [ref, h] of Object.entries(f.refs)) lines.push(`  ${ref}: ${h ?? '(absent)'}`);
    for (const r of f.referenced_by) lines.push(`  recorded ${short(r.sha256)} at ${r.where}${r.sha256 === f.working_tree.sha256 ? '  (= file bytes)' : /source_sha256$|applied_sha256$/.test(r.where) ? '  (differs from file bytes)' : ''}`);
    for (const x of f.findings) lines.push(`  ${levelMark(x.level)} ${x.text}`);
  }
  if (result.hash) {
    const h = result.hash;
    lines.push(`hash: ${h.sha256}`);
    for (const w of h.recorded_at) lines.push(`  recorded at ${w}`);
    for (const p of h.produced_by) lines.push(`  produced by ${p}`);
    for (const x of h.findings) lines.push(`  ${levelMark(x.level)} ${x.text}`);
  }
  for (const p of result.pins || []) {
    const auth = typeof p.authorization === 'string' && p.authorization.length > 48 ? `${p.authorization.slice(0, 45)}…` : p.authorization;
    const state = `${p.applied ? 'applied' : 'not applied'}, execute ${p.execute}, authorization ${JSON.stringify(auth)}`;
    lines.push(`pin: ${path.basename(p.pin)}  (${state})`);
    lines.push(`  file ${p.filename}: working tree ${short(p.actual.working_tree)}${p.actual.crlf ? ' CRLF!' : ''}  HEAD ${short(p.actual.HEAD)}  origin/main ${short(p.actual['origin/main'])}  pinned ${short(p.recorded.source_sha256)}`);
    if (p.release_key) lines.push(`  intended (${p.release_key}): derived ${short(p.actual.intended_replacement_sha256)}  pinned ${short(p.recorded.intended_replacement_sha256)}  staging pin ${short(p.staging_pin?.intended_replacement_sha256)}`);
    lines.push(`  expected live: ${short(p.recorded.expected_live_definition_sha256)}`);
    for (const x of p.findings) lines.push(`  ${levelMark(x.level)} ${x.text}`);
  }
  if (result.release_locks) {
    lines.push('release locks:');
    for (const e of result.release_locks.errors || []) lines.push(`  ERROR group ${e.group}: missing ${e.missing.join(', ')}`);
    for (const c of result.release_locks.components) {
      const ok = c.recorded_tree_hash === c.actual_tree_hash;
      lines.push(`  ${ok ? 'ok   ' : 'DIFF '} ${c.component} (${c.classification}) tree ${short(c.recorded_tree_hash)}${ok ? '' : ` → ${short(c.actual_tree_hash)}`}`);
      for (const x of c.findings) lines.push(`        ${levelMark(x.level)} ${x.text}`);
    }
  }
  lines.push(`summary: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s). ${result.summary.errors || result.summary.warnings ? 'Each one is a question to answer before any hash is written.' : 'Working tree, pins and locks agree.'}`);
  return `${lines.join('\n')}\n`;
}

function countFindings(result) {
  let errors = 0;
  let warnings = 0;
  const tally = (findings = []) => {
    for (const f of findings) {
      if (f.level === 'error') errors += 1;
      else if (f.level === 'warn') warnings += 1;
    }
  };
  errors += result.checkout?.problems?.length ?? 0;
  tally(result.file?.findings);
  tally(result.hash?.findings);
  for (const p of result.pins || []) tally(p.findings);
  for (const c of result.release_locks?.components || []) tally(c.findings);
  errors += result.release_locks?.errors?.length ?? 0;
  return { errors, warnings };
}

export function buildReport(root, argv) {
  const json = argv.includes('--json');
  const fileIdx = argv.indexOf('--file');
  const hashIdx = argv.indexOf('--hash');
  const refs = ['HEAD', ...(refExists(root, 'origin/main') ? ['origin/main'] : [])];
  const result = { root, checkout: checkoutReport(root) };
  if (fileIdx >= 0) {
    if (!argv[fileIdx + 1]) throw new Error('--file needs a path');
    result.file = fileReport(root, argv[fileIdx + 1], refs);
  } else if (hashIdx >= 0) {
    if (!argv[hashIdx + 1]) throw new Error('--hash needs a sha256');
    result.hash = hashReport(root, argv[hashIdx + 1], refs);
  } else {
    const selector = argv.find((a) => !a.startsWith('--'));
    const pins = selectPins(root, selector);
    if (selector && !pins.length) throw new Error(`no production pin matches ${JSON.stringify(selector)}`);
    result.pins = pins.map((rel) => pinReport(root, rel, refs, { shallow: result.checkout.shallow }));
    if (!selector) result.release_locks = releaseLockReport(root, refs);
  }
  result.summary = countFindings(result);
  return { result, json };
}

export function main(argv = process.argv.slice(2), rootArg = repoRootFrom(import.meta.url)) {
  let built;
  try {
    const rootIdx = argv.indexOf('--root');
    const root = rootIdx >= 0 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1]) : rootArg;
    built = buildReport(root, rootIdx >= 0 ? argv.filter((a, i) => i !== rootIdx && i !== rootIdx + 1) : argv);
  } catch (error) {
    process.stderr.write(`hash-report: ${error.message}\n`);
    return 2;
  }
  const { result, json } = built;
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : printText(result));
  return result.summary.errors ? 1 : 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
