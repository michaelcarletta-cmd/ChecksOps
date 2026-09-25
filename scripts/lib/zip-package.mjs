/**
 * ZIP content hashing and overlay helpers.
 * Uses Python zipfile so overlay preserves every untouched entry byte-for-byte
 * except the explicitly replaced names.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'zip-package.py');

const runPy = (args, input) => execFileSync('python3', [PY, ...args], {
  input,
  encoding: input == null ? 'utf8' : undefined,
  maxBuffer: 64 * 1024 * 1024,
});

export const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');

export const sha256File = (filePath) => sha256Bytes(fs.readFileSync(filePath));

export const awsCodeSha256 = (zipPath) => Buffer.from(createHash('sha256').update(fs.readFileSync(zipPath)).digest()).toString('base64');

export const zipContentHashes = (zipPath) => JSON.parse(runPy(['hashes', zipPath]));

export const zipReadFile = (zipPath, name) => runPy(['read', zipPath, name], undefined);

export const overlayZip = ({ baseZip, destZip, replacements }) => {
  const specPath = `${destZip}.overlay-spec.json`;
  fs.writeFileSync(specPath, JSON.stringify(replacements));
  runPy(['overlay', baseZip, destZip, specPath]);
  fs.unlinkSync(specPath);
  return destZip;
};

export const diffZipContents = (leftZip, rightZip) => {
  const left = zipContentHashes(leftZip);
  const right = zipContentHashes(rightZip);
  const onlyLeft = Object.keys(left).filter((k) => !(k in right)).sort();
  const onlyRight = Object.keys(right).filter((k) => !(k in left)).sort();
  const changed = Object.keys(left).filter((k) => k in right && left[k] !== right[k]).sort();
  return { onlyLeft, onlyRight, changed, left, right };
};
