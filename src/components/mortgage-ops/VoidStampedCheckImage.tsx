import { useEffect, useRef, useState } from "react";
import { drawVoidWatermark } from "@/utils/watermarkCheck";

/**
 * A check image for the Mortgage Desk, always shown with "VOID" across it (owner 2026-11-13: "make sure the check
 * images have void on it").
 *
 * The image is drawn into a <canvas> and the VOID watermark is drawn over it, so the page never renders the original
 * as an <img> and offers no link, download or "open image" menu. The canvas is never read back (no toDataURL), so this
 * works for images served without CORS headers. The signed URL the server returns lives 60 seconds.
 *
 * Limit, stated plainly: the browser still fetches the original bytes, so someone watching their own network traffic
 * during those 60 seconds could save them. The stamp prevents casual saving, printing and screenshots without VOID.
 */
export function VoidStampedCheckImage({ src, label }: { src: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        setState("error");
        return;
      }
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      ctx.drawImage(img, 0, 0);
      drawVoidWatermark(ctx, canvas.width, canvas.height);
      setState("ready");
    };
    img.onerror = () => {
      if (!cancelled) setState("error");
    };
    img.src = src;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [src]);

  return (
    <div className="block select-none" onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${label} (VOID)`}
        className={state === "ready" ? "w-full rounded border border-border" : "hidden"}
        draggable={false}
      />
      {state === "loading" && (
        <div className="flex h-24 items-center justify-center rounded border border-border text-xs text-muted-foreground">Loading…</div>
      )}
      {state === "error" && (
        <div className="flex h-24 items-center justify-center rounded border border-border text-xs text-muted-foreground">
          Image unavailable. Refresh to try again.
        </div>
      )}
      <div className="text-[10px] text-center text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
