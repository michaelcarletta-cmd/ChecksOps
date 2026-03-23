import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RotateCcw, Save, AlertCircle } from "lucide-react";
import {
  clampEndorsementOverride,
  DEFAULT_ENDORSEMENT_OVERRIDE,
  EndorsementOverride,
  getEndorsementLayout,
  normalizeRotation,
} from "@/lib/endorsementLayout";
import { supabase } from "@/integrations/supabase/client";

interface SignedEndorsementAsset {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signed_at: string | null;
  signature_image_url: string | null;
  signature_method: string | null;
  check_id: string;
}

type EndorsementAdjusterProps = {
  checkId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  companyName: string;
  ownerName: string;
  initialOverride?: EndorsementOverride | null;
  onSave: (override: EndorsementOverride) => Promise<void> | void;
};

export function EndorsementAdjuster({
  checkId,
  imageUrl,
  imageWidth,
  imageHeight,
  companyName,
  ownerName,
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

  // Load real signed endorsement assets for this check
  const [signedEndorsements, setSignedEndorsements] = useState<SignedEndorsementAsset[]>([]);
  const [endorsementsLoading, setEndorsementsLoading] = useState(true);
  const [endorsementsError, setEndorsementsError] = useState<string | null>(null);

  useEffect(() => {
    if (!checkId) return;
    let cancelled = false;
    (async () => {
      setEndorsementsLoading(true);
      setEndorsementsError(null);
      try {
        const { data, error } = await supabase
          .from("check_endorsements")
          .select("id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method, check_id")
          .eq("check_id", checkId)
          .eq("status", "signed")
          .not("signature_image_url", "is", null)
          .order("created_at", { ascending: true });
        if (error) throw error;
        if (!cancelled) setSignedEndorsements(data ?? []);
      } catch (e: any) {
        if (!cancelled) setEndorsementsError(e.message || "Failed to load endorsements");
      } finally {
        if (!cancelled) setEndorsementsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [checkId]);

  const isFreedomOrCarletta = (name: string) => {
    const lc = name.toLowerCase();
    return lc.includes("freedom") || lc.includes("carletta");
  };

  const clientEndorsements = signedEndorsements.filter((e) => !isFreedomOrCarletta(e.payee_name));
  const companyEndorsements = signedEndorsements.filter((e) => isFreedomOrCarletta(e.payee_name));
  const canGenerate = signedEndorsements.length > 0;

  useEffect(() => {
    setOverride(initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE);
  }, [initialOverride]);

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

  // Center-origin drag: update xPct/yPct as the center of the overlay
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

      runNextFrame(() => {
        if (dragging) {
          // Center-origin: pointer position becomes the center of the overlay
          const xPct = (e.clientX - rect.left) / rect.width;
          const yPct = (e.clientY - rect.top) / rect.height;
          setOverride((prev) =>
            clampEndorsementOverride({
              ...prev,
              xPct,
              yPct,
            }),
          );
        }

        if (resizing) {
          const containerWidth = wrapRef.current!.clientWidth || imageWidth;
          const displayScale = containerWidth / imageWidth;
          const overlayLeft = rect.left + override.xPct * rect.width;
          const deltaX = e.clientX - overlayLeft;
          const nextScale = Math.max(
            0.4,
            Math.min(2, deltaX / (imageWidth * 0.20 * displayScale)),
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

  // Use actual rendered DOM rect for overlay positioning
  const rect = wrapRef.current?.getBoundingClientRect();
  const containerWidthPx = rect?.width ?? imageWidth;
  const containerHeightPx = rect?.height ?? (imageWidth > 0 ? containerWidthPx * imageHeight / imageWidth : imageHeight);

  const overlayLeftPx = override.xPct * containerWidthPx;
  const overlayTopPx = override.yPct * containerHeightPx;
  const displayScale = containerWidthPx / imageWidth;
  const overlayWidthPx = layout.width * displayScale;

  return (
    <div className="space-y-4">
      {/* Endorsement source info */}
      {endorsementsLoading ? (
        <div className="text-sm text-muted-foreground">Loading endorsement signatures...</div>
      ) : endorsementsError ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          Error loading endorsements: {endorsementsError}
        </div>
      ) : !canGenerate ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          No completed endorsement signatures found for this check.
        </div>
      ) : (
        <div className="space-y-1">
          <div className="text-sm text-muted-foreground">
            Loaded signatures: {signedEndorsements.map((s) => s.payee_name).join(", ")}
          </div>
          <div className="text-xs text-muted-foreground">
            Source check: {signedEndorsements[0]?.check_id}
          </div>
        </div>
      )}

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
        />

        {/* draggable overlay – center-origin positioning */}
        <div
          onPointerDown={beginDrag}
          className="absolute select-none"
          style={{
            left: overlayLeftPx,
            top: overlayTopPx,
            width: overlayWidthPx,
            transform: `translate(-50%, -50%) rotate(${layout.rotationDeg}deg)`,
            transformOrigin: "center center",
            color: "#111111",
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

          {/* Client endorsement names from actual signed data */}
          {clientEndorsements.map((endorsement) => (
            <div key={endorsement.id}>
              <div
                style={{
                  fontSize: layout.payeeFont * displayScale,
                  fontWeight: 700,
                  lineHeight: 1.1,
                  marginBottom: layout.lineGap * displayScale,
                  color: "#111111",
                }}
              >
                {endorsement.payee_name}
              </div>
              {endorsement.signature_image_url && !endorsement.signature_image_url.startsWith("typed:") ? (
                <img
                  src={endorsement.signature_image_url}
                  alt={`${endorsement.payee_name} signature`}
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
                  {endorsement.signature_image_url?.startsWith("typed:")
                    ? endorsement.signature_image_url.slice(6)
                    : endorsement.payee_name}
                </div>
              )}
            </div>
          ))}

          {/* Fallback if no client endorsements loaded yet but still rendering */}
          {clientEndorsements.length === 0 && !endorsementsLoading && (
            <div
              style={{
                fontSize: layout.payeeFont * displayScale,
                fontStyle: "italic",
                color: "#999",
                marginBottom: layout.sectionGap * displayScale,
              }}
            >
              (No client endorsements)
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

          {/* Company/owner signature from actual signed data */}
          {companyEndorsements.length > 0 && companyEndorsements[0].signature_image_url && !companyEndorsements[0].signature_image_url.startsWith("typed:") ? (
            <img
              src={companyEndorsements[0].signature_image_url}
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
              {companyEndorsements.length > 0 && companyEndorsements[0].signature_image_url?.startsWith("typed:")
                ? companyEndorsements[0].signature_image_url.slice(6)
                : ownerName}
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

          {/* Quick rotation buttons */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Quick Rotation</p>
            <div className="flex flex-wrap gap-2">
              {[0, 90, 180, 270].map((deg) => (
                <Button
                  key={deg}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setOverride((prev) =>
                      clampEndorsementOverride({ ...prev, rotationDeg: deg }),
                    )
                  }
                >
                  {deg}°
                </Button>
              ))}
            </div>
          </div>

          {/* Fine rotation adjust */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Rotation: {Math.round(override.rotationDeg)}°
            </p>
            <Slider
              min={0}
              max={360}
              step={1}
              value={[override.rotationDeg]}
              onValueChange={([v]) =>
                setOverride((prev) =>
                  clampEndorsementOverride({ ...prev, rotationDeg: v }),
                )
              }
            />
            <div className="flex gap-2 mt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverride((prev) =>
                    clampEndorsementOverride({
                      ...prev,
                      rotationDeg: normalizeRotation(prev.rotationDeg - 5),
                    }),
                  )
                }
              >
                -5°
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverride((prev) =>
                    clampEndorsementOverride({
                      ...prev,
                      rotationDeg: normalizeRotation(prev.rotationDeg + 5),
                    }),
                  )
                }
              >
                +5°
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverride((prev) =>
                    clampEndorsementOverride({
                      ...prev,
                      rotationDeg: normalizeRotation(prev.rotationDeg + 180),
                    }),
                  )
                }
              >
                Rotate 180°
              </Button>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !canGenerate}>
              <Save className="h-3 w-3 mr-1" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
