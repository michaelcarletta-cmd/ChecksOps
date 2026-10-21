// scripts/hash-report.mjs: the read-only hash report agrees with the pins and locks on a
// clean checkout, names the kind of every mismatch it finds, and never writes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, main } from '../../scripts/hash-report.mjs';
import { RELEASE_SQL_PINS, releaseIntendedHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL109 = RELEASE_SQL_PINS.sql109.filename;
const PIN109 = 'ops/deployment-guard/sql109-moov-transfer-webhook-status-production-apply.json';
const SQL91 = RELEASE_SQL_PINS.sql91.filename;
const PROTECTED = 'aws/functions/api/providers/production/moov-wallet-sync.mjs';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function quietMain(argv) {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try {
    return { code: main(argv, ROOT), out };
  } finally {
    process.stdout.write = write;
  }
}

/** A disposable working copy of this checkout, with origin/main pointing at its HEAD. */
function scratchClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-hash-report-'));
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-local', ROOT, dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { stdio: 'ignore' });
  return dir;
}

const findings = (report) => [
  ...(report.pins || []).flatMap((p) => p.findings),
  ...(report.release_locks?.components || []).flatMap((c) => c.findings),
  ...(report.file?.findings || []),
  ...(report.hash?.findings || []),
];

test('a clean checkout: every pin and lock agrees, exit 0, nothing written', () => {
  const before = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'ops', 'scripts', 'aws/workflows'], { encoding: 'utf8' });
  const { result } = buildReport(ROOT, ['--json']);
  assert.equal(result.summary.errors, 0, JSON.stringify(findings(result), null, 2));
  assert.equal(result.summary.warnings, 0, JSON.stringify(findings(result), null, 2));
  assert.ok(result.pins.length >= 30);
  assert.ok(result.release_locks.components.length >= 10);
  const sql109 = result.pins.find((p) => p.pin === PIN109);
  assert.equal(sql109.release_key, 'sql109');
  assert.equal(sql109.actual.working_tree, sql109.recorded.source_sha256);
  assert.equal(sql109.actual.intended_replacement_sha256, sql109.recorded.intended_replacement_sha256);
  assert.equal(sql109.staging_pin.source_sha256, sql109.recorded.source_sha256);
  const { code, out } = quietMain([]);
  assert.equal(code, 0, out);
  assert.match(out, /summary: 0 error\(s\), 0 warning\(s\)/);
  const after = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'ops', 'scripts', 'aws/workflows'], { encoding: 'utf8' });
  assert.equal(after, before, 'the report must not write');
});

test('--file and --hash explain where a value is recorded and what produces it', () => {
  const text = fs.readFileSync(path.join(ROOT, SQL109));
  const { result: file } = buildReport(ROOT, ['--file', SQL109]);
  assert.equal(file.file.working_tree.sha256, sha(text));
  assert.equal(file.file.working_tree.crlf, false);
  assert.ok(file.file.referenced_by.some((r) => r.where === `${PIN109}.source_sha256` && r.sha256 === sha(text)));
  assert.ok(file.file.referenced_by.some((r) => r.where.endsWith('RELEASE_SQL_PINS.sql109.source_sha256')));

  const intended = releaseIntendedHash('sql109', text.toString('utf8'));
  const { result: hash } = buildReport(ROOT, ['--hash', intended]);
  assert.ok(hash.hash.recorded_at.includes(`${PIN109}.intended_replacement_sha256`));
  assert.ok(hash.hash.produced_by.some((p) => p.startsWith(`releaseIntendedHash('sql109', ${SQL109}`)));

  const { result: bytes } = buildReport(ROOT, ['--hash', sha(text)]);
  assert.ok(bytes.hash.produced_by.includes(`sha256 of ${SQL109} (working tree)`));

  const { result: unknown } = buildReport(ROOT, ['--hash', 'f'.repeat(64)]);
  assert.deepEqual(unknown.hash.recorded_at, []);
  assert.deepEqual(unknown.hash.produced_by, []);
  assert.match(unknown.hash.findings[0].text, /comes from an inspect, not from code/);

  assert.equal(quietMain(['--hash', 'nope']).code, 1);
  assert.equal(quietMain(['no-such-migration']).code, 2);
  assert.equal(quietMain(['--file']).code, 2);
});

test('a changed migration, a CRLF checkout and a touched protected file are each named by kind', () => {
  const dir = scratchClone();
  try {
    // 1. An applied migration's bytes changed: history, so an error that points at a new migration.
    fs.appendFileSync(path.join(dir, SQL91), '-- probe\n');
    let { result } = buildReport(dir, ['sql91', '--json']);
    let pin = result.pins.find((p) => p.release_key === 'sql91');
    assert.equal(pin.applied, true);
    const changed = pin.findings.find((f) => /source_sha256 differs/.test(f.text));
    assert.equal(changed.level, 'error');
    assert.match(changed.text, /origin\/main still carries the pinned bytes/);
    assert.match(changed.text, /new numbered migration/);
    assert.equal(result.summary.errors, 1);
    execFileSync('git', ['-C', dir, 'checkout', '--', SQL91], { stdio: 'ignore' });

    // 2. The same bytes with CRLF line endings: the checkout is wrong, the LF hash still matches.
    const lf = fs.readFileSync(path.join(dir, SQL109), 'utf8');
    fs.writeFileSync(path.join(dir, SQL109), lf.replace(/\n/g, '\r\n'));
    ({ result } = buildReport(dir, ['sql109', '--json']));
    pin = result.pins.find((p) => p.release_key === 'sql109');
    assert.equal(pin.actual.crlf, true);
    assert.equal(pin.actual.working_tree_lf, pin.recorded.source_sha256);
    const crlf = pin.findings.find((f) => /CRLF/.test(f.text));
    assert.equal(crlf.level, 'error');
    assert.match(crlf.text, /LF bytes do match the pin/);
    assert.ok(result.checkout.crlf_files.includes(SQL109));
    assert.ok(result.checkout.problems.some((p) => /CRLF/.test(p)));
    execFileSync('git', ['-C', dir, 'checkout', '--', SQL109], { stdio: 'ignore' });

    // 3. A protected file changed: the group's tree hash moves and the file is named.
    fs.appendFileSync(path.join(dir, PROTECTED), '// probe\n');
    ({ result } = buildReport(dir, ['--json']));
    const component = result.release_locks.components.find((c) => c.component === 'moov-production-read');
    assert.notEqual(component.actual_tree_hash, component.recorded_tree_hash);
    assert.deepEqual(component.files_changed_uncommitted, [PROTECTED]);
    assert.match(component.findings[0].text, /uncommitted changes in aws\/functions\/api\/providers\/production\/moov-wallet-sync\.mjs/);
    assert.match(component.findings[0].text, /source\.tree_hash/);
    assert.equal(result.summary.warnings, 1);
    assert.equal(result.summary.errors, 0);
    // Nothing else moved.
    assert.ok(result.release_locks.components.filter((c) => c.component !== 'moov-production-read').every((c) => c.findings.length === 0));
    assert.ok(result.pins.every((p) => p.findings.length === 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
