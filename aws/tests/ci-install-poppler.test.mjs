/**
 * scripts/ci/install-poppler.sh (AWS Migration CI's PDF rasterizer step; owner 2026-11-11: "make the CI apt fix").
 * Runs the real script with stand-in sudo and apt-get on PATH (no package is installed, nothing outside a temp dir is
 * written): the default mirrors first, three times; then each fallback mirror written as the runner's mirror list; a
 * non-zero exit when nothing works, so the tests never run without the rasterizer; and nothing to do when pdftoppm is
 * already there. The workflow calls the script and no longer installs inline.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/install-poppler.sh');

/**
 * A sandbox with fake sudo / apt-get / pdftoppm. `installOkAfter` names the mirror list content (or 'default') from
 * which `apt-get install` succeeds; `null` makes every attempt fail.
 */
function sandbox({ installOkWith = null, pdftoppm = false, resolvable = ['azure.archive.ubuntu.com', 'archive.ubuntu.com', 'mirrors.edge.kernel.org', 'mirror.math.princeton.edu'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-poppler-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const mirrors = path.join(dir, 'apt-mirrors.txt');
  fs.writeFileSync(mirrors, 'http://azure.archive.ubuntu.com/ubuntu/\n');
  const log = path.join(dir, 'calls.log');
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  write('sudo', '"$@"');
  write('apt-get', `
echo "apt-get $*" >> "${log}"
current=$(tr -d '\\n' < "${mirrors}")
case " $* " in
  *" install "*)
    want='${installOkWith ?? '__never__'}'
    if [ "$want" = default ] && [ "$current" = "http://azure.archive.ubuntu.com/ubuntu/" ]; then exit 0; fi
    if [ "$current" = "$want" ]; then exit 0; fi
    exit 100 ;;
  *) exit 0 ;;
esac`);
  if (pdftoppm) write('pdftoppm', 'exit 0');
  // getent resolves only the hosts this case lists (the outage: azure.archive.ubuntu.com does not).
  write('getent', `echo "getent $*" >> "${log}"\ncase " ${resolvable.join(' ')} " in *" $2 "*) echo "127.0.0.1 $2"; exit 0 ;; esac\nexit 2`);
  // Only the tools the script and the stand-ins use: the container may itself have pdftoppm in /usr/bin.
  for (const tool of ['bash', 'tr', 'tee', 'sleep', 'cat', 'grep']) {
    const found = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((f) => fs.existsSync(f));
    assert.ok(found, tool);
    fs.symlinkSync(found, path.join(bin, tool));
  }
  const run = () => spawnSync(path.join(bin, 'bash'), [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: bin, APT_MIRROR_LIST: mirrors, INSTALL_RETRY_SLEEP_SECONDS: '0' },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const mirrorNow = () => fs.readFileSync(mirrors, 'utf8').trim();
  return { run, calls, mirrorNow, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const installs = (calls) => calls.filter((c) => c.startsWith('apt-get') && / install /.test(` ${c} `));

test('the default mirrors work: one install, the mirror list untouched', () => {
  const box = sandbox({ installOkWith: 'default' });
  try {
    const r = box.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /installed from the default mirrors \(attempt 1\)/);
    assert.equal(installs(box.calls()).length, 1);
    assert.equal(box.mirrorNow(), 'http://azure.archive.ubuntu.com/ubuntu/');
  } finally { box.cleanup(); }
});

test('the default mirror resolves but fails: two tries, then the first fallback mirror that works', () => {
  const box = sandbox({ installOkWith: 'http://mirrors.edge.kernel.org/ubuntu/' });
  try {
    const r = box.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /installed from fallback mirror http:\/\/mirrors\.edge\.kernel\.org\/ubuntu\//);
    // 2 default attempts (its host resolves here), archive.ubuntu.com, then kernel.org.
    assert.equal(installs(box.calls()).length, 4);
    assert.ok(box.calls().filter((c) => c.startsWith('apt-get')).every((c) => c.includes('-o Acquire::Retries=2')));
    assert.equal(box.mirrorNow(), 'http://mirrors.edge.kernel.org/ubuntu/');
  } finally { box.cleanup(); }
});

test('nothing works: the step fails (never skips the rasterizer)', () => {
  const box = sandbox({ installOkWith: null });
  try {
    const r = box.run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::poppler-utils could not be installed from any mirror/);
    assert.equal(installs(box.calls()).length, 5);
  } finally { box.cleanup(); }
});

test('already installed: nothing to do', () => {
  const box = sandbox({ installOkWith: null, pdftoppm: true });
  try {
    const r = box.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already installed/);
    assert.deepEqual(box.calls(), []);
  } finally { box.cleanup(); }
});

test('the workflow calls the script and no longer installs inline', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/aws-migration-ci.yml'), 'utf8');
  assert.match(ci, /- name: Install PDF rasterizer for signature placement tests\n(?:\s+#.*\n)*\s+run: bash scripts\/ci\/install-poppler\.sh\n/);
  assert.doesNotMatch(ci, /apt-get install -y --no-install-recommends poppler-utils/);
});

test('the outage: the default host does not resolve, so no apt time is spent on it; an unresolvable fallback is skipped too', () => {
  const box = sandbox({ installOkWith: 'http://mirror.math.princeton.edu/pub/ubuntu/', resolvable: ['mirror.math.princeton.edu'] });
  try {
    const r = box.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /default mirror host azure\.archive\.ubuntu\.com does not resolve; skipping to the fallback mirrors/);
    assert.match(r.stdout, /fallback mirror host archive\.ubuntu\.com does not resolve/);
    assert.match(r.stdout, /installed from fallback mirror http:\/\/mirror\.math\.princeton\.edu\/pub\/ubuntu\//);
    // One apt install, against the one mirror that resolves.
    assert.equal(installs(box.calls()).length, 1);
    assert.equal(box.mirrorNow(), 'http://mirror.math.princeton.edu/pub/ubuntu/');
  } finally { box.cleanup(); }
});

test('nothing resolves: no apt call at all, and the step fails', () => {
  const box = sandbox({ installOkWith: 'default', resolvable: [] });
  try {
    const r = box.run();
    assert.equal(r.status, 1);
    assert.equal(installs(box.calls()).length, 0);
    assert.match(r.stdout, /::error::poppler-utils could not be installed from any mirror/);
  } finally { box.cleanup(); }
});
