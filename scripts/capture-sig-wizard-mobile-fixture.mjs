#!/usr/bin/env node
/**
 * Local layout proof for the signature wizard mobile classes.
 * Does not open production, create a request, or send email.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'scripts/sig-wizard-mobile-fixture.html');
const OUT = '/opt/cursor/artifacts';
const PORT = Number(process.env.SIG_WIZARD_FIXTURE_PORT || 4178);

const chromeBin = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/local/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].find((bin) => bin && fs.existsSync(bin));

if (!chromeBin) {
  console.error('chrome_missing');
  process.exit(2);
}

const html = fs.readFileSync(FIXTURE);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

const runChrome = (args) => new Promise((resolve, reject) => {
  const child = spawn(chromeBin, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('exit', (code) => {
    resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
  });
  child.on('error', reject);
});

const cases = [
  { step: 1, width: 320, signers: 1 },
  { step: 1, width: 430, signers: 1 },
  { step: 2, width: 320, signers: 1 },
  { step: 2, width: 430, signers: 1 },
  { step: 3, width: 320, signers: 2 },
  { step: 3, width: 375, signers: 2 },
  { step: 3, width: 390, signers: 2 },
  { step: 3, width: 430, signers: 2 },
  { step: 3, width: 1280, signers: 2, desktop: true },
];

await new Promise((resolve) => server.listen(PORT, resolve));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
try {
  for (const item of cases) {
    const url = `http://127.0.0.1:${PORT}/?step=${item.step}&signers=${item.signers}&width=${item.width}${item.desktop ? '&desktop=1' : ''}`;
    const file = path.join(OUT, `sig_step${item.step}_w${item.width}${item.signers > 1 ? '_two_signers' : ''}${item.desktop ? '_desktop' : ''}.png`);
    const chromeWidth = Math.max(item.width + 40, 360);
    const shot = await runChrome([`--window-size=${chromeWidth},1100`, `--screenshot=${file}`, url]);
    const dumped = await runChrome([`--window-size=${chromeWidth},1100`, '--virtual-time-budget=4000', '--dump-dom', url]);
    const proofMatch = dumped.stdout.match(/<pre id="proof"[^>]*>([^<]*)<\/pre>/);
    let proof = null;
    try { proof = proofMatch ? JSON.parse(proofMatch[1].replace(/&quot;/g, '"')) : null; } catch { proof = { parse_error: true, raw: proofMatch?.[1] }; }
    results.push({
      ...item,
      file,
      screenshot_ok: shot.code === 0 && fs.existsSync(file),
      proof,
      overflowX: proof?.overflowX === true,
      buttonsInside: proof?.buttonsInside === true,
      titleVisible: proof?.titleFullyVisible === true,
      widthHonored: proof?.phoneWidth === item.width,
      dialogInsidePhone: proof?.dialogInsidePhone === true,
    });
  }
} finally {
  server.close();
}

const ok = results.every((row) => (
  row.screenshot_ok
  && row.proof
  && row.overflowX === false
  && row.buttonsInside
  && row.titleVisible
  && row.widthHonored
  && row.dialogInsidePhone
));
const report = { ok, chrome: chromeBin, results };
fs.writeFileSync(path.join(OUT, 'sig-wizard-mobile-fixture-shots.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!ok) process.exit(4);
