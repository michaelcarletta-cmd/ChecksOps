// The Claude Code PreToolUse hook (.claude/hooks/checksops-guard.mjs) refuses edits to
// migrations that exist on main, rewrites of an applied pin's evidence and direct deploys,
// and allows new migrations, ordinary pin edits and read-only commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, '.claude/hooks/checksops-guard.mjs');
const SQL91 = 'aws/workflows/sql/91_moov_onboarding.sql';
const PIN91 = 'ops/deployment-guard/sql91-moov-onboarding-production-apply.json';

function run(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CHECKSOPS_OWNER_ALLOW_SQL_EDIT: '', ...env },
  });
  return { code: r.status, err: r.stderr };
}
const edit = (rel, old_string, new_string) => run({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, rel), old_string, new_string } });
const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } });

test('settings wire the hook for Edit, MultiEdit, Write and Bash and deny direct deploys', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const pre = settings.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, 'Edit|MultiEdit|Write|Bash');
  assert.match(pre[0].hooks[0].command, /\.claude\/hooks\/checksops-guard\.mjs/);
  for (const d of ['Bash(sam deploy:*)', 'Bash(sam build:*)', 'Bash(aws lambda update-function-code:*)', 'Bash(aws cloudformation deploy:*)']) {
    assert.ok(settings.permissions.deny.includes(d), d);
  }
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^@AGENTS\.md$/m);
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), /Migrations and pins are append-only/);
});

test('an existing migration cannot be edited, written or overwritten; a new one can', () => {
  const line = fs.readFileSync(path.join(ROOT, SQL91), 'utf8').split('\n').find((l) => l.startsWith('GRANT '));
  const r = edit(SQL91, line, `${line}\nGRANT SELECT ON TABLE public.payment_idempotency_keys TO checksops;`);
  assert.equal(r.code, 2);
  assert.match(r.err, /already exists on main\. Migrations are append-only/);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(ROOT, SQL91), content: '-- x\n' } }).code, 2);
  assert.equal(run({ tool_name: 'MultiEdit', tool_input: { file_path: path.join(ROOT, SQL91), edits: [{ old_string: line, new_string: line }] } }).code, 2);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'aws/workflows/sql/999_new_migration_probe.sql'), content: '-- new\n' } }).code, 0);
});

test('the owner override allows exactly the named migration', () => {
  const payload = { tool_name: 'Write', tool_input: { file_path: path.join(ROOT, SQL91), content: '-- x\n' } };
  assert.equal(run(payload, { CHECKSOPS_OWNER_ALLOW_SQL_EDIT: SQL91 }).code, 0);
  assert.equal(run(payload, { CHECKSOPS_OWNER_ALLOW_SQL_EDIT: 'aws/workflows/sql/92_signature_request_check_files_link_grant.sql' }).code, 2);
});

test('an applied pin keeps its recorded evidence; other fields stay editable', () => {
  const text = fs.readFileSync(path.join(ROOT, PIN91), 'utf8');
  const pin = JSON.parse(text);
  assert.ok(pin.applied, 'fixture: SQL 91 is applied');
  const after = pin.applied.receipt.after_hash;
  const r = edit(PIN91, `"after_hash": "${after}"`, `"after_hash": "${'4'.repeat(64)}"`);
  assert.equal(r.code, 2);
  assert.match(r.err, /changes its recorded evidence \(applied\)/);
  const src = edit(PIN91, `"source_sha256": "${pin.source_sha256}"`, `"source_sha256": "${'3'.repeat(64)}"`);
  assert.equal(src.code, 2);
  assert.match(src.err, /source_sha256/);
  const note = edit(PIN91, `"order_note": ${JSON.stringify(pin.order_note)}`, `"order_note": ${JSON.stringify(`${pin.order_note} (probe)`)}`);
  assert.equal(note.code, 0, note.err);
});

test('direct deploys are refused; the guarded tooling and read-only commands are not', () => {
  for (const cmd of ['sam build', 'sam deploy --guided', 'aws lambda update-function-code --function-name x --zip-file fileb://x.zip', 'aws cloudformation deploy --template-file t.yaml', 'psql -h db.example.com -U checksops_admin -f x.sql', 'psql postgresql://u@h/db']) {
    assert.equal(bash(cmd).code, 2, cmd);
  }
  for (const cmd of [
    'node scripts/deployment-guard/preflight.mjs --input m.json',
    `sha256sum ${SQL91} 2>/dev/null`,
    `cat ${SQL91} | head -5`,
    `git diff main -- ${SQL91}`,
    'aws lambda get-function --function-name x',
    'psql -X -d postgres -c "select 1"',
    'psql -h /tmp/pg-sql96-x -p 55432 -U postgres -c "select 1"',
    'psql postgresql://postgres@localhost:55432/postgres -c "select 1"',
  ]) {
    assert.equal(bash(cmd).code, 0, cmd);
  }
});

test('shell writes to an existing migration are refused', () => {
  for (const cmd of [`sed -i 's/a/b/' ${SQL91}`, `echo x >> ${SQL91}`, `printf x > ./${SQL91}`, `echo x | tee ${SQL91}`, `rm ${SQL91}`, `mv ${SQL91} /tmp/x`, `cp /tmp/x ${SQL91}`, `git checkout HEAD~1 -- ${SQL91}`]) {
    assert.equal(bash(cmd).code, 2, cmd);
  }
  assert.equal(bash(`cp ${SQL91} /tmp/sql91-copy.sql`).code, 0);
});

test('deploy patterns match only at command positions; grep and mentions are allowed', () => {
  // These must still be refused (command at start or after shell operators).
  for (const cmd of [
    'sam deploy --guided',
    'sam build',
    'aws cloudformation deploy --template-file t.yaml',
    'aws lambda update-function-code --function-name x --zip-file fileb://x.zip',
    'echo ready && sam deploy',
    'echo ready || aws cloudformation deploy --template-file t.yaml',
    'true ; sam build',
    'true | aws lambda update-function-code --function-name x --zip-file fileb://x.zip',
  ]) {
    assert.equal(bash(cmd).code, 2, `should refuse: ${cmd}`);
  }
  // These merely mention the deploy words and must be allowed.
  for (const cmd of [
    'grep -r "sam deploy" docs/',
    'grep "aws cloudformation deploy" README.md',
    'rg "sam build" --type md',
    'echo "do not run sam deploy"',
    'cat notes.txt | grep "aws lambda update-function-code"',
    'awk "/sam deploy/" log.txt',
  ]) {
    assert.equal(bash(cmd).code, 0, `should allow: ${cmd}`);
  }
});
