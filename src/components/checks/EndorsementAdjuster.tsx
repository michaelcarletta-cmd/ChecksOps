import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RotateCcw, Save } from "lucide-react";
import {
  clampEndorsementOverride,
  DEFAULT_ENDORSEMENT_OVERRIDE,
  EndorsementOverride,
  getEndorsementLayout,
} from "@/lib/endorsementLayout";

type EndorsementAdjusterProps = {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  clientName: string;
  ownerName: string;
  companyName: string;
  clientSignatureUrl?: string | null;
  ownerSignatureUrl?: string | null;
  initialOverride?: EndorsementOverride | null;
  onSave: (override: EndorsementOverride) => Promise<void> | void;
};

export function EndorsementAdjuster({
  imageUrl,
  imageWidth,
  imageHeight,
  clientName,
  ownerName,
  companyName,
  clientSignatureUrl,
  ownerSignatureUrl,
  initialOverride,
  onSave,
}: EndorsementAdjusterProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [override, setOverride] = useState<EndorsementOverride>(
    initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE,
  );
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [activePointerId, setActivePointerId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOverride(initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE);
  }, [initialOverride]);

  const containerWidth = wrapRef.current?.clientWidth ?? imageWidth;
  const displayScale = containerWidth / imageWidth;

  const layout = useMemo(
    () => getEndorsementLayout(imageWidth, imageHeight, override),
    [imageWidth, imageHeight, override],
  );

  const runNextFrame = (fn: () => void) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      fn();
      rafRef.current = null;
    });
  };

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (activePointerId !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setActivePointerId(e.pointerId);
    setDragging(true);
  };

  const beginResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (activePointerId !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setActivePointerId(e.pointerId);
    setResizing(true);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!wrapRef.current) return;
      if (activePointerId !== e.pointerId) return;
      if (!dragging && !resizing) return;

      const rect = wrapRef.current.getBoundingClientRect();
      const liveContainerWidth = wrapRef.current.clientWidth || imageWidth;
      const liveDisplayScale = liveContainerWidth / imageWidth;
      const liveLayout = getEndorsementLayout(imageWidth, imageHeight, override);

      runNextFrame(() => {
        if (dragging) {
          setOverride(
            clampEndorsementOverride({
              ...override,
              xPct:
                (e.clientX - rect.left - (liveLayout.width * liveDisplayScale) / 2) /
                rect.width,
              yPct: (e.clientY - rect.top - 20) / rect.height,
              scale: override.scale,
              rotationDeg: override.rotationDeg,
            }),
          );
        }

        if (resizing) {
          const overlayLeft = rect.left + liveLayout.x * liveDisplayScale;
          const deltaX = e.clientX - overlayLeft;
          const nextScale = Math.max(
            0.4,
            Math.min(2, deltaX / (imageWidth * 0.20 * liveDisplayScale)),
          );
          setOverride((prev) =>
            clampEndorsementOverride({
              ...prev,
              scale: nextScale,
            }),
          );
        }
      });
    };

    const onUp = (e: PointerEvent) => {
      if (activePointerId !== e.pointerId) return;
      setDragging(false);
      setResizing(false);
      setActivePointerId(null);
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    window.addEventListener("pointercancel", onUp, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [activePointerId, dragging, resizing, override, imageWidth, imageHeight]);

  const handleReset = () => {
    setOverride(DEFAULT_ENDORSEMENT_OVERRIDE);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(clampEndorsementOverride(override));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Image preview with draggable overlay */}
      <div
        ref={wrapRef}
        className="relative mx-auto overflow-hidden rounded border bg-white"
        style={{ width: "100%", maxWidth: 900, touchAction: "none" }}
      >
        <img
          src={imageUrl}
          alt="Back of check"
          className="block h-auto w-full object-contain"
          draggable={false}
          onLoad={(e) => {
            console.log("loaded image", {
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            });
          }}
        />

        {/* endorsement zone guide (faint outline) */}
        <div
          className="absolute border border-dashed border-muted-foreground/30 pointer-events-none rounded"
          style={{
            left: `${(layout.x / imageWidth) * 100}%`,
            top: `${(layout.y / imageHeight) * 100}%`,
            width: `${(layout.width / imageWidth) * 100}%`,
            height: "20%",
          }}
        />

        {/* draggable overlay */}
        <div
          onPointerDown={beginDrag}
          className="absolute select-none"
          style={{
            left: layout.x * displayScale,
            top: layout.y * displayScale,
            width: layout.width * displayScale,
            color: "#111111",
            transform: `rotate(${layout.rotationDeg}deg)`,
            transformOrigin: "top left",
            userSelect: "none",
            touchAction: "none",
            cursor: dragging ? "grabbing" : "grab",
            opacity: dragging ? 0.92 : 1,
            zIndex: 20,
          }}
        >
          <div
            style={{
              fontSize: layout.payToFont * displayScale,
              fontWeight: 600,
              lineHeight: 1.1,
              marginBottom: layout.lineGap * displayScale,
              color: "#111111",
            }}
          >
            Pay to the order of
          </div>

          <div
            style={{
              fontSize: layout.companyFont * displayScale,
              fontWeight: 700,
              lineHeight: 1.05,
              marginBottom: layout.lineGap * displayScale,
              color: "#111111",
            }}
          >
            {companyName}
          </div>

          <div
            style={{
              fontSize: layout.mobileOnlyFont * displayScale,
              fontWeight: 700,
              lineHeight: 1.1,
              marginBottom: layout.sectionGap * displayScale,
              color: "#111111",
            }}
          >
            For Mobile Deposit Only
          </div>

          <div
            style={{
              fontSize: layout.payeeFont * displayScale,
              fontWeight: 700,
              lineHeight: 1.1,
              marginBottom: layout.lineGap * displayScale,
              color: "#111111",
            }}
          >
            {clientName}
          </div>

          {clientSignatureUrl ? (
            <img
              src={clientSignatureUrl}
              alt="Client signature"
              style={{
                height: layout.signatureHeight * displayScale,
                marginBottom: layout.sectionGap * displayScale,
              }}
              className="object-contain"
              draggable={false}
            />
          ) : (
            <div
              style={{
                fontSize: layout.payeeFont * displayScale,
                fontStyle: "italic",
                fontFamily: '"Brush Script MT", cursive',
                marginBottom: layout.sectionGap * displayScale,
                color: "#111111",
              }}
            >
              {clientName}
            </div>
          )}

          <div
            style={{
              fontSize: layout.companyFont * displayScale,
              fontWeight: 700,
              lineHeight: 1.05,
              marginBottom: layout.lineGap * displayScale,
              color: "#111111",
            }}
          >
            {companyName}
          </div>

          <div
            style={{
              fontSize: layout.byLineFont * displayScale,
              fontWeight: 600,
              lineHeight: 1.1,
              marginBottom: layout.lineGap * displayScale,
              color: "#111111",
            }}
          >
            By: {ownerName}
          </div>

          {ownerSignatureUrl ? (
            <img
              src={ownerSignatureUrl}
              alt="Owner signature"
              style={{ height: layout.signatureHeight * displayScale }}
              className="object-contain"
              draggable={false}
            />
          ) : (
            <div
              style={{
                fontSize: layout.byLineFont * displayScale,
                fontStyle: "italic",
                fontFamily: '"Brush Script MT", cursive',
                color: "#111111",
              }}
            >
              {ownerName}
            </div>
          )}

          {/* resize handle */}
          <div
            onPointerDown={beginResize}
            className="absolute rounded-full border-2 border-background bg-foreground shadow"
            style={{
              width: 32,
              height: 32,
              right: -16,
              bottom: -16,
              cursor: "nwse-resize",
              touchAction: "none",
              opacity: resizing ? 0.85 : 1,
            }}
          />
        </div>
      </div>

      {/* Controls */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Adjust Endorsement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* D-pad nudge buttons */}
          <div className="grid grid-cols-3 gap-2">
            <div />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, yPct: prev.yPct - 0.005 }),
                )
              }
            >
              Up
            </Button>
            <div />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, xPct: prev.xPct - 0.005 }),
                )
              }
            >
              Left
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, yPct: prev.yPct + 0.005 }),
                )
              }
            >
              Down
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, xPct: prev.xPct + 0.005 }),
                )
              }
            >
              Right
            </Button>
          </div>

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Scale</p>
            <Slider
              min={0.4}
              max={2}
              step={0.05}
              value={[override.scale]}
              onValueChange={([v]) =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, scale: v }),
                )
              }
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Rotation</p>
            <Slider
              min={-10}
              max={10}
              step={0.5}
              value={[override.rotationDeg]}
              onValueChange={([v]) =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, rotationDeg: v }),
                )
              }
            />
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <Save className="h-3 w-3 mr-1" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
