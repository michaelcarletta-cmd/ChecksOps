import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const adjuster = readFileSync(new URL("../src/components/checks/EndorsementAdjuster.tsx", import.meta.url), "utf8");
const ccc = readFileSync(new URL("../src/pages/CheckCommandCenter.tsx", import.meta.url), "utf8");

test("Adjust Endorsement viewer zooms inside a scroll container (Cursor 7874a3114)", () => {
  assert.match(adjuster, /const \[viewerZoom, setViewerZoom\] = useState\(1\)/);
  assert.match(adjuster, /Math\.min\(2\.5,/);
  assert.match(adjuster, /overflow-auto rounded border bg-white" style=\{\{ maxHeight: "72vh" \}\}/);
  assert.match(adjuster, /width: `\$\{Math\.round\(viewerZoom \* 100\)\}%`, minWidth: "100%"/);
  assert.doesNotMatch(adjuster, /maxWidth: 900/);
  // The overlay is laid out from the measured wrapper; it must re-render after a zoom change.
  assert.match(adjuster, /requestAnimationFrame\(\(\) => setViewerLayoutTick/);
});

test("Adjust Received Endorsement dialog is wide enough for the viewer", () => {
  assert.match(ccc, /max-w-7xl w-\[min\(96vw,1680px\)\] max-h-\[90vh\] overflow-y-auto">\s*<DialogHeader>\s*<DialogTitle>Adjust Received Endorsement/);
});

test("signed URLs are never cache-busted by query mutation (Cursor 1cf74c7c7)", () => {
  assert.doesNotMatch(ccc, /signedUrl\}&v=/);
  assert.doesNotMatch(adjuster, /signedUrl\}&v=/);
});
