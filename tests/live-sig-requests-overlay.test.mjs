import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PINNED_CURRENT_LIVE,
  REFUSE_OLDER_SPA,
  REFUSE_PROD_DEPLOY,
  RETIRED_OLDER_SPA,
  assertCurrentLiveGraph,
  assertSingleEntryWrites,
  parseHtmlEntry,
  rewriteFilesSignatureImport,
} from "../scripts/lib/live-sig-baseline.mjs";

const liveFiles = readFileSync("tests/fixtures/current-live-CheckFilesSection-0Fmhwbep.js", "utf8");
const liveHtml = readFileSync("tests/fixtures/current-live-index.html", "utf8");

test("current live baseline pins the single-entry repair, not the retired SPA", () => {
  assert.equal(PINNED_CURRENT_LIVE.html_entry, "/assets/index-DJNHggvS.js");
  assert.equal(PINNED_CURRENT_LIVE.djnh_sha256, "40a7ad700091a26d328f90f695004e4c086143d1e6ae8e2aba35d8cc9c006380");
  assert.equal(PINNED_CURRENT_LIVE.files_sha256, "85363ebdac367c620e4058cb2e19501f6b6cd70d987b88d8bfb0dff73876e4c5");
  assert.equal(RETIRED_OLDER_SPA.files, "/assets/CheckFilesSection-DC3uOrqc.js");
  assert.equal(RETIRED_OLDER_SPA.ccc, "/assets/CheckCommandCenter-B-yV-W5w.js");
  assert.notEqual(PINNED_CURRENT_LIVE.djnh_sha256, RETIRED_OLDER_SPA.djnh_sha256);
});

test("Files rewrite may keep the live SignatureRequests URL for an in-place refresh", () => {
  const next = rewriteFilesSignatureImport(liveFiles, "SignatureRequests-ipdlcpz2.js");
  assert.match(next, /from"\.\/SignatureRequests-ipdlcpz2\.js"/);
  assert.match(next, /return s\?\?\[\]\}\}\),\{data:checkClaim\}=T\(/);
});

test("Files rewrite keeps the live 0Fmhwbep URL contract and two-hook claim_id lookup", () => {
  const next = rewriteFilesSignatureImport(liveFiles, "SignatureRequests-TESTHASH.js");
  assert.match(next, /from"\.\/SignatureRequests-TESTHASH\.js"/);
  assert.doesNotMatch(next, /SignatureRequests-ipdlcpz2/);
  assert.match(next, /from"\.\/index-DJNHggvS\.js"/);
  assert.match(next, /\.select\("id, claim_id"\)/);
  assert.doesNotMatch(next, /claims:claim_id/);
  assert.match(next, /return s\?\?\[\]\}\}\),\{data:checkClaim\}=T\(/);
  assert.match(next, /linkedClaim&&linkedClaim\.id&&e\.jsx\(sigReq/);
});

test("single-entry write guard rejects a second application entry", () => {
  assert.throws(
    () => assertSingleEntryWrites({
      "assets/index-NEWentry.js": "nope",
      "assets/CheckFilesSection-0Fmhwbep.js": liveFiles,
      "assets/SignatureRequests-abc.js": "sig",
    }),
    /single-entry repair must stay pinned/,
  );
  assert.throws(
    () => assertSingleEntryWrites({
      "assets/CheckCommandCenter-NEW.js": "nope",
      "assets/CheckFilesSection-0Fmhwbep.js": liveFiles,
      "assets/SignatureRequests-abc.js": "sig",
    }),
    /CCC must remain/,
  );
  const allowed = assertSingleEntryWrites({
    "assets/CheckFilesSection-0Fmhwbep.js": liveFiles,
    "assets/SignatureRequests-abc.js": "sig",
  });
  assert.equal(allowed.filesKey, "assets/CheckFilesSection-0Fmhwbep.js");
  assert.equal(allowed.sigKey, "assets/SignatureRequests-abc.js");
});

test("current live HTML still points at the canonical DJN entry", () => {
  assert.equal(parseHtmlEntry(liveHtml), "/assets/index-DJNHggvS.js");
  assert.doesNotMatch(liveHtml, /index-QKetcACR/);
});

test("assertCurrentLiveGraph fails closed on retired Files/CCC names", () => {
  assert.throws(
    () => assertCurrentLiveGraph({
      indexHtml: liveHtml,
      entryJs: 'createRoot;CheckCommandCenter-B-yV-W5w.js',
      cccJs: 'CheckFilesSection-DC3uOrqc.js',
      filesJs: liveFiles,
    }),
    /current live baseline drift/,
  );
});

test("retired overlay/promote scripts refuse the older SPA and production writes", () => {
  const oldBuild = readFileSync("scripts/build-production-restore-sig-files-overlay.mjs", "utf8");
  const oldPromote = readFileSync("scripts/promote-production-restore-sig-files-ui-spa.mjs", "utf8");
  const singlePromote = readFileSync("scripts/promote-production-sig-single-entry-fix.mjs", "utf8");
  const nextBuild = readFileSync("scripts/build-live-sig-requests-overlay.mjs", "utf8");
  assert.match(oldBuild, /REFUSE_OLDER_SPA/);
  assert.match(oldPromote, /REFUSE_OLDER_SPA/);
  assert.match(oldPromote, /REFUSE_PROD_DEPLOY/);
  assert.match(singlePromote, /REFUSE_PROD_DEPLOY/);
  assert.match(nextBuild, /current-live-sig-requests-same-entry/);
  assert.match(nextBuild, /index_html_untouched/);
  assert.match(nextBuild, /CheckFilesSection-0Fmhwbep\.js/);
  assert.doesNotMatch(nextBuild, /CheckFilesSection-DC3uOrqc/);
  assert.doesNotMatch(nextBuild, /CheckCommandCenter-B-yV-W5w/);
  assert.match(REFUSE_OLDER_SPA, /Current live production/);
  assert.match(REFUSE_PROD_DEPLOY, /disabled/);
});
