#!/usr/bin/env node
/**
 * Read-only caller audit. Prints match counts only, not secret values.
 * Exits 2 when a required list API is denied (current staging result).
 */
import { spawnSync } from 'node:child_process';

const HOST = 'kiqojucc02.execute-api.us-east-1.amazonaws.com';
const NEEDLE = 'kiqojucc02';

const cmds = [
  ['eb-rules', ['events', 'list-rules']],
  ['eb-dest', ['events', 'list-api-destinations']],
  ['eb-conn', ['events', 'list-connections']],
  ['scheduler', ['scheduler', 'list-schedules']],
  ['canaries', ['synthetics', 'describe-canaries']],
  ['alarms', ['cloudwatch', 'describe-alarms']],
];

const results = [];
let denied = false;
let hits = 0;
for (const [name, args] of cmds) {
  const out = spawnSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', env: process.env });
  const text = `${out.stdout || ''}\n${out.stderr || ''}`;
  const accessDenied = /AccessDenied|not authorized/i.test(text);
  const match = !accessDenied && (text.includes(HOST) || text.includes(NEEDLE));
  if (accessDenied) denied = true;
  if (match) hits += 1;
  results.push({
    name,
    denied: accessDenied,
    hostnameMatch: match,
  });
}

const verdict = denied ? 'FAIL' : hits ? 'FAIL' : 'PASS';
console.log(JSON.stringify({ verdict, denied, hostnameMatchCount: hits, results }, null, 2));
process.exit(denied || hits ? (denied ? 2 : 1) : 0);
