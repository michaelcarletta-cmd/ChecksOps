#!/usr/bin/env node
// Claude Code PreToolUse hook for ChecksOps (wired in .claude/settings.json).
//
// Refuses, for every Claude Code session on any machine:
//   1. editing a migration that already exists on main (aws/workflows/sql/*.sql):
//      applied or pinned bytes are history; a fix is a new numbered migration;
//   2. changing the recorded evidence of a pin that has an `applied` block
//      (source_sha256, expected/intended hashes, applied, production_evidence,
//      staging_acceptance, production_inspect);
//   3. direct deploys that bypass scripts/deployment-guard (sam, aws lambda /
//      cloudformation writes, psql against a remote host).
//
// Exit 2 blocks the call and shows stderr to the agent. Anything unexpected
// (bad input, no git) allows the call: this hook is a guardrail, not the guard.
//
// Owner override for one migration file, set by a person before starting the
// session (the agent cannot change this process's environment):
//   CHECKSOPS_OWNER_ALLOW_SQL_EDIT=aws/workflows/sql/<file>.sql

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SQL_RE = /(^|\/)(aws\/workflows\/sql\/[^/]+\.sql)$/;
const PIN_RE = /(^|\/)(ops\/deployment-guard\/[^/]+-production-apply\.json)$/;
const PROTECTED_PIN_KEYS = ['source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'applied', 'production_evidence', 'staging_acceptance', 'production_inspect'];

const DIRECT_DEPLOY = [
  [/\bsam\s+(deploy|build|sync|package|delete)\b/, 'SAM'],
  [/\baws\s+lambda\s+(update-function-code|update-function-configuration|publish-version|create-function|delete-function|update-alias)\b/, 'aws lambda write'],
  [/\baws\s+cloudformation\s+(deploy|create-stack|update-stack|delete-stack|execute-change-set)\b/, 'aws cloudformation write'],
];

// The text the deploy patterns run over: the command with quoted strings removed,
// so `grep "sam deploy" docs/` or a commit message mentioning a deploy is allowed,
// plus every quoted string the shell would run: the argument of bash/sh -c or eval,
// and $(...) or backticks inside double quotes.
const QUOTED_RE = /\\.|'[^']*'|"(?:\\.|[^"\\])*"/g;
const RUNS_NEXT_QUOTE_RE = /(\b(?:ba|z|da|k)?sh\b[^;&|\n]*\s-[a-zA-Z]*c[a-zA-Z]*|\beval)\s*$/;
function deployTexts(command, depth = 0) {
  // A backslash-escaped character outside quotes is kept: it does not open a quote.
  const texts = [command.replace(QUOTED_RE, (q) => (q[0] === '\\' ? q : q[0] + q[0]))];
  if (depth > 3) return texts;
  for (const m of command.matchAll(QUOTED_RE)) {
    if (m[0][0] === '\\') continue;
    const inner = m[0].slice(1, -1);
    if (RUNS_NEXT_QUOTE_RE.test(command.slice(0, m.index))) texts.push(...deployTexts(inner, depth + 1));
    if (m[0][0] === '"') {
      for (const sub of inner.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) texts.push(...deployTexts(sub[1] ?? sub[2], depth + 1));
    }
  }
  return texts;
}

// psql to anything but a local socket directory or localhost (the disposable test
// databases) would be a direct write path to staging or production.
function remotePsql(command) {
  if (!/\bpsql\b/.test(command)) return false;
  const hosts = [...command.matchAll(/(?:\s-h\s*|--host[=\s]|\bhost=)['"]?([^\s'"]+)/g)].map((m) => m[1]);
  for (const m of command.matchAll(/postgres(?:ql)?:\/\/(?:[^@\s/]*@)?([^/:\s?'"]*)/g)) hosts.push(m[1] || 'localhost');
  return hosts.some((h) => !(h.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(h)));
}

function block(reason) {
  process.stderr.write(`ChecksOps guard: ${reason}\nSee AGENTS.md ("Migrations and pins are append-only", "Never deploy directly").\n`);
  process.exit(2);
}

function gitTop(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// True when the path exists on origin/main (or, without that ref, on HEAD).
function onMain(top, rel) {
  for (const ref of ['origin/main', 'HEAD']) {
    try {
      execFileSync('git', ['-C', top, 'cat-file', '-e', `${ref}:${rel}`], { stdio: 'ignore' });
      return true;
    } catch { /* try the next ref */ }
  }
  return false;
}

function repoRel(file) {
  const abs = path.resolve(file);
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const top = gitTop(dir);
  if (!top) return null;
  return { top, rel: path.relative(top, abs).split(path.sep).join('/'), abs };
}

function editedText(tool, input, current) {
  if (tool === 'Write') return input.content ?? '';
  const edits = tool === 'MultiEdit' ? input.edits || [] : [input];
  let text = current;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || !text.includes(e.old_string)) return null;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string ?? '') : text.replace(e.old_string, e.new_string ?? '');
  }
  return text;
}

function checkFile(tool, input) {
  const file = input.file_path || input.path;
  if (!file) return;
  const where = repoRel(file);
  if (!where) return;
  const { top, rel, abs } = where;

  if (SQL_RE.test(rel) && onMain(top, rel)) {
    if (process.env.CHECKSOPS_OWNER_ALLOW_SQL_EDIT === rel) return;
    block(`${rel} already exists on main. Migrations are append-only: do not edit an existing migration or its pinned bytes. Write the fix as a new numbered migration (e.g. aws/workflows/sql/<next>_<name>.sql) and take it through the guarded staging and production path.`);
  }

  if (PIN_RE.test(rel) && fs.existsSync(abs)) {
    let before;
    try { before = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return; }
    if (!before || typeof before !== 'object' || !before.applied) return;
    const text = editedText(tool, input, fs.readFileSync(abs, 'utf8'));
    if (text === null) return;
    let after;
    try { after = JSON.parse(text); } catch { block(`${rel} would no longer be valid JSON.`); }
    const changed = PROTECTED_PIN_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after?.[k]));
    if (changed.length) {
      block(`${rel} records an applied migration; this edit changes its recorded evidence (${changed.join(', ')}). Applied records are history and must not be rewritten to make tests pass. If a check fails, find out why; a fix to the database is a new migration.`);
    }
  }
}

function checkBash(command) {
  const texts = deployTexts(command);
  for (const [re, what] of DIRECT_DEPLOY) {
    if (texts.some((text) => re.test(text))) block(`direct deploy refused (${what}). Use scripts/deployment-guard and the reviewed workflows (ops/), never deploy directly.`);
  }
  if (remotePsql(command)) block('direct deploy refused (psql against a remote database). Database changes go through the guarded SQL path (ops/production-sql-one-shot.md), never by hand.');
  // Shell writes to an existing migration: a redirect or tee into it, an in-place
  // editor, rm/mv/truncate on it, or cp/git checkout/git restore onto it.
  const files = [...new Set((command.match(/aws\/workflows\/sql\/[^\s'"`;|&<>()]+\.sql/g) || []).map((f) => f.replace(/^.*?(aws\/workflows\/sql\/)/, '$1')))];
  if (!files.length) return;
  const top = gitTop(process.cwd());
  if (!top) return;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segments = command.split(/&&|\|\||;|\n/);
  const written = (rel) => {
    const f = `\\S*${esc(rel)}`;
    if (new RegExp(`(^|[^0-9&])>{1,2}\\s*['"]?${f}`).test(command)) return true;
    if (new RegExp(`\\btee\\b[^|;&]*${f}`).test(command)) return true;
    return segments.some((seg) => new RegExp(f).test(seg) && (
      /\b(sed\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i|perl\s+-[a-zA-Z]*i|rm|mv|truncate)\b/.test(seg)
      || new RegExp(`\\b(cp|install|git\\s+(checkout|restore))\\b.*${f}['"]?\\s*$`).test(seg.trim())));
  };
  for (const rel of files) {
    if (written(rel) && onMain(top, rel) && process.env.CHECKSOPS_OWNER_ALLOW_SQL_EDIT !== rel) {
      block(`this command may modify ${rel}, which already exists on main. Migrations are append-only; write a new numbered migration instead.`);
    }
  }
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const tool = input?.tool_name;
const args = input?.tool_input || {};
if (tool === 'Bash') checkBash(String(args.command || ''));
else if (['Edit', 'MultiEdit', 'Write'].includes(tool)) checkFile(tool, args);
process.exit(0);
