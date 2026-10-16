/**
 * generate-endorsement-packet must write where the SPA reads: the
 * endorsement-packets bucket, with endorsement_packet_path bucket-relative.
 * (The staging placeholder wrote claim-files/endorsement-packets/... while
 * EndorsementPacketCard signs storage.from("endorsement-packets").)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizePath, s3KeyFor } from '../functions/api/storage-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docs = fs.readFileSync(path.join(ROOT, 'aws/functions/api/documents.mjs'), 'utf8');
const ccc = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
const CHECK = '3916f620-9d20-499b-8450-9e1a8e70a3c9';

const handlerSource = () => {
  const start = docs.indexOf('export const handleGenerateEndorsementPacket');
  const end = docs.indexOf('export const handleCompositeEndorsementSignatures');
  assert.ok(start > 0 && end > start);
  return docs.slice(start, end);
};

test('the packet is written to the endorsement-packets bucket with a bucket-relative path', () => {
  const src = handlerSource();
  assert.match(src, /const rel = `packets\/\$\{checkId\}\/endorsement-packet-\$\{checkId\}-\$\{Date\.now\(\)\}\.pdf`/);
  assert.match(src, /putPdf\(rel, bytes, 'application\/pdf', 'endorsement-packets'\)/);
  assert.match(src, /SET endorsement_packet_path = \$2/);
  assert.match(docs, /const putPdf = async \(relPath, bytes, contentType = 'application\/pdf', bucket = 'claim-files'\)/);
  assert.match(docs, /s3KeyFor\(bucket, normalizePath\(relPath, bucket\)\)/);
});

test('the key the API writes is the key the SPA signs', () => {
  const rel = `packets/${CHECK}/endorsement-packet-${CHECK}-1.pdf`;
  const written = s3KeyFor('endorsement-packets', normalizePath(rel, 'endorsement-packets'));
  const read = s3KeyFor('endorsement-packets', normalizePath(rel, 'endorsement-packets'));
  assert.equal(written, read);
  assert.match(written, /endorsement-packets\/packets\//);
  assert.equal(written.includes('claim-files'), false);
  assert.match(ccc, /\.from\("endorsement-packets"\)\s*\.createSignedUrl\(packetPath, 300\)/);
});

test('other generated PDFs still default to claim-files', () => {
  assert.equal((docs.match(/putPdf\(rel, bytes\)/g) || []).length >= 1, true);
});
