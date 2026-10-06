import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildSingleEntryRepair,
  comparePinnedLive,
  PINNED_LIVE,
  repairFilesOverlayUseQuery,
  rewriteHtmlToCanonicalEntry,
} from "../scripts/lib/repair-sig-single-entry.mjs";

const brokenNeedle = 'return s??[]}},{data:checkClaim}=T({queryKey:["check-signature-claim",l]';

test("useQuery repair closes the files query before starting the claim query", () => {
  const fixture = [
    '{data:h=[],isLoading:D}=T({queryKey:["check-files",l],queryFn:async()=>{return s??[]}}',
    ',{data:checkClaim}=T({queryKey:["check-signature-claim",l],queryFn:async()=>{const{data:s2,error:t2}=await o.from("check_intake_items").select("id, claim_id, claims:claim_id(id, claim_number, policyholder_name, policyholder_email)").eq("id",l).maybeSingle();if(t2)throw t2;return s2}})',
    ',nestedClaim=checkClaim&&checkClaim.claims||null,resolvedClaimId=nestedClaim&&nestedClaim.id||checkClaim&&checkClaim.claim_id||null,linkedClaim=nestedClaim||(resolvedClaimId?{id:resolvedClaimId,claim_number:null,policyholder_name:null,policyholder_email:null}:null),S=async s=>{',
    'linkedClaim&&linkedClaim.id&&e.jsx(sigReq,{claimId:linkedClaim.id,claim:linkedClaim,checkIntakeItemId:l})',
    'from"./SignatureRequests-ipdlcpz2.js"',
  ].join("");
  const repaired = repairFilesOverlayUseQuery(`import{SignatureRequests as sigReq}from"./SignatureRequests-ipdlcpz2.js";${fixture}`);
  assert.match(repaired, /return s\?\?\[\]\}\}\),\{data:checkClaim\}=T\(/);
  assert.doesNotMatch(repaired, /return s\?\?\[\]\}\},\{data:checkClaim\}=T\(/);
  assert.match(repaired, /\.select\("id, claim_id"\)/);
  assert.doesNotMatch(repaired, /claims:claim_id/);
  assert.match(repaired, /linkedClaim&&linkedClaim\.id&&e\.jsx\(sigReq/);
});

test("canonical HTML rewrite keeps CSS and drops QKetcACR", () => {
  const html = `<script type="module" crossorigin src="/assets/index-QKetcACR.js"></script>\n<link rel="stylesheet" crossorigin href="/assets/index-D9SwIqYu.css">\n<link rel="stylesheet" crossorigin href="/assets/SignatureRequests-fsarOgFO.css">`;
  const next = rewriteHtmlToCanonicalEntry(html);
  assert.match(next, /\/assets\/index-DJNHggvS\.js/);
  assert.doesNotMatch(next, /index-QKetcACR/);
  assert.match(next, /index-D9SwIqYu\.css/);
  assert.match(next, /SignatureRequests-fsarOgFO\.css/);
});

test("pinned live comparator fails closed on entry drift", () => {
  const errors = comparePinnedLive({
    ...PINNED_LIVE,
    html_entry: "/assets/index-Other.js",
  });
  assert.ok(errors.some((row) => /html_entry/.test(row)));
});

test("single-entry repair scripts stay narrow and source Files tab drops the claims embed", () => {
  const promote = readFileSync("scripts/promote-production-sig-single-entry-fix.mjs", "utf8");
  const lib = readFileSync("scripts/lib/repair-sig-single-entry.mjs", "utf8");
  const files = readFileSync("src/components/check-review/CheckFilesSection.tsx", "utf8");
  assert.match(promote, /qketcacr_not_deleted/);
  assert.match(promote, /spa_drift/);
  assert.match(promote, /forbidden Lambda mutation/);
  assert.doesNotMatch(promote, /update-function-code/);
  assert.match(lib, /CheckCommandCenter-M7p55m49\.js/);
  assert.match(lib, /select\("id, claim_id"\)/);
  assert.match(files, /\.select\("id, claim_id"\)/);
  assert.doesNotMatch(files, /claims:claim_id/);
  assert.match(files, /<SignatureRequests/);
});

test("buildSingleEntryRepair only emits the three allowed keys", () => {
  const html = `<script type="module" crossorigin src="/assets/index-QKetcACR.js"></script>\n<link rel="stylesheet" crossorigin href="/assets/index-D9SwIqYu.css">\n<link rel="stylesheet" crossorigin href="/assets/SignatureRequests-fsarOgFO.css">`;
  const files = readFileSync("/tmp/prod-preflight/CheckFilesSection-0Fmhwbep.js", "utf8");
  const entry = readFileSync("/tmp/prod-preflight/index-QKetcACR.js", "utf8");
  assert.match(files, new RegExp(brokenNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const repair = buildSingleEntryRepair({
    indexHtml: html,
    qketcacrJs: entry,
    filesJs: files,
  });
  assert.deepEqual(Object.keys(repair.writes).sort(), [
    "assets/CheckFilesSection-0Fmhwbep.js",
    "assets/index-DJNHggvS.js",
    "index.html",
  ]);
  const repairedFiles = repair.writes["assets/CheckFilesSection-0Fmhwbep.js"].toString();
  assert.match(repairedFiles, /return s\?\?\[\]\}\}\),\{data:checkClaim\}=T\(/);
  assert.match(repairedFiles, /\.select\("id, claim_id"\)/);
  assert.doesNotMatch(repairedFiles, /claims:claim_id/);
});
