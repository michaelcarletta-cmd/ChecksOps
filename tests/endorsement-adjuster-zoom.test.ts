import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const adjuster = readFileSync(new URL("../src/components/checks/EndorsementAdjuster.tsx", import.meta.url), "utf8");
const ccc = readFileSync(new URL("../src/pages/CheckCommandCenter.tsx", import.meta.url), "utf8");

test("Adjust Endorsement viewer zooms inside a scroll container (Cursor 7874a3114)", () => {
  assert.match(adjuster, /const \[viewerZoom, setViewerZoom\] = useState\(1\)/);
  assert.match(adjuster, /Math\.min\(2\.5,/);
  assert.match(adjuster, /overflow-auto rounded border bg-white" style=\{\{ maxHeight: "72vh" \}\}/);
  assert.doesNotMatch(adjuster, /maxWidth: 900/);
  // The overlay is laid out from the measured wrapper; it must re-render after a zoom change.
  assert.match(adjuster, /requestAnimationFrame\(\(\) => setViewerLayoutTick/);
});

test("at 100% zoom the whole back image fits the viewer (no natural-size or forced full-width render)", () => {
  // Fit: full width, but never taller than 70vh (same bound as CheckImageCropper).
  assert.match(adjuster, /const VIEWER_FIT_HEIGHT_VH = 70;/);
  assert.match(adjuster, /const imageAspect = imageWidth > 0 && imageHeight > 0 \? imageWidth \/ imageHeight : 1;/);
  assert.match(adjuster, /const viewerFitWidth = `min\(100%, \$\{\(VIEWER_FIT_HEIGHT_VH \* imageAspect\)\.toFixed\(3\)\}vh\)`;/);
  assert.match(adjuster, /const viewerWidth = `calc\(\$\{viewerFitWidth\} \* \$\{viewerZoom\}\)`;/);
  assert.match(adjuster, /style=\{\{ width: viewerWidth, touchAction: "none" \}\}/);
  // The old rule forced the viewer to the dialog's full width (up to 1680px), so a
  // landscape back image rendered taller than the 72vh scroll box.
  assert.doesNotMatch(adjuster, /minWidth: "100%"/);
  // The image keeps its aspect ratio inside the wrapper.
  assert.match(adjuster, /className="block h-auto w-full object-contain"/);
});

test("overlay geometry uses layout size and follows viewer resizes", () => {
  assert.match(adjuster, /new ResizeObserver\(\(\) => setViewerLayoutTick/);
  assert.match(adjuster, /ref=\{setWrapNode\}/);
  assert.match(adjuster, /const containerWidthPx = wrapEl\?\.offsetWidth \|\| imageWidth;/);
  assert.match(adjuster, /const displayScale = containerWidthPx \/ imageWidth;/);
});

test("Adjust Received Endorsement dialog is wide enough for the viewer", () => {
  assert.match(ccc, /max-w-7xl w-\[min\(96vw,1680px\)\] max-h-\[90vh\] overflow-y-auto">\s*<DialogHeader>\s*<DialogTitle>Adjust Received Endorsement/);
});

test("signed URLs are never cache-busted by query mutation (Cursor 1cf74c7c7)", () => {
  assert.doesNotMatch(ccc, /signedUrl\}&v=/);
  assert.doesNotMatch(adjuster, /signedUrl\}&v=/);
});
