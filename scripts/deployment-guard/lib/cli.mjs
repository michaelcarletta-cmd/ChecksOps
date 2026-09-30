import fs from 'node:fs';
import path from 'node:path';

export function parseArgs(argv = []) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        opts[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i += 1;
      } else {
        flags.add(key);
        opts[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }
  return { flags, opts, positional };
}

export function readInput(opts, fallback = {}) {
  if (opts.input) {
    const abs = path.resolve(opts.input);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  if (opts.json) return JSON.parse(opts.json);
  return fallback;
}

export function printResult(result, { pretty = true } = {}) {
  const text = pretty ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`;
  if (result.ok) process.stdout.write(text);
  else process.stderr.write(text);
  return result.ok ? 0 : 1;
}

export function loadOptionalJson(file) {
  if (!file) return null;
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}
