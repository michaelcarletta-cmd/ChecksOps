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
  const wrapRef = useRef<HTMLDivElement>(null);
  const [override, setOverride] = useState<EndorsementOverride>(
    initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE,
  );
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOverride(initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE);
  }, [initialOverride]);

  const layout = useMemo(
    () => getEndorsementLayout(imageWidth, imageHeight, override),
    [imageWidth, imageHeight, override],
  );

  // Compute display scale factor (image → container)
  const containerWidth = wrapRef.current?.clientWidth ?? imageWidth;
  const displayScale = containerWidth / imageWidth;

  const beginDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const beginResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();

      if (dragging) {
        const next = clampEndorsementOverride({
          ...override,
          xPct: (e.clientX - rect.left - (layout.width * displayScale) / 2) / rect.width,
          yPct: (e.clientY - rect.top - 20) / rect.height,
        });
        setOverride(next);
      }

      if (resizing) {
        const centerX = rect.left + layout.x * displayScale;
        const deltaX = e.clientX - centerX;
        const nextScale = Math.max(0.4, Math.min(2, deltaX / (imageWidth * 0.20 * displayScale)));
        setOverride((prev) =>
          clampEndorsementOverride({
            ...prev,
            scale: nextScale,
          }),
        );
      }
    };

    const onUp = () => {
      setDragging(false);
      setResizing(false);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, resizing, override, layout, imageWidth, displayScale]);

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
        className="relative w-full overflow-hidden rounded-md border border-border bg-muted"
        style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }}
      >
        <img
          src={imageUrl}
          alt="Check back"
          className="absolute inset-0 w-full h-full object-contain"
          draggable={false}
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
          className="absolute cursor-move select-none"
          style={{
            left: `${(layout.x / imageWidth) * 100}%`,
            top: `${(layout.y / imageHeight) * 100}%`,
            transform: `rotate(${layout.rotationDeg}deg)`,
            transformOrigin: "top left",
          }}
          onMouseDown={beginDrag}
        >
          <div
            style={{ fontSize: `${layout.payToFont * displayScale}px`, fontWeight: 600 }}
            className="text-foreground whitespace-nowrap"
          >
            Pay to the order of
          </div>

          <div
            style={{ fontSize: `${layout.companyFont * displayScale}px`, fontWeight: 700 }}
            className="text-foreground whitespace-nowrap"
          >
            {companyName}
          </div>

          <div
            style={{ fontSize: `${layout.mobileOnlyFont * displayScale}px`, fontWeight: 700 }}
            className="text-foreground whitespace-nowrap"
          >
            For Mobile Deposit Only
          </div>

          <div
            style={{
              fontSize: `${layout.payeeFont * displayScale}px`,
              fontWeight: 700,
              marginTop: `${layout.sectionGap * displayScale}px`,
            }}
            className="text-foreground whitespace-nowrap"
          >
            {clientName}
          </div>

          {clientSignatureUrl ? (
            <img
              src={clientSignatureUrl}
              alt="Client signature"
              style={{ height: `${layout.signatureHeight * displayScale}px` }}
              className="object-contain"
              draggable={false}
            />
          ) : (
            <div
              style={{
                fontSize: `${layout.payeeFont * displayScale}px`,
                fontStyle: "italic",
                fontFamily: '"Brush Script MT", cursive',
              }}
              className="text-foreground whitespace-nowrap"
            >
              {clientName}
            </div>
          )}

          <div
            style={{
              fontSize: `${layout.companyFont * displayScale}px`,
              fontWeight: 700,
              marginTop: `${layout.sectionGap * displayScale}px`,
            }}
            className="text-foreground whitespace-nowrap"
          >
            {companyName}
          </div>

          <div
            style={{ fontSize: `${layout.byLineFont * displayScale}px`, fontWeight: 600 }}
            className="text-foreground whitespace-nowrap"
          >
            By: {ownerName}
          </div>

          {ownerSignatureUrl ? (
            <img
              src={ownerSignatureUrl}
              alt="Owner signature"
              style={{ height: `${layout.signatureHeight * displayScale}px` }}
              className="object-contain"
              draggable={false}
            />
          ) : (
            <div
              style={{
                fontSize: `${layout.byLineFont * displayScale}px`,
                fontStyle: "italic",
                fontFamily: '"Brush Script MT", cursive',
              }}
              className="text-foreground whitespace-nowrap"
            >
              {ownerName}
            </div>
          )}

          {/* resize handle */}
          <div
            className="absolute -right-2 -bottom-2 w-4 h-4 bg-primary rounded-full cursor-se-resize border-2 border-background"
            onMouseDown={beginResize}
          />
        </div>
      </div>

      {/* Controls */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Adjust Endorsement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Horizontal Position</p>
            <Slider
              min={0.05}
              max={0.75}
              step={0.01}
              value={[override.xPct]}
              onValueChange={([v]) =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, xPct: v }),
                )
              }
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Vertical Position</p>
            <Slider
              min={0.03}
              max={0.30}
              step={0.01}
              value={[override.yPct]}
              onValueChange={([v]) =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, yPct: v }),
                )
              }
            />
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
