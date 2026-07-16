import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Scan, RotateCcw, Check as CheckIcon } from "lucide-react";
import { convertHeicToJpegIfNeeded } from "@/lib/convertHeic";

/**
 * CheckImageCropper — dialog that lets the user crop a photo down to the
 * check itself before upload. Runs a lightweight auto-detect pass first
 * (bounding box of pixels that differ from the sampled corner background)
 * and then lets the user drag/resize the rectangle to fine-tune. PDFs and
 * anything that can't be decoded as an image are passed through untouched.
 */

type Rect = { x: number; y: number; w: number; h: number }; // in NATURAL image px

interface Props {
  file: File | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (croppedFile: File) => void;
  title?: string;
}

const MIN_SIZE = 40; // min crop size in px (natural)

export function CheckImageCropper({ file, open, onCancel, onConfirm, title = "Crop the check" }: Props) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [passthrough, setPassthrough] = useState(false); // true for PDFs etc.
  const [srcFile, setSrcFile] = useState<File | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Load file → object URL, convert HEIC, or pass through non-images
  useEffect(() => {
    if (!open || !file) return;
    let cancelled = false;
    setBusy(true);
    setPassthrough(false);
    setImgUrl(null);
    setRect(null);
    setNatural(null);

    (async () => {
      try {
        // PDFs and anything not an image — pass through unchanged.
        if (!file.type.startsWith("image/") && !/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
          if (cancelled) return;
          setPassthrough(true);
          setSrcFile(file);
          setBusy(false);
          return;
        }
        const safe = await convertHeicToJpegIfNeeded(file);
        if (cancelled) return;
        setSrcFile(safe);
        const url = URL.createObjectURL(safe);
        setImgUrl(url);
      } catch (e) {
        if (!cancelled) {
          setPassthrough(true);
          setSrcFile(file);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, open]);

  // Revoke object URL
  useEffect(() => {
    return () => {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    };
  }, [imgUrl]);

  // Auto-detect check bounding box once the image is decoded
  const runAutoDetect = useCallback(async () => {
    if (!imgUrl || !natural) return;
    setBusy(true);
    try {
      const detected = await detectCheckBBox(imgUrl, natural.w, natural.h);
      setRect(detected);
    } finally {
      setBusy(false);
    }
  }, [imgUrl, natural]);

  const handleImgLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    setNatural(nat);
    // Auto-detect right away
    detectCheckBBox(img.src, nat.w, nat.h)
      .then((r) => setRect(r))
      .catch(() => {
        setRect({ x: nat.w * 0.05, y: nat.h * 0.15, w: nat.w * 0.9, h: nat.h * 0.7 });
      });
  };

  // Convert natural rect → display px within the rendered image
  const displayRect = (() => {
    if (!rect || !imgRef.current || !natural) return null;
    const img = imgRef.current;
    const scale = img.clientWidth / natural.w;
    return {
      x: rect.x * scale,
      y: rect.y * scale,
      w: rect.w * scale,
      h: rect.h * scale,
    };
  })();

  // Drag / resize
  const dragState = useRef<null | {
    mode: "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
    startX: number; startY: number;
    orig: Rect;
    scale: number;
  }>(null);

  const onPointerDown = (mode: NonNullable<typeof dragState.current>["mode"]) =>
    (e: React.PointerEvent) => {
      if (!rect || !imgRef.current || !natural) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      dragState.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        orig: { ...rect },
        scale: imgRef.current.clientWidth / natural.w,
      };
    };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st || !natural) return;
    const dx = (e.clientX - st.startX) / st.scale;
    const dy = (e.clientY - st.startY) / st.scale;
    let { x, y, w, h } = st.orig;

    const clamp = () => {
      if (w < MIN_SIZE) w = MIN_SIZE;
      if (h < MIN_SIZE) h = MIN_SIZE;
      if (x < 0) { w += x; x = 0; }
      if (y < 0) { h += y; y = 0; }
      if (x + w > natural.w) w = natural.w - x;
      if (y + h > natural.h) h = natural.h - y;
    };

    switch (st.mode) {
      case "move":
        x = Math.max(0, Math.min(natural.w - w, x + dx));
        y = Math.max(0, Math.min(natural.h - h, y + dy));
        break;
      case "e": w += dx; break;
      case "w": x += dx; w -= dx; break;
      case "s": h += dy; break;
      case "n": y += dy; h -= dy; break;
      case "se": w += dx; h += dy; break;
      case "sw": x += dx; w -= dx; h += dy; break;
      case "ne": y += dy; h -= dy; w += dx; break;
      case "nw": x += dx; w -= dx; y += dy; h -= dy; break;
    }
    clamp();
    setRect({ x, y, w, h });
  };

  const onPointerUp = () => { dragState.current = null; };

  const handleConfirm = async () => {
    if (passthrough && srcFile) { onConfirm(srcFile); return; }
    if (!rect || !imgUrl || !natural || !srcFile) return;
    setBusy(true);
    try {
      const cropped = await cropImageFile(srcFile, imgUrl, rect);
      onConfirm(cropped);
    } catch (e) {
      console.error("[CheckImageCropper] crop failed, using original file", e);
      onConfirm(srcFile);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {passthrough ? (
          <div className="p-4 text-sm text-muted-foreground">
            This file type can't be cropped — it will be uploaded as-is.
          </div>
        ) : (
          <div
            ref={containerRef}
            className="relative w-full max-h-[70vh] overflow-auto bg-muted/30 rounded-md flex items-center justify-center touch-none"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {imgUrl && (
              <div className="relative inline-block">
                <img
                  ref={imgRef}
                  src={imgUrl}
                  alt="check to crop"
                  className="block max-w-full max-h-[70vh] select-none"
                  draggable={false}
                  onLoad={handleImgLoad}
                />
                {displayRect && (
                  <>
                    {/* darken outside area with 4 overlays */}
                    <div className="absolute inset-0 pointer-events-none">
                      <div className="absolute bg-black/55" style={{ left: 0, top: 0, width: "100%", height: displayRect.y }} />
                      <div className="absolute bg-black/55" style={{ left: 0, top: displayRect.y + displayRect.h, width: "100%", bottom: 0 }} />
                      <div className="absolute bg-black/55" style={{ left: 0, top: displayRect.y, width: displayRect.x, height: displayRect.h }} />
                      <div className="absolute bg-black/55" style={{ left: displayRect.x + displayRect.w, top: displayRect.y, right: 0, height: displayRect.h }} />
                    </div>
                    {/* crop rect */}
                    <div
                      className="absolute border-2 border-primary cursor-move"
                      style={{ left: displayRect.x, top: displayRect.y, width: displayRect.w, height: displayRect.h }}
                      onPointerDown={onPointerDown("move")}
                    >
                      {(["n","s","e","w","ne","nw","se","sw"] as const).map((h) => (
                        <div
                          key={h}
                          onPointerDown={onPointerDown(h)}
                          className={`absolute bg-primary border border-background rounded-sm ${handleCursor(h)}`}
                          style={handleStyle(h)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {busy && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/50">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {!passthrough && (
            <>
              <Button variant="outline" onClick={runAutoDetect} disabled={busy || !imgUrl}>
                <Scan className="h-4 w-4 mr-1.5" /> Auto-detect
              </Button>
              <Button
                variant="outline"
                onClick={() => natural && setRect({ x: 0, y: 0, w: natural.w, h: natural.h })}
                disabled={busy || !natural}
              >
                <RotateCcw className="h-4 w-4 mr-1.5" /> Reset
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={busy || (!passthrough && !rect)}>
            <CheckIcon className="h-4 w-4 mr-1.5" /> Use this crop
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Handle styling                                                     */
/* ------------------------------------------------------------------ */

function handleStyle(h: string): React.CSSProperties {
  const s = 12;
  const off = -s / 2;
  const map: Record<string, React.CSSProperties> = {
    n:  { top: off, left: `calc(50% - ${s/2}px)`, width: s, height: s },
    s:  { bottom: off, left: `calc(50% - ${s/2}px)`, width: s, height: s },
    e:  { right: off, top: `calc(50% - ${s/2}px)`, width: s, height: s },
    w:  { left: off, top: `calc(50% - ${s/2}px)`, width: s, height: s },
    ne: { top: off, right: off, width: s, height: s },
    nw: { top: off, left: off, width: s, height: s },
    se: { bottom: off, right: off, width: s, height: s },
    sw: { bottom: off, left: off, width: s, height: s },
  };
  return map[h];
}
function handleCursor(h: string): string {
  return {
    n: "cursor-ns-resize", s: "cursor-ns-resize",
    e: "cursor-ew-resize", w: "cursor-ew-resize",
    ne: "cursor-nesw-resize", sw: "cursor-nesw-resize",
    nw: "cursor-nwse-resize", se: "cursor-nwse-resize",
  }[h] ?? "";
}

/* ------------------------------------------------------------------ */
/*  Auto-detect: sample corner background, find bbox of non-bg pixels  */
/* ------------------------------------------------------------------ */

async function detectCheckBBox(src: string, natW: number, natH: number): Promise<Rect> {
  const img = await loadImage(src);
  const targetW = 500;
  const scale = Math.min(1, targetW / natW);
  const w = Math.max(50, Math.round(natW * scale));
  const h = Math.max(50, Math.round(natH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallbackRect(natW, natH);
  ctx.drawImage(img, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return fallbackRect(natW, natH);
  }

  // Grayscale luminance array
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    lum[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }

  // --- Strategy A: check is brighter paper on darker background.
  // Sample corners for background luminance, then find pixels significantly brighter.
  const patch = Math.max(6, Math.round(Math.min(w, h) * 0.06));
  const bgLum = sampleCornerLuminance(lum, w, h, patch);
  const brightThresh = Math.min(230, bgLum + 40);

  const rowB = new Uint32Array(h);
  const colB = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] > brightThresh) {
        rowB[y]++;
        colB[x]++;
      }
    }
  }

  // --- Strategy B: edge density (Sobel-lite). Check has printed text/borders.
  const rowE = new Uint32Array(h);
  const colE = new Uint32Array(w);
  const edgeThresh = 30;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = Math.abs(lum[y * w + x + 1] - lum[y * w + x - 1]);
      const gy = Math.abs(lum[(y + 1) * w + x] - lum[(y - 1) * w + x]);
      if (gx + gy > edgeThresh) {
        rowE[y]++;
        colE[x]++;
      }
    }
  }

  const tryBBox = (rows: Uint32Array, cols: Uint32Array, minFrac: number): Rect | null => {
    const rowMin = Math.max(3, Math.round(w * minFrac));
    const colMin = Math.max(3, Math.round(h * minFrac));
    const top = firstAbove(rows, rowMin);
    const bottom = lastAbove(rows, rowMin);
    const left = firstAbove(cols, colMin);
    const right = lastAbove(cols, colMin);
    if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
    if (right - left < w * 0.25 || bottom - top < h * 0.15) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  };

  // Prefer brightness-based result if it covers a reasonable area; else edge-based.
  let box = tryBBox(rowB, colB, 0.05);
  const area = (r: Rect | null) => (r ? r.w * r.h : 0);
  if (!box || area(box) < w * h * 0.1) {
    const edgeBox = tryBBox(rowE, colE, 0.04);
    if (edgeBox && area(edgeBox) > area(box)) box = edgeBox;
  }
  if (!box) return fallbackRect(natW, natH);

  const pad = 4;
  const x0 = Math.max(0, box.x - pad) / scale;
  const y0 = Math.max(0, box.y - pad) / scale;
  const x1 = Math.min(w - 1, box.x + box.w + pad) / scale;
  const y1 = Math.min(h - 1, box.y + box.h + pad) / scale;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function sampleCornerLuminance(lum: Uint8ClampedArray, w: number, h: number, patch: number): number {
  const corners = [[0, 0], [w - patch, 0], [0, h - patch], [w - patch, h - patch]];
  const values: number[] = [];
  for (const [cx, cy] of corners) {
    let sum = 0, n = 0;
    for (let y = cy; y < cy + patch; y++) {
      for (let x = cx; x < cx + patch; x++) {
        sum += lum[y * w + x]; n++;
      }
    }
    values.push(sum / n);
  }
  // Use median of the 4 corners so one bright corner doesn't skew it
  values.sort((a, b) => a - b);
  return (values[1] + values[2]) / 2;
}

function fallbackRect(natW: number, natH: number): Rect {
  return { x: natW * 0.05, y: natH * 0.15, w: natW * 0.9, h: natH * 0.7 };
}

function firstAbove(arr: Uint32Array, min: number): number {
  for (let i = 0; i < arr.length; i++) if (arr[i] >= min) return i;
  return -1;
}
function lastAbove(arr: Uint32Array, min: number): number {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= min) return i;
  return -1;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* ------------------------------------------------------------------ */
/*  Crop → File                                                        */
/* ------------------------------------------------------------------ */

async function cropImageFile(originalFile: File, url: string, rect: Rect): Promise<File> {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.w));
  canvas.height = Math.max(1, Math.round(rect.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) return originalFile;
  ctx.drawImage(
    img,
    Math.round(rect.x), Math.round(rect.y),
    Math.round(rect.w), Math.round(rect.h),
    0, 0, canvas.width, canvas.height,
  );
  const mime = "image/jpeg";
  const blob: Blob = await new Promise((res, rej) => {
    canvas.toBlob((b) => {
      if (b && b.size > 0) res(b);
      else rej(new Error("Canvas produced an empty image"));
    }, mime, 0.92);
  });
  if (!blob || blob.size === 0) return originalFile;
  const baseName = originalFile.name.replace(/\.(heic|heif|png|webp|jpe?g)$/i, "");
  return new File([blob], `${baseName || "check"}_cropped.jpg`, { type: mime });
}
