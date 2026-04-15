import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RotateCcw, Save, AlertCircle, ShieldCheck } from "lucide-react";
import {
  clampEndorsementOverride,
  DEFAULT_ENDORSEMENT_OVERRIDE,
  EndorsementOverride,
  normalizeRotation,
} from "@/lib/endorsementLayout";
import { fitEndorsementLayout } from "@/lib/endorsementFit";
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
  initialOverride?: EndorsementOverride | null;
  onSave: (override: EndorsementOverride) => Promise<void> | void;
};

export function EndorsementAdjuster({
  checkId,
  imageUrl,
  imageWidth,
  imageHeight,
  companyName,
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
  const [serverError, setServerError] = useState<string | null>(null);
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
          .in("status", ["signed", "waived"])
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

  const hasVisibleSignature = (endorsement: SignedEndorsementAsset) => {
    const method = (endorsement.signature_method ?? "").toLowerCase();
    if (method === "internal" || method === "manual") return false;
    return Boolean(endorsement.signature_image_url?.trim());
  };

  const visibleEndorsements = signedEndorsements.filter(hasVisibleSignature);
  const clientEndorsements = visibleEndorsements.filter((e) => !isFreedomOrCarletta(e.payee_name));
  const companyEndorsements = visibleEndorsements.filter((e) => isFreedomOrCarletta(e.payee_name));
  const visibleCompanyEndorsement = companyEndorsements[0];
  const canGenerate = signedEndorsements.length > 0;

  useEffect(() => {
    setOverride(initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE);
  }, [initialOverride]);

  // Shared zone constants — must match edge function exactly
  const ZONE_TOP_PCT = 0.15;
  const ZONE_BOTTOM_PCT = 0.92;
  const ENDORSEMENT_WIDTH_PCT = 0.22;

  // Use fitEndorsementLayout to match server compositor exactly
  const previewLayout = useMemo(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const containerWidthPx = rect?.width ?? 900;
    const containerHeightPx = rect?.height ?? (containerWidthPx * imageHeight / imageWidth);
    const safeZoneHeightPx = (ZONE_BOTTOM_PCT - ZONE_TOP_PCT) * containerHeightPx;
    return fitEndorsementLayout({
      signerCount: signedEndorsements.length || 1,
      zoneHeightPx: safeZoneHeightPx,
      requestedScale: override.scale || 1,
    });
  }, [imageWidth, imageHeight, override.scale, signedEndorsements.length]);

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

      const containerHeightPx = rect.height;
      const safeZoneTopPx = ZONE_TOP_PCT * containerHeightPx;
      const safeZoneBottomPx = ZONE_BOTTOM_PCT * containerHeightPx;
      const safeZoneHeightPx = safeZoneBottomPx - safeZoneTopPx;

      runNextFrame(() => {
        if (dragging) {
          const xPct = (e.clientX - rect.left) / rect.width;
          const yPxWithinZone = (e.clientY - rect.top) - safeZoneTopPx;
          const yPct = yPxWithinZone / safeZoneHeightPx;
          setOverride((prev) =>
            clampEndorsementOverride({ ...prev, xPct, yPct }),
          );
        }

        if (resizing) {
          const overlayLeft = rect.left + override.xPct * rect.width;
          const deltaX = e.clientX - overlayLeft;
          const baseWidth = rect.width * ENDORSEMENT_WIDTH_PCT;
          const nextScale = Math.max(0.4, Math.min(4, deltaX / baseWidth));
          setOverride((prev) =>
            clampEndorsementOverride({ ...prev, scale: nextScale }),
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
    setServerError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setServerError(null);

    try {
      await onSave(clampEndorsementOverride(override));
    } catch (err: any) {
      console.error("[EndorsementAdjuster] save error", err);

      let parsed: any = null;
      let rawMessage = err?.message || "Could not generate final deposit image.";

      try {
        if (typeof err?.context?.body === "string") {
          parsed = JSON.parse(err.context.body);
        } else if (err?.context?.body) {
          parsed = err.context.body;
        }
      } catch {
        parsed = null;
      }

      if (parsed?.error) {
        rawMessage = parsed.error;
      }

      if (parsed?.code === "ENDORSEMENT_ZONE_OVERFLOW" && parsed?.details) {
        const d = parsed.details;
        setServerError(
          `Endorsement block extends to y=${d.blockBottom} which exceeds the bank zone limit at y=${d.zoneBottom}. ` +
          `Layout: columns=${d.columns}, fontSize=${d.fontSize}, signatureHeight=${d.signatureHeight}, compactText=${d.compactText}.`
        );
      } else if (parsed?.code === "NO_SIGNED_ENDORSEMENTS") {
        setServerError("No valid signed endorsement assets were found for this check.");
      } else if (parsed?.code === "ENDORSEMENT_CHECK_MISMATCH") {
        setServerError("The loaded endorsement signatures do not belong to this check.");
      } else if (parsed?.code === "MISSING_SIGNATURE_ASSET") {
        setServerError(rawMessage);
      } else if (parsed?.code === "COMPOSITE_FAILURE") {
        setServerError(rawMessage);
      } else {
        setServerError(rawMessage);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleFitToSafeZone = () => {
    setOverride((prev) =>
      clampEndorsementOverride({
        ...prev,
        scale: Math.max(0.4, (prev.scale ?? 1) - 0.08),
        yPct: Math.min(prev.yPct, 0.62),
      }),
    );
    setServerError(null);
  };

  // Use actual rendered DOM rect for overlay positioning
  const domRect = wrapRef.current?.getBoundingClientRect();
  const containerWidthPx = domRect?.width ?? imageWidth;
  const containerHeightPx = domRect?.height ?? (imageWidth > 0 ? containerWidthPx * imageHeight / imageWidth : imageHeight);
  const displayScale = containerWidthPx / imageWidth;

  // Zone-relative positioning — must match edge function exactly
  const safeZoneTopPx = ZONE_TOP_PCT * containerHeightPx;
  const safeZoneBottomPx = ZONE_BOTTOM_PCT * containerHeightPx;
  const safeZoneHeightPx = safeZoneBottomPx - safeZoneTopPx;

  // Derive font/spacing values from fitted layout, scaled to display size
  // Server uses these pixel values at full image resolution; we scale to container
  const { fontSize, lineGap, rowGap, signatureHeight, compactText, columns } = previewLayout;
  const companyFontPx = Math.max(9, Math.round(fontSize * 1.2)) * displayScale;
  const byLineFontPx = fontSize * displayScale;
  const payToFontPx = fontSize * displayScale;
  const sectionGapPx = Math.max(3, Math.round(lineGap * 2)) * displayScale;
  const lineGapPx = lineGap * displayScale;
  const sigHeightPx = signatureHeight * displayScale;

  if (!canGenerate && !endorsementsLoading) {
    return (
      <div className="flex items-center gap-2 p-4 rounded-lg bg-destructive/10 text-destructive font-medium">
        <AlertCircle className="h-5 w-5 flex-shrink-0" />
        No signed endorsements found for this check. Cannot generate deposit image.
      </div>
    );
  }

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

      {/* Server error display */}
      {serverError && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {serverError}
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

        {/* Bank safe zone indicators — top and bottom */}
        <div
          className="absolute left-0 right-0 border-t-2 border-dashed border-green-500/40 pointer-events-none"
          style={{ top: safeZoneTopPx }}
        >
          <span className="absolute right-1 top-1 text-[10px] text-green-600/60 font-medium">
            Endorsement Zone Top
          </span>
        </div>
        <div
          className="absolute left-0 right-0 border-t-2 border-dashed border-destructive/40 pointer-events-none"
          style={{ top: safeZoneBottomPx }}
        >
          <span className="absolute right-1 -top-5 text-[10px] text-destructive/60 font-medium">
            Endorsement Zone Limit
          </span>
        </div>

        {/* Debug overlay */}
        <div className="absolute left-2 top-2 z-30 rounded bg-black/70 px-2 py-1 text-[10px] text-white pointer-events-none">
          xPct: {override.xPct.toFixed(3)} | yPct: {override.yPct.toFixed(3)} | rot: {override.rotationDeg} | scale: {override.scale?.toFixed(2)}
        </div>

        {/* draggable overlay – center-origin positioning, zone-relative Y */}
        <div
          onPointerDown={beginDrag}
          className="absolute select-none"
          style={{
            left: override.xPct * containerWidthPx,
            top: safeZoneTopPx + (override.yPct * safeZoneHeightPx),
            width: containerWidthPx * ENDORSEMENT_WIDTH_PCT * displayScale,
            transform: `translate(-50%, -50%) rotate(${override.rotationDeg || 0}deg)`,
            transformOrigin: "center center",
            color: "#111111",
            userSelect: "none",
            touchAction: "none",
            cursor: dragging ? "grabbing" : "grab",
            opacity: dragging ? 0.92 : 1,
            zIndex: 20,
          }}
        >
          {override.showPayToOrder && (
            compactText ? (
              <>
                <div style={{ fontSize: payToFontPx, fontWeight: 700, lineHeight: 1.1, marginBottom: lineGapPx, color: "#111111" }}>
                  Pay to Freedom Adjustment
                </div>
                <div style={{ fontSize: payToFontPx, fontWeight: 700, lineHeight: 1.1, marginBottom: lineGapPx, color: "#111111" }}>
                  Mobile Deposit Only
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: payToFontPx, fontWeight: 600, lineHeight: 1.1, marginBottom: lineGapPx, color: "#111111" }}>
                  Pay to the order of
                </div>
                <div style={{ fontSize: companyFontPx, fontWeight: 700, lineHeight: 1.05, marginBottom: lineGapPx, color: "#111111" }}>
                  {companyName}
                </div>
                <div style={{ fontSize: payToFontPx, fontWeight: 700, lineHeight: 1.1, marginBottom: sectionGapPx, color: "#111111" }}>
                  For Mobile Deposit Only
                </div>
              </>
            )
          )}

          {/* Client endorsement names from actual signed data */}
          {clientEndorsements.map((endorsement) => {
            const isInternalOnly = endorsement.signature_method === "internal" || endorsement.signature_method === "manual";
            return (
              <div key={endorsement.id}>
                <div style={{ fontSize: byLineFontPx, fontWeight: 700, lineHeight: 1.1, marginBottom: isInternalOnly ? rowGap * displayScale : lineGapPx, color: "#111111" }}>
                  {endorsement.payee_name}
                  {isInternalOnly && (
                    <span style={{ fontSize: byLineFontPx * 0.7, fontWeight: 400, marginLeft: 4 }}>(physical)</span>
                  )}
                </div>
                {/* Only render electronic signature for portal-signed endorsements */}
                {!isInternalOnly && (
                  endorsement.signature_image_url && !endorsement.signature_image_url.startsWith("typed:") ? (
                    <img
                      src={endorsement.signature_image_url}
                      alt={`${endorsement.payee_name} signature`}
                      style={{ height: sigHeightPx, marginBottom: rowGap * displayScale }}
                      className="object-contain"
                      draggable={false}
                    />
                  ) : (
                    <div style={{ fontSize: byLineFontPx, fontStyle: "italic", fontFamily: '"Brush Script MT", cursive', marginBottom: rowGap * displayScale, color: "#111111" }}>
                      {endorsement.signature_image_url?.startsWith("typed:")
                        ? endorsement.signature_image_url.slice(6)
                        : endorsement.payee_name}
                    </div>
                  )
                )}
              </div>
            );
          })}

          {visibleCompanyEndorsement && (
            <>
              <div style={{ fontSize: companyFontPx, fontWeight: 700, lineHeight: 1.05, marginBottom: lineGapPx, color: "#111111" }}>
                {companyName}
              </div>

              {visibleCompanyEndorsement.signature_image_url?.startsWith("typed:") ? (
                <div style={{ fontSize: byLineFontPx, fontStyle: "italic", fontFamily: '"Brush Script MT", cursive', color: "#111111" }}>
                  {companyName}
                </div>
              ) : (
                <img
                  src={visibleCompanyEndorsement.signature_image_url}
                  alt="Freedom Adjustment signature"
                  style={{ height: sigHeightPx }}
                  className="object-contain"
                  draggable={false}
                />
              )}
            </>
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

          <div className="space-y-1 max-w-[200px]">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Scale</p>
              <span className="text-xs font-medium text-foreground">{Math.round(override.scale * 100)}%</span>
            </div>
            <div className="overflow-hidden">
              <Slider
                min={0.4}
                max={4}
                step={0.05}
                value={[override.scale]}
                onValueChange={([v]) =>
                  setOverride((prev) =>
                    clampEndorsementOverride({ ...prev, scale: v }),
                  )
                }
              />
            </div>
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

          <div className="flex flex-wrap gap-2">
            {!override.showPayToOrder && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverride((prev) =>
                    clampEndorsementOverride({ ...prev, showPayToOrder: true }),
                  )
                }
                title="Show 'Pay to the Order of Freedom Adjustment' text"
              >
                Add Pay to Order Text
              </Button>
            )}
            {override.showPayToOrder && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverride((prev) =>
                    clampEndorsementOverride({ ...prev, showPayToOrder: false }),
                  )
                }
                title="Remove 'Pay to the Order of Freedom Adjustment' text"
              >
                Remove Pay to Order Text
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
            <Button variant="outline" size="sm" onClick={handleFitToSafeZone}>
              <ShieldCheck className="h-3 w-3 mr-1" />
              Fit to Safe Zone
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
