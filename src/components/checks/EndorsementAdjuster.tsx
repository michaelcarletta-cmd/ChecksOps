import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  RotateCcw,
  Save,
  AlertCircle,
  Wand2,
  Loader2,
  ImageDown,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  clampEndorsementOverride,
  DEFAULT_ENDORSEMENT_OVERRIDE,
  EndorsementOverride,
} from "@/lib/endorsementLayout";
import { fitEndorsementLayout } from "@/lib/endorsementFit";
import { supabase } from "@/integrations/supabase/client";
import {
  ENDORSEMENT_RENDERER_VERSION,
  ENDORSEMENT_WIDTH_PCT,
  ZONE_BOTTOM_PCT,
  ZONE_TOP_PCT,
  isAcceptedDepositMime,
  renderDepositImage,
  SignatureAsset,
} from "@/lib/endorsementDepositRender";
import { CHECK_IMAGES_BUCKET } from "@/lib/storageBuckets";
import { logAudit } from "@/hooks/useAuditLog";

interface SignedEndorsementAsset extends SignatureAsset {
  payee_type: string;
  status: string;
  signed_at: string | null;
  check_id: string;
}

type RenderStatus =
  | "idle"
  | "saving_position"
  | "position_saved"
  | "rendering"
  | "completed"
  | "failed";

export type EndorsementAdjusterProps = {
  checkId: string;
  /** Original (never-endorsed) back-of-check image URL. */
  originalImageUrl: string;
  /** Storage object path of the original back image (bucket-relative). */
  originalImagePath: string | null;
  imageWidth: number;
  imageHeight: number;
  companyName: string;
  initialOverride?: EndorsementOverride | null;
  /**
   * Called after the user approves the flattened deposit image.
   * Parent typically updates `back_image_path` to point at the new deposit
   * artifact so the existing CheckAlt submit flow picks it up unchanged.
   */
  onDepositImageApproved: (payload: {
    depositPath: string;
    override: EndorsementOverride;
    width: number;
    height: number;
    mimeType: string;
    bytes: number;
  }) => Promise<void> | void;
  /** Fires when the user has generated a deposit image but not yet approved it. */
  onUnapprovedDepositChange?: (hasUnapproved: boolean) => void;
  onClose?: () => void;
};

export function EndorsementAdjuster({
  checkId,
  originalImageUrl,
  originalImagePath,
  imageWidth,
  imageHeight,
  companyName,
  initialOverride,
  onDepositImageApproved,
  onUnapprovedDepositChange,
  onClose,
}: EndorsementAdjusterProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const overrideRef = useRef<EndorsementOverride>(
    initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE,
  );
  const dragOffsetRef = useRef<{ dxPct: number; dyPct: number } | null>(null);
  const savedOverrideRef = useRef<EndorsementOverride>(
    initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE,
  );

  const [override, setOverrideState] = useState<EndorsementOverride>(
    initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE,
  );
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [activePointerId, setActivePointerId] = useState<number | null>(null);
  const [status, setStatus] = useState<RenderStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [depositPreviewUrl, setDepositPreviewUrl] = useState<string | null>(null);
  const [depositResult, setDepositResult] = useState<{
    path: string;
    width: number;
    height: number;
    mimeType: string;
    bytes: number;
  } | null>(null);

  const [signedEndorsements, setSignedEndorsements] = useState<SignedEndorsementAsset[]>([]);
  const [endorsementsLoading, setEndorsementsLoading] = useState(true);
  const [endorsementsError, setEndorsementsError] = useState<string | null>(null);

  // Wrap setOverride so the ref stays in sync — pointer listener reads the ref,
  // not the closure, so drag stays smooth without re-registering listeners.
  const setOverride = useCallback(
    (updater: EndorsementOverride | ((prev: EndorsementOverride) => EndorsementOverride)) => {
      setOverrideState((prev) => {
        const next = typeof updater === "function"
          ? (updater as (p: EndorsementOverride) => EndorsementOverride)(prev)
          : updater;
        overrideRef.current = next;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!checkId) return;
    let cancelled = false;
    (async () => {
      setEndorsementsLoading(true);
      setEndorsementsError(null);
      try {
        const [endorsementsRes, payeesRes] = await Promise.all([
          supabase
            .from("check_endorsements")
            .select(
              "id, payee_name, payee_type, status, signed_at, signature_image_url, signature_method, check_id",
            )
            .eq("check_id", checkId)
            .in("status", ["signed", "waived"])
            .order("created_at", { ascending: true }),
          supabase
            .from("check_payees")
            .select(
              "id, payee_name, payee_type, endorsement_status, endorsed_at, endorsement_image_path",
            )
            .eq("check_id", checkId)
            .order("created_at", { ascending: true }),
        ]);
        if (endorsementsRes.error) throw endorsementsRes.error;
        if (payeesRes.error) throw payeesRes.error;

        const endorsementRows = ((endorsementsRes.data ?? []) as SignedEndorsementAsset[])
          .filter((row) => row.check_id === checkId);
        const payeeRows = payeesRes.data ?? [];

        const normName = (v?: string | null) => (v ?? "").trim().toLowerCase();
        const normType = (v?: string | null) => (v ?? "other").trim().toLowerCase();
        const isDataUrl = (v?: string | null) =>
          !!v && typeof v === "string" && v.startsWith("data:image/");

        // 1) Backfill signature_image_url from check_payees when the endorsement
        // row itself is missing an image but the linked payee has one (portal /
        // in-person captures sometimes only land on check_payees).
        const payeeByKey = new Map<string, any>();
        for (const p of payeeRows) {
          payeeByKey.set(`${normName(p.payee_name)}::${normType(p.payee_type)}`, p);
        }
        const enrichedEndorsements = endorsementRows.map((e) => {
          if (isDataUrl(e.signature_image_url)) return e;
          const p = payeeByKey.get(`${normName(e.payee_name)}::${normType(e.payee_type)}`)
            ?? payeeByKey.get(`${normName(e.payee_name)}::${normType(null)}`);
          if (p && isDataUrl(p.endorsement_image_path)) {
            return { ...e, signature_image_url: p.endorsement_image_path } as SignedEndorsementAsset;
          }
          return e;
        });

        // 2) Add signed payees that have no matching endorsement row at all
        // (in-person captures where check_endorsements never got seeded).
        const seenKeys = new Set(
          enrichedEndorsements.map((e) => `${normName(e.payee_name)}::${normType(e.payee_type)}`),
        );
        const synthesized: SignedEndorsementAsset[] = payeeRows
          .filter((p) => {
            const key = `${normName(p.payee_name)}::${normType(p.payee_type)}`;
            if (seenKeys.has(key)) return false;
            const status = (p.endorsement_status ?? "").toLowerCase();
            return (
              (status === "signed" || status === "waived" || !!p.endorsed_at) &&
              isDataUrl(p.endorsement_image_path)
            );
          })
          .map((p) => ({
            id: `payee-${p.id}`,
            check_id: checkId,
            payee_name: p.payee_name,
            payee_type: p.payee_type ?? "other",
            status: "signed",
            signed_at: p.endorsed_at,
            signature_image_url: p.endorsement_image_path,
            signature_method: "in_person",
          } as SignedEndorsementAsset));

        if (!cancelled) {
          setSignedEndorsements([...enrichedEndorsements, ...synthesized]);
        }
      } catch (e: any) {
        if (!cancelled) setEndorsementsError(e.message || "Failed to load endorsements");
      } finally {
        if (!cancelled) setEndorsementsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkId]);


  const isCompanyEndorsement = (name: string) => {
    const lc = name.toLowerCase();
    return (
      lc.includes("freedom") ||
      lc.includes("carletta") ||
      lc.includes(companyName.toLowerCase())
    );
  };

  const hasVisibleSignature = (e: SignedEndorsementAsset) => {
    const method = (e.signature_method ?? "").toLowerCase();
    if (method === "internal" || method === "manual") return false;
    return Boolean(e.signature_image_url?.trim());
  };

  const visibleEndorsements = signedEndorsements.filter(hasVisibleSignature);
  const clientEndorsements = visibleEndorsements.filter(
    (e) => !isCompanyEndorsement(e.payee_name),
  );
  const companyEndorsement = visibleEndorsements.find((e) =>
    isCompanyEndorsement(e.payee_name),
  ) ?? null;
  const canGenerate = visibleEndorsements.length > 0;

  useEffect(() => {
    const next = initialOverride ?? DEFAULT_ENDORSEMENT_OVERRIDE;
    setOverride(next);
    savedOverrideRef.current = next;
  }, [initialOverride, setOverride]);

  // Emit unapproved-deposit state so parents (dialog wrappers) can prompt
  // before closing when the user rendered but never approved an image.
  useEffect(() => {
    const hasUnapproved = status === "completed" && !!depositResult;
    onUnapprovedDepositChange?.(hasUnapproved);
  }, [status, depositResult, onUnapprovedDepositChange]);

  const renderableSignerCount = Math.max(1, visibleEndorsements.length);

  const previewLayout = useMemo(() => {
    const safeZoneHeightImgPx = (ZONE_BOTTOM_PCT - ZONE_TOP_PCT) * imageHeight;
    return fitEndorsementLayout({
      signerCount: renderableSignerCount,
      zoneHeightPx: safeZoneHeightImgPx,
      requestedScale: override.scale || 1,
    });
  }, [imageHeight, override.scale, renderableSignerCount]);

  // --- Smooth pointer-offset drag -------------------------------------------
  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (activePointerId !== null || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const containerHeightPx = rect.height;
    const safeZoneTopPx = ZONE_TOP_PCT * containerHeightPx;
    const safeZoneBottomPx = ZONE_BOTTOM_PCT * containerHeightPx;
    const safeZoneHeightPx = safeZoneBottomPx - safeZoneTopPx;

    // Pointer offset from block center, expressed in the same normalized
    // coordinate spaces as the override — so drag doesn't jump on grab.
    const currentCenterXPx = overrideRef.current.xPct * rect.width;
    const currentCenterYPx =
      safeZoneTopPx + overrideRef.current.yPct * safeZoneHeightPx;
    const pointerXPx = e.clientX - rect.left;
    const pointerYPx = e.clientY - rect.top;
    dragOffsetRef.current = {
      dxPct: (currentCenterXPx - pointerXPx) / rect.width,
      dyPct: (currentCenterYPx - pointerYPx) / safeZoneHeightPx,
    };

    (e.currentTarget as any).setPointerCapture?.(e.pointerId);
    setActivePointerId(e.pointerId);
    setDragging(true);
  };

  const beginResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (activePointerId !== null) return;
    (e.currentTarget as any).setPointerCapture?.(e.pointerId);
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

      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (dragging) {
          const offset = dragOffsetRef.current ?? { dxPct: 0, dyPct: 0 };
          const pointerXPct = (e.clientX - rect.left) / rect.width;
          const pointerYPct =
            (e.clientY - rect.top - safeZoneTopPx) / safeZoneHeightPx;
          setOverride((prev) =>
            clampEndorsementOverride({
              ...prev,
              xPct: pointerXPct + offset.dxPct,
              yPct: pointerYPct + offset.dyPct,
            }),
          );
        }
        if (resizing) {
          const overlayLeft =
            rect.left + overrideRef.current.xPct * rect.width;
          const deltaX = e.clientX - overlayLeft;
          const baseWidth = rect.width * ENDORSEMENT_WIDTH_PCT;
          const nextScale = Math.max(0.5, Math.min(2.5, deltaX / baseWidth));
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
      dragOffsetRef.current = null;
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
    // NB: intentionally does NOT depend on `override` — pointer listener reads
    // the ref, so we don't tear down/rebind listeners on every drag frame.
  }, [activePointerId, dragging, resizing, setOverride]);

  // --- Actions --------------------------------------------------------------
  const dirty =
    override.xPct !== savedOverrideRef.current.xPct ||
    override.yPct !== savedOverrideRef.current.yPct ||
    override.scale !== savedOverrideRef.current.scale ||
    override.rotationDeg !== savedOverrideRef.current.rotationDeg ||
    override.showPayToOrder !== savedOverrideRef.current.showPayToOrder;

  const handleSavePosition = async () => {
    setStatus("saving_position");
    setStatusMessage("Saving placement…");
    const clamped = clampEndorsementOverride(override);
    try {
      const { error } = await supabase
        .from("check_intake_items")
        .update({
          endorsement_override: clamped as any,
          endorsement_render_status: "position_saved",
          updated_at: new Date().toISOString(),
        })
        .eq("id", checkId);
      if (error) throw error;
      savedOverrideRef.current = clamped;
      setOverride(clamped);
      setStatus("position_saved");
      setStatusMessage("Step 1 of 3 complete — click Generate Deposit Image next.");
      await logAudit({
        action: "update",
        recordType: "check_intake_items",
        recordId: checkId,
        metadata: { event: "endorsement_position_saved", override: clamped },
      });
      toast.success("Position saved — click Generate Deposit Image next");
    } catch (err: any) {
      console.error("[EndorsementAdjuster] save position", err);
      setStatus("failed");
      setStatusMessage(err?.message || "Failed to save placement");
      toast.error(err?.message || "Failed to save placement");
    }
  };

  const handleGenerate = async () => {
    if (!originalImageUrl || !originalImagePath) {
      toast.error("Original back-of-check image is not available.");
      return;
    }
    setStatus("rendering");
    setStatusMessage("Generating deposit image…");
    setDepositPreviewUrl(null);
    setDepositResult(null);
    const requestId = `${checkId}-${Date.now()}`;
    try {
      // Re-mint a fresh signed URL for the original back image. The
      // originalImageUrl prop is a signed URL minted when the dialog opened
      // and can expire (1h TTL) before the user clicks Generate — the render
      // then fails with "Failed to load image". Always fetch a fresh URL
      // right before rendering.
      let freshOriginalUrl = originalImageUrl;
      try {
        const { data: signed } = await supabase.storage
          .from(CHECK_IMAGES_BUCKET)
          .createSignedUrl(originalImagePath, 600);
        if (signed?.signedUrl) freshOriginalUrl = signed.signedUrl;
      } catch (e) {
        console.warn("[EndorsementAdjuster] failed to re-mint signed URL, using existing", e);
      }

      const result = await renderDepositImage({
        originalImageUrl: freshOriginalUrl,
        override: savedOverrideRef.current,
        companyName,
        clientSignatures: clientEndorsements,
        companySignature: companyEndorsement,
      });
      if (!isAcceptedDepositMime(result.mimeType)) {
        throw new Error(
          `Renderer produced unsupported mime type ${result.mimeType} — refusing to save.`,
        );
      }

      // Derive a deposit path next to the original: <folder>/endorsed_v<n>.jpg
      const folder = originalImagePath.replace(/\/[^/]+$/, "");
      const version = (Date.now() % 1_000_000).toString(36);
      const depositPath = `${folder}/endorsed_deposit_${version}.jpg`;

      const { error: uploadErr } = await supabase.storage
        .from(CHECK_IMAGES_BUCKET)
        .upload(depositPath, result.blob, {
          contentType: result.mimeType,
          upsert: true,
          cacheControl: "3600",
        });
      if (uploadErr) throw uploadErr;

      const { error: updateErr } = await supabase
        .from("check_intake_items")
        .update({
          back_image_deposit_path: depositPath,
          endorsement_render_status: "completed",
          endorsement_render_meta: {
            request_id: requestId,
            renderer_version: ENDORSEMENT_RENDERER_VERSION,
            mime_type: result.mimeType,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            override: savedOverrideRef.current,
          } as any,
          updated_at: new Date().toISOString(),
        })
        .eq("id", checkId);
      if (updateErr) throw updateErr;

      // Local preview
      const previewUrl = URL.createObjectURL(result.blob);
      setDepositPreviewUrl(previewUrl);
      setDepositResult({
        path: depositPath,
        width: result.width,
        height: result.height,
        mimeType: result.mimeType,
        bytes: result.bytes,
      });
      setStatus("completed");
      setStatusMessage("Deposit image ready — review and approve below.");
      await logAudit({
        action: "create",
        recordType: "check_intake_items",
        recordId: checkId,
        metadata: {
          event: "endorsement_render_completed",
          deposit_path: depositPath,
          mime_type: result.mimeType,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          renderer_version: ENDORSEMENT_RENDERER_VERSION,
          request_id: requestId,
        },
      });
    } catch (err: any) {
      console.error("[EndorsementAdjuster] generate", err);
      // Placement stays saved — status flips back to position_saved for retry.
      setStatus("failed");
      setStatusMessage(err?.message || "Generation failed");
      await supabase
        .from("check_intake_items")
        .update({
          endorsement_render_status: "failed",
          endorsement_render_meta: { error: err?.message, request_id: requestId } as any,
        })
        .eq("id", checkId);
      await logAudit({
        action: "create",
        recordType: "check_intake_items",
        recordId: checkId,
        metadata: {
          event: "endorsement_render_failed",
          error: err?.message,
          request_id: requestId,
        },
      });
      toast.error(err?.message || "Failed to generate deposit image");
    }
  };

  const handleApprove = async () => {
    if (!depositResult) return;
    try {
      await onDepositImageApproved({
        depositPath: depositResult.path,
        override: savedOverrideRef.current,
        width: depositResult.width,
        height: depositResult.height,
        mimeType: depositResult.mimeType,
        bytes: depositResult.bytes,
      });
      await logAudit({
        action: "update",
        recordType: "check_intake_items",
        recordId: checkId,
        metadata: {
          event: "endorsement_render_approved",
          deposit_path: depositResult.path,
          renderer_version: ENDORSEMENT_RENDERER_VERSION,
        },
      });
      toast.success("Deposit image approved");
      if (depositPreviewUrl) URL.revokeObjectURL(depositPreviewUrl);
      // Do not call onClose here — the parent's onDepositImageApproved handler
      // is responsible for closing the adjuster after it clears the
      // "unapproved" flag. Calling onClose would trigger the parent's
      // close-guard confirm ("You generated a deposit image but haven't
      // approved it yet…") because the flag hasn't been flushed yet.
    } catch (err: any) {
      console.error("[EndorsementAdjuster] approve", err);
      toast.error(err?.message || "Failed to approve deposit image");
    }
  };

  const handleAdjustAgain = () => {
    if (depositPreviewUrl) URL.revokeObjectURL(depositPreviewUrl);
    setDepositPreviewUrl(null);
    setDepositResult(null);
    setStatus("position_saved");
    setStatusMessage(null);
  };

  const handleReset = () => {
    setOverride(DEFAULT_ENDORSEMENT_OVERRIDE);
    setStatus("idle");
    setStatusMessage(null);
  };

  const applyPreset = (xPct: number, yPct: number) =>
    setOverride((p) => clampEndorsementOverride({ ...p, xPct, yPct }));

  const applySizePreset = (scale: number) =>
    setOverride((p) => clampEndorsementOverride({ ...p, scale }));

  const handleAutoDetect = async () => {
    if (!originalImageUrl) return;
    setDetecting(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "detect-endorsement-zone",
        { body: { imageUrl: originalImageUrl } },
      );
      if (error) throw error;
      if (!data?.detected || !data?.suggested) {
        toast.error("Couldn't detect the endorsement box.");
        return;
      }
      const { xPct, yPct, scale } = data.suggested;
      setOverride((p) =>
        clampEndorsementOverride({ ...p, xPct, yPct, scale, rotationDeg: 0 }),
      );
      toast.success("Endorsement zone detected");
    } catch (err: any) {
      toast.error(err?.message || "Auto-detect failed");
    } finally {
      setDetecting(false);
    }
  };

  // --- Preview geometry -----------------------------------------------------
  const domRect = wrapRef.current?.getBoundingClientRect();
  const containerWidthPx = domRect?.width ?? imageWidth;
  const containerHeightPx =
    domRect?.height ??
    (imageWidth > 0 ? containerWidthPx * imageHeight / imageWidth : imageHeight);
  const displayScale = containerWidthPx / imageWidth;

  const safeZoneTopPx = ZONE_TOP_PCT * containerHeightPx;
  const safeZoneBottomPx = ZONE_BOTTOM_PCT * containerHeightPx;
  const safeZoneHeightPx = safeZoneBottomPx - safeZoneTopPx;

  const { fontSize, lineGap, rowGap, signatureHeight, columns, compactText } =
    previewLayout;
  const companyFontPx = Math.max(9, Math.round(fontSize * 1.2)) * displayScale;
  const byLineFontPx = fontSize * displayScale;
  const payToFontPx = fontSize * displayScale;
  const sectionGapPx = Math.max(3, Math.round(lineGap * 2)) * displayScale;
  const lineGapPx = lineGap * displayScale;
  const sigHeightPx = signatureHeight * displayScale;
  const effectiveBlockWidth = imageWidth * ENDORSEMENT_WIDTH_PCT;
  const effectiveClientColumnWidth =
    columns === 2 ? effectiveBlockWidth / 2 : effectiveBlockWidth;
  const clientSignatureWidthPx =
    Math.round(
      Math.min(
        effectiveClientColumnWidth - 20,
        Math.round(imageHeight * 0.1),
      ) * (override.scale || 1),
    ) * displayScale;
  const companySignatureWidthPx =
    Math.round(
      Math.min(effectiveBlockWidth - 20, Math.round(imageHeight * 0.1)) *
        (override.scale || 1),
    ) * displayScale;

  const clientRows: SignedEndorsementAsset[][] = [];
  for (let i = 0; i < clientEndorsements.length; i += columns) {
    clientRows.push(clientEndorsements.slice(i, i + columns));
  }

  const centerXPx = override.xPct * containerWidthPx;
  const centerYPx = safeZoneTopPx + override.yPct * safeZoneHeightPx;

  const statusColor =
    status === "failed"
      ? "text-red-700 bg-red-50 border-red-300"
      : status === "completed"
        ? "text-emerald-700 bg-emerald-50 border-emerald-300"
        : status === "position_saved"
          ? "text-blue-700 bg-blue-50 border-blue-300"
          : "text-muted-foreground bg-muted/40 border-border";

  if (!canGenerate && !endorsementsLoading) {
    return (
      <div className="flex items-center gap-2 p-4 rounded-lg bg-destructive/10 text-destructive font-medium">
        <AlertCircle className="h-5 w-5 flex-shrink-0" />
        No signed endorsements found for this check. Cannot generate deposit image.
      </div>
    );
  }

  // --- Approved deposit image preview view ---------------------------------
  if (status === "completed" && depositPreviewUrl && depositResult) {
    return (
      <div className="space-y-4">
        <StepBadge current={3} />
        <div className={`rounded-md border px-3 py-2 text-sm ${statusColor}`}>
          <CheckCircle2 className="inline h-4 w-4 mr-1" />
          Deposit image ready — {depositResult.width}×{depositResult.height},{" "}
          {(depositResult.bytes / 1024).toFixed(0)} KB {depositResult.mimeType}. Click{" "}
          <b>Approve Deposit Image</b> to save.
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1">Original</p>
            <img src={originalImageUrl} alt="Original back of check" className="w-full rounded border" />
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1">Final deposit JPEG</p>
            <img src={depositPreviewUrl} alt="Final deposit image" className="w-full rounded border" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleAdjustAgain}>
            <RotateCcw className="h-3 w-3 mr-1" />
            Adjust Again
          </Button>
          <Button onClick={handleApprove}>
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Approve Deposit Image
          </Button>
        </div>
      </div>
    );
  }

  const currentStep: 1 | 2 | 3 =
    status === "completed" ? 3 : status === "position_saved" || status === "rendering" ? 2 : 1;

  return (
    <div className="space-y-4">
      <StepBadge current={currentStep} />
      {endorsementsLoading ? (
        <div className="text-sm text-muted-foreground">Loading endorsement signatures…</div>
      ) : endorsementsError ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {endorsementsError}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Loaded signatures:{" "}
          {signedEndorsements.map((s) => s.payee_name).join(", ") || "none"}
        </div>
      )}

      {statusMessage && (
        <div className={`rounded-md border px-3 py-2 text-sm ${statusColor}`}>
          {status === "saving_position" || status === "rendering" ? (
            <Loader2 className="inline h-3 w-3 mr-1 animate-spin" />
          ) : status === "failed" ? (
            <AlertCircle className="inline h-3 w-3 mr-1" />
          ) : (
            <CheckCircle2 className="inline h-3 w-3 mr-1" />
          )}
          {statusMessage}
        </div>
      )}

      {dirty && status !== "saving_position" && status !== "rendering" && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Unsaved changes — click <b>Save Position</b> before generating the deposit image.
        </div>
      )}

      {/* Preview */}
      <div
        ref={wrapRef}
        className="relative mx-auto overflow-hidden rounded border bg-white"
        style={{ width: "100%", maxWidth: 900, touchAction: "none" }}
      >
        <img
          src={originalImageUrl}
          alt="Back of check"
          className="block h-auto w-full object-contain"
          draggable={false}
        />
        <div
          className="absolute left-0 right-0 border-t-2 border-dashed border-green-500/40 pointer-events-none"
          style={{ top: safeZoneTopPx }}
        />
        <div
          className="absolute left-0 right-0 border-t-2 border-dashed border-destructive/40 pointer-events-none"
          style={{ top: safeZoneBottomPx }}
        />

        <div
          onPointerDown={beginDrag}
          className="absolute"
          style={{
            left: centerXPx,
            top: centerYPx,
            width: containerWidthPx * ENDORSEMENT_WIDTH_PCT * (override.scale || 1),
            transform: `translate(-50%, -50%) rotate(${override.rotationDeg || 0}deg)`,
            transformOrigin: "center center",
            color: "#111111",
            userSelect: "none",
            touchAction: "none",
            cursor: dragging ? "grabbing" : "grab",
            opacity: dragging ? 0.92 : 1,
            zIndex: 20,
            textAlign: "center",
          }}
        >
          {override.showPayToOrder && (
            <>
              <div style={{ fontSize: payToFontPx, fontWeight: 600, marginBottom: lineGapPx }}>
                Pay to the order of
              </div>
              <div style={{ fontSize: companyFontPx, fontWeight: 700, marginBottom: lineGapPx }}>
                {companyName}
              </div>
              <div style={{ fontSize: payToFontPx, fontWeight: 700, marginBottom: sectionGapPx }}>
                For Mobile Deposit Only
              </div>
            </>
          )}

          {clientRows.map((row, rowIndex) => (
            <div
              key={`row-${rowIndex}`}
              className="flex w-full"
              style={{ gap: columns === 2 ? lineGapPx : 0 }}
            >
              {row.map((e) => (
                <div key={e.id} style={{ width: columns === 2 ? "50%" : "100%" }}>
                  <div style={{ fontSize: byLineFontPx, fontWeight: 700, marginBottom: lineGapPx }}>
                    {e.payee_name}
                  </div>
                  {e.signature_image_url && !e.signature_image_url.startsWith("typed:") ? (
                    <img
                      src={e.signature_image_url}
                      alt={`${e.payee_name} signature`}
                      style={{
                        height: sigHeightPx,
                        width: clientSignatureWidthPx,
                        margin: `0 auto ${rowGap * displayScale}px`,
                        objectFit: "contain",
                      }}
                      draggable={false}
                    />
                  ) : (
                    <div
                      style={{
                        fontSize: byLineFontPx,
                        fontStyle: "italic",
                        fontFamily: '"Brush Script MT", cursive',
                        marginBottom: rowGap * displayScale,
                      }}
                    >
                      {e.signature_image_url?.startsWith("typed:")
                        ? e.signature_image_url.slice(6)
                        : e.payee_name}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}

          {companyEndorsement && (
            <>
              <div style={{ fontSize: companyFontPx, fontWeight: 700, marginBottom: lineGapPx }}>
                {companyName}
              </div>
              {companyEndorsement.signature_image_url?.startsWith("typed:") ? (
                <div
                  style={{
                    fontSize: byLineFontPx,
                    fontStyle: "italic",
                    fontFamily: '"Brush Script MT", cursive',
                  }}
                >
                  {companyName}
                </div>
              ) : (
                <img
                  src={companyEndorsement.signature_image_url ?? undefined}
                  alt={`${companyName} signature`}
                  style={{
                    height: sigHeightPx,
                    width: companySignatureWidthPx,
                    margin: "0 auto",
                    objectFit: "contain",
                  }}
                  draggable={false}
                />
              )}
            </>
          )}

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
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">Easy Placement</p>
              <Button size="sm" onClick={handleAutoDetect} disabled={detecting || !originalImageUrl}>
                {detecting ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Wand2 className="h-3 w-3 mr-1" />
                )}
                {detecting ? "Detecting…" : "Auto-Detect Zone"}
              </Button>
            </div>

            <div>
              <p className="text-[10px] text-muted-foreground mb-1">Position</p>
              <div className="grid grid-cols-3 gap-1 max-w-[220px]">
                {[
                  { label: "↖", x: 0.22, y: 0.15 },
                  { label: "↑", x: 0.5, y: 0.15 },
                  { label: "↗", x: 0.78, y: 0.15 },
                  { label: "←", x: 0.22, y: 0.5 },
                  { label: "•", x: 0.5, y: 0.5 },
                  { label: "→", x: 0.78, y: 0.5 },
                  { label: "↙", x: 0.22, y: 0.85 },
                  { label: "↓", x: 0.5, y: 0.85 },
                  { label: "↘", x: 0.78, y: 0.85 },
                ].map((p) => (
                  <Button
                    key={p.label}
                    variant="outline"
                    size="sm"
                    className="h-8 text-base"
                    onClick={() => applyPreset(p.x, p.y)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[10px] text-muted-foreground mb-1">Size</p>
              <div className="flex flex-wrap gap-1">
                {[
                  { label: "S", scale: 0.7 },
                  { label: "M", scale: 1.0 },
                  { label: "L", scale: 1.3 },
                  { label: "XL", scale: 1.6 },
                ].map((s) => (
                  <Button
                    key={s.label}
                    variant={
                      Math.abs((override.scale ?? 1) - s.scale) < 0.05
                        ? "default"
                        : "outline"
                    }
                    size="sm"
                    className="h-7 px-3 text-xs"
                    onClick={() => applySizePreset(s.scale)}
                  >
                    {s.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* Orientation */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Orientation</p>
            <div className="flex flex-wrap gap-2">
              {[0, 90, 180, 270].map((deg) => (
                <Button
                  key={deg}
                  variant={override.rotationDeg === deg ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    setOverride((p) =>
                      clampEndorsementOverride({ ...p, rotationDeg: deg }),
                    )
                  }
                >
                  {deg}°
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverride((p) => clampEndorsementOverride({ ...p, rotationDeg: 0 }))
                }
              >
                Reset Rotation
              </Button>
            </div>
          </div>

          {/* Scale slider */}
          <div className="space-y-1 max-w-[240px]">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Scale</p>
              <span className="text-xs font-medium">{Math.round(override.scale * 100)}%</span>
            </div>
            <Slider
              min={0.5}
              max={2.5}
              step={0.05}
              value={[override.scale]}
              onValueChange={([v]) =>
                setOverride((p) => clampEndorsementOverride({ ...p, scale: v }))
              }
            />
          </div>

          {/* Pay to order toggle */}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOverride((p) =>
                  clampEndorsementOverride({
                    ...p,
                    showPayToOrder: !p.showPayToOrder,
                  }),
                )
              }
            >
              {override.showPayToOrder ? "Remove Pay to Order Text" : "Add Pay to Order Text"}
            </Button>
          </div>

          {/* Action bar */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSavePosition}
              disabled={
                status === "saving_position" || status === "rendering" || !canGenerate
              }
            >
              {status === "saving_position" ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Save className="h-3 w-3 mr-1" />
              )}
              Save Position
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={handleGenerate}
              disabled={
                dirty ||
                status === "rendering" ||
                status === "saving_position" ||
                !canGenerate ||
                !originalImageUrl
              }
              title={dirty ? "Save position first" : undefined}
            >
              {status === "rendering" ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <ImageDown className="h-3 w-3 mr-1" />
              )}
              Generate Deposit Image
            </Button>
            {status === "failed" && (
              <Button size="sm" variant="secondary" onClick={handleGenerate}>
                <RefreshCw className="h-3 w-3 mr-1" />
                Try Again
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepBadge({ current }: { current: 1 | 2 | 3 }) {
  const steps: Array<{ n: 1 | 2 | 3; label: string }> = [
    { n: 1, label: "Save Position" },
    { n: 2, label: "Generate Deposit Image" },
    { n: 3, label: "Approve" },
  ];
  return (
    <div className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
              current === s.n
                ? "border-primary bg-primary/10 text-primary font-medium"
                : current > s.n
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-border bg-muted/40 text-muted-foreground"
            }`}
          >
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-background text-[10px] font-bold">
              {current > s.n ? "✓" : s.n}
            </span>
            <span>{s.label}</span>
          </div>
          {i < steps.length - 1 && <span className="text-muted-foreground">→</span>}
        </div>
      ))}
    </div>
  );
}
