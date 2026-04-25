import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Loader2, FileSignature, Check, AlertTriangle, Clock, Eye, Send } from "lucide-react";
import { resolveFieldDisplay, detectDocumentType } from "@/lib/signer-display-templates";

export default function Sign() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const { toast } = useToast();
  
  const [signer, setSigner] = useState<any>(null);
  const [request, setRequest] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const [errorStage, setErrorStage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [fields, setFields] = useState<any[]>([]);
  const [dbPresets, setDbPresets] = useState<any[]>([]);

  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const lastSignaturePointRefs = useRef<Record<string, { x: number; y: number; pressure: number } | null>>({});
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);
  const documentSectionRef = useRef<HTMLDivElement | null>(null);
  const [activeStep, setActiveStep] = useState<"review" | "sign">("review");
  const [drawingFields, setDrawingFields] = useState<Record<string, boolean>>({});
  const [eSignConsentAccepted, setESignConsentAccepted] = useState(false);

  const eSignConsentText = "I agree to use electronic records and electronic signatures for this document. I intend my electronic signature to be legally binding, and I understand I may decline to sign electronically and request another process.";

  // UI-only progress: count completed required fields
  const isCanvasDrawn = useCallback((fieldId: string) => {
    const canvas = canvasRefs.current[fieldId];
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 0) return true;
    }
    return false;
  }, []);

  const progressInfo = useMemo(() => {
    const requiredFields = fields.filter((f: any) => f.required !== false);
    const total = requiredFields.length;
    let completed = 0;
    for (const field of requiredFields) {
      if (field.type === "signature") {
        if (isCanvasDrawn(field.id)) completed++;
      } else if (field.type === "checkbox") {
        if (fieldValues[field.id]) completed++;
      } else {
        if (fieldValues[field.id] && String(fieldValues[field.id]).trim() !== "") completed++;
      }
    }
    return { completed, total, allDone: total > 0 && completed === total };
  }, [fields, fieldValues, drawingFields, isCanvasDrawn]);

  useEffect(() => {
    if (token) {
      fetchSignerData();
    } else {
      setError("No signing token provided");
      setLoading(false);
    }
  }, [token]);

  const fetchSignerData = async () => {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://yvagrvfkeuvzjezfsbun.supabase.co";
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2YWdydmZrZXV2emplemZzYnVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NzcyMjUsImV4cCI6MjA4NzQ1MzIyNX0.1Jgm-plSdEFFnPrtA492s0jH-GQcCN08WplZS_VrtEg";
      
      const response = await fetch(`${supabaseUrl}/functions/v1/get-signature-document`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": anonKey,
        },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();

      if (!response.ok || data?.ok === false) {
        setErrorStage(data?.stage || null);
        
        // Handle specific error stages
        if (data?.stage === "signer_order_blocked") {
          setError(data.error);
          setLoading(false);
          return;
        }
        if (data?.stage === "token_expired") {
          setError(data.error);
          setLoading(false);
          return;
        }
        throw new Error(data?.error || "Failed to load document");
      }

      if (!data?.signer || !data?.request) {
        throw new Error("Signature request not found or link has expired");
      }
      
      if (data.signer.status === "signed") {
        setSigned(true);
      }
      
      setSigner(data.signer);
      setRequest(data.request);
      setDocumentUrl(data.signedUrl);
      setDbPresets(data.presets || []);

      // Use normalized fields if available, fall back to field_data
      // Cross-reference field_data for display metadata
      const fieldDataMap = new Map<string, any>();
      (data.request.field_data || []).forEach((fd: any) => {
        fieldDataMap.set(fd.id, fd);
      });

      if (data.fields && data.fields.length > 0) {
        setFields(data.fields.map((f: any) => {
          const fdMeta = fieldDataMap.get(f.id) || {};
          return {
            id: f.id,
            type: f.field_type,
            label: f.label,
            required: f.required,
            page: f.page,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            placeholder: f.placeholder,
            checkboxLabel: f.checkbox_label,
            signerIndex: f.signer_index,
            display_label: fdMeta.display_label,
            display_help_text: fdMeta.display_help_text,
            display_section: fdMeta.display_section,
            display_order: fdMeta.display_order,
          };
        }));
      } else {
        // Backwards compat: use field_data from request
        const signerFields = (data.request.field_data || []).filter(
          (f: any) => f.signerIndex === data.signer.signing_order - 1
        );
        setFields(signerFields);
      }

    } catch (err: any) {
      console.error("Error fetching signer data:", err);
      setError(err.message || "Invalid or expired link");
      toast({
        title: "Invalid or expired link",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const getSignaturePoint = (canvas: HTMLCanvasElement, e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
      pressure: e.pressure && e.pressure > 0 ? e.pressure : 0.5,
    };
  };

  const startDrawing = (fieldId: string, e: React.PointerEvent<HTMLCanvasElement>) => {
    setDrawingFields(prev => ({ ...prev, [fieldId]: true }));
    const canvas = canvasRefs.current[fieldId];
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const point = getSignaturePoint(canvas, e);
    lastSignaturePointRefs.current[fieldId] = point;
    ctx.beginPath();
    ctx.strokeStyle = "#111111";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(point.x, point.y);
  };

  const draw = (fieldId: string, e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingFields[fieldId]) return;
    const canvas = canvasRefs.current[fieldId];
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const point = getSignaturePoint(canvas, e);
    const last = lastSignaturePointRefs.current[fieldId] ?? point;
    ctx.lineWidth = 1.2 + Math.max(point.pressure || last.pressure || 0.5, 0.25) * 3;
    ctx.quadraticCurveTo(last.x, last.y, (last.x + point.x) / 2, (last.y + point.y) / 2);
    ctx.stroke();
    lastSignaturePointRefs.current[fieldId] = point;
  };

  const stopDrawing = (fieldId: string) => {
    setDrawingFields(prev => ({ ...prev, [fieldId]: false }));
    lastSignaturePointRefs.current[fieldId] = null;
  };

  const clearSignature = (fieldId: string) => {
    const canvas = canvasRefs.current[fieldId];
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const handleSign = async () => {
    setValidationErrors([]);
    if (!eSignConsentAccepted) {
      setValidationErrors(["Electronic signature consent must be accepted before signing."]);
      toast({
        title: "Consent required",
        description: "Please accept the electronic signature consent before signing.",
        variant: "destructive",
      });
      return;
    }
    
    // Collect signature data and field values
    const collectedValues: Record<string, any> = {};
    for (const field of fields) {
      if (field.type === "signature") {
        const canvas = canvasRefs.current[field.id];
        if (canvas) {
          collectedValues[field.id] = canvas.toDataURL();
        }
      } else if (field.type === "checkbox") {
        collectedValues[field.id] = fieldValues[field.id] || false;
      } else {
        collectedValues[field.id] = fieldValues[field.id] || "";
      }
    }
    
    setSigning(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://yvagrvfkeuvzjezfsbun.supabase.co";
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2YWdydmZrZXV2emplemZzYnVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NzcyMjUsImV4cCI6MjA4NzQ1MzIyNX0.1Jgm-plSdEFFnPrtA492s0jH-GQcCN08WplZS_VrtEg";
      
      const response = await fetch(`${supabaseUrl}/functions/v1/submit-signature`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": anonKey,
        },
        body: JSON.stringify({ token, fieldValues: collectedValues, eSignConsentAccepted, consentText: eSignConsentText }),
      });

      const data = await response.json();

      if (!response.ok || data?.ok === false) {
        if (data?.validationErrors) {
          setValidationErrors(data.validationErrors);
          toast({
            title: "Required fields missing",
            description: data.validationErrors[0],
            variant: "destructive",
          });
          return;
        }
        if (data?.alreadySigned) {
          setSigned(true);
          return;
        }
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      setSigned(true);
      toast({ title: data.allSigned ? "All signatures completed!" : "Document signed successfully" });
    } catch (err: any) {
      toast({
        title: "Failed to sign",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setSigning(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  // Signer order blocked — show waiting message
  if (errorStage === "signer_order_blocked") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="w-6 h-6 text-amber-500" />
              <CardTitle>Waiting for Prior Signer</CardTitle>
            </div>
            <CardDescription>
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              You'll be able to sign once the previous signer(s) have completed. Please check back later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Token expired
  if (errorStage === "token_expired") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-6 h-6 text-destructive" />
              <CardTitle>Link Expired</CardTitle>
            </div>
            <CardDescription>
              {error}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (error || !signer || !request) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Invalid Link</CardTitle>
            <CardDescription>
              {error || "This signature link is invalid or has expired."}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (signed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Check className="w-6 h-6 text-green-600" />
              <CardTitle>Document Signed</CardTitle>
            </div>
            <CardDescription>
              Thank you! Your signature has been recorded.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }


  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Sticky Summary Bar */}
      <div className="sticky top-0 z-20 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-3xl mx-auto px-3 py-2 space-y-1.5">
          {/* Row 1: Doc name + signer */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <FileSignature className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="font-semibold text-gray-900 text-xs truncate">
                {request.document_name}
              </span>
            </div>
            <span className="text-[11px] text-gray-500 shrink-0">
              <span className="hidden sm:inline">Signing as </span>
              <span className="font-medium text-gray-700">{signer.signer_name}</span>
            </span>
          </div>

          {/* Row 2: Progress bar + actions */}
          {activeStep === "sign" && progressInfo.total > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <Progress
                  value={(progressInfo.completed / progressInfo.total) * 100}
                  className="h-1.5 flex-1 bg-gray-100"
                />
                <span className="text-[11px] font-medium text-gray-500 shrink-0 tabular-nums">
                  {progressInfo.completed}/{progressInfo.total}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setActiveStep("review");
                    documentSectionRef.current?.scrollIntoView({ behavior: "smooth" });
                  }}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-800 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50 transition-colors"
                >
                  <Eye className="w-3 h-3" />
                  <span className="hidden xs:inline">Doc</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (progressInfo.allDone) {
                      handleSign();
                    } else {
                      submitBtnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }
                  }}
                  className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded transition-colors ${
                    progressInfo.allDone
                      ? "bg-blue-600 text-white hover:bg-blue-700"
                      : "text-gray-500 border border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  <Send className="w-3 h-3" />
                  <span className="hidden xs:inline">Finish</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Step tabs */}
      <div className="bg-gray-50 border-b border-gray-200">
        <div className="max-w-3xl mx-auto flex">
          <button
            onClick={() => setActiveStep("review")}
            className={`flex-1 py-3 text-center text-sm font-medium transition-colors relative ${
              activeStep === "review"
                ? "text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold ${
                activeStep === "review" ? "bg-blue-600 text-white" : "bg-gray-300 text-white"
              }`}>1</span>
              Review Document
            </span>
            {activeStep === "review" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
            )}
          </button>
          <button
            onClick={() => setActiveStep("sign")}
            className={`flex-1 py-3 text-center text-sm font-medium transition-colors relative ${
              activeStep === "sign"
                ? "text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold ${
                activeStep === "sign" ? "bg-blue-600 text-white" : "bg-gray-300 text-white"
              }`}>2</span>
              Sign & Complete
            </span>
            {activeStep === "sign" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
            )}
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto">
        {/* Step 1: Review Document */}
        {activeStep === "review" && (
          <div ref={documentSectionRef} className="p-4 space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
              <p className="font-medium">Please review this document carefully before signing.</p>
              <p className="text-blue-600 text-xs mt-1">Scroll through the full document, then proceed to sign.</p>
            </div>

            {documentUrl && (
              <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white">
                <iframe
                  src={documentUrl}
                  className="w-full bg-white"
                  style={{ height: "70vh", minHeight: "400px" }}
                  title="Document Preview"
                />
              </div>
            )}

            <Button
              onClick={() => setActiveStep("sign")}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              size="lg"
            >
              I've Reviewed — Continue to Sign
            </Button>
          </div>
        )}

        {/* Step 2: Sign & Complete */}
        {activeStep === "sign" && (
          <div className="p-4 space-y-5">
            {validationErrors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-1">
                <div className="flex items-center gap-2 text-red-700 text-sm font-medium">
                  <AlertTriangle className="w-4 h-4" />
                  Please complete all required fields
                </div>
                {validationErrors.map((err, i) => (
                  <p key={i} className="text-sm text-red-600 ml-6">• {err}</p>
                ))}
              </div>
            )}

            {/* Context card */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
              <p className="text-sm font-semibold text-blue-900">{request.document_name}</p>
              {request.claim_number && (
                <p className="text-xs text-blue-700">Claim: {request.claim_number}</p>
              )}
              {request.policyholder_name && (
                <p className="text-xs text-blue-700">Policyholder: {request.policyholder_name}</p>
              )}
              <p className="text-xs text-blue-600 mt-1">
                The fields below apply to the document shown above. Please review the document before signing.
              </p>
            </div>

            {/* View Document Again button */}
            <button
              type="button"
              onClick={() => setActiveStep("review")}
              className="w-full flex items-center justify-center gap-2 text-sm text-blue-600 hover:text-blue-800 font-medium py-2 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
            >
              ↑ View Document Again
            </button>

            <div className="space-y-5">
              {(() => {
                // Use stored document_type, fall back to heuristic detection
                const detectedDocType = request.document_type || detectDocumentType(request.document_name || "");
                
                // Pre-compute type counts for template key resolution
                const typeCounters: Record<string, number> = {};
                const fieldsWithDisplay = fields.map((field: any) => {
                  const fieldType = field.type || "text";
                  typeCounters[fieldType] = (typeCounters[fieldType] || 0) + 1;
                  const indexAmongSameType = typeCounters[fieldType];
                  
                  const displayMeta = resolveFieldDisplay(field, detectedDocType, indexAmongSameType, dbPresets);
                  return { ...field, _displayMeta: displayMeta, _indexAmongType: indexAmongSameType };
                });

                // Group by section if display_section exists
                const sections = new Map<string, typeof fieldsWithDisplay>();
                fieldsWithDisplay.forEach(f => {
                  const section = f._displayMeta?.display_section || "__default__";
                  if (!sections.has(section)) sections.set(section, []);
                  sections.get(section)!.push(f);
                });

                // Sort within sections by display_order if available
                sections.forEach((sectionFields) => {
                  sectionFields.sort((a: any, b: any) => {
                    const orderA = a._displayMeta?.display_order ?? 999;
                    const orderB = b._displayMeta?.display_order ?? 999;
                    return orderA - orderB;
                  });
                });

                let globalIndex = 0;

                return Array.from(sections.entries()).map(([sectionName, sectionFields]) => (
                  <div key={sectionName} className="space-y-3">
                    {sectionName !== "__default__" && (
                      <div className="border-b border-gray-200 pb-1 pt-2">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{sectionName}</p>
                      </div>
                    )}
                    {sectionFields.map((field: any) => {
                      const currentIndex = globalIndex++;
                      const pageNum = field.page ?? 1;
                      const yPos = field.y;
                      let positionHint = "";
                      if (yPos != null) {
                        if (yPos < 33) positionHint = "upper section";
                        else if (yPos < 66) positionHint = "middle section";
                        else positionHint = "lower section";
                      }

                      const displayMeta = field._displayMeta;
                      
                      // Use display_label if available, otherwise fallback
                      let displayLabel = displayMeta?.display_label;
                      if (!displayLabel) {
                        const typeLabel = field.type === "signature" ? "Signature" 
                          : field.type === "checkbox" ? "Checkbox"
                          : field.type === "date" ? "Date"
                          : "Text";
                        const sameTypeOnPage = fields.filter(
                          (f: any) => f.type === field.type && (f.page ?? 1) === pageNum
                        );
                        if (!field.label || sameTypeOnPage.length > 1) {
                          const indexOnPage = sameTypeOnPage.indexOf(field) + 1;
                          displayLabel = sameTypeOnPage.length > 1
                            ? `${typeLabel} field ${indexOnPage} on page ${pageNum}`
                            : `${typeLabel} field on page ${pageNum}`;
                        } else {
                          displayLabel = field.label;
                        }
                      }

                      const helpText = displayMeta?.display_help_text;

                      return (
                <div key={field.id} className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">
                      {currentIndex + 1}
                    </span>
                    <Label className="text-sm font-semibold text-gray-900">
                      {displayLabel}
                      {field.required !== false && <span className="text-red-500 ml-1">*</span>}
                    </Label>
                  </div>
                  {helpText ? (
                    <p className="text-xs text-gray-500 mb-3 ml-8">
                      {helpText}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-400 mb-3 ml-8">
                      This field applies to page {pageNum} of the document above{positionHint ? ` — ${positionHint}` : ""}
                    </p>
                  )}

                  {field.type === "signature" ? (
                    <div className="space-y-2">
                      <p className="text-xs text-gray-500">
                        Use a stylus, finger, or mouse. A pressure-sensitive stylus will produce a more natural line.
                      </p>
                      <div className="border-2 border-dashed border-blue-300 rounded-lg p-1 bg-white">
                        <canvas
                          ref={(el) => (canvasRefs.current[field.id] = el)}
                          width={400}
                          height={150}
                          className="w-full rounded cursor-crosshair bg-white"
                          style={{ touchAction: "none" }}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            startDrawing(field.id, e);
                          }}
                          onPointerMove={(e) => {
                            e.preventDefault();
                            draw(field.id, e);
                          }}
                          onPointerUp={() => stopDrawing(field.id)}
                          onPointerCancel={() => stopDrawing(field.id)}
                          onPointerLeave={() => stopDrawing(field.id)}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => clearSignature(field.id)}
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                      >
                        ↺ Clear & Redo
                      </button>
                    </div>
                  ) : field.type === "checkbox" ? (
                    <div className="flex items-start space-x-2">
                      <Checkbox
                        id={field.id}
                        checked={!!fieldValues[field.id]}
                        onCheckedChange={(checked) =>
                          setFieldValues((prev) => ({ ...prev, [field.id]: checked }))
                        }
                        className="mt-0.5"
                      />
                      <label htmlFor={field.id} className="text-sm text-gray-700 cursor-pointer leading-snug">
                        {field.checkboxLabel || field.label || "I agree"}
                      </label>
                    </div>
                  ) : field.type === "date" ? (
                    <Input
                      type="date"
                      value={fieldValues[field.id] || ""}
                      onChange={(e) =>
                        setFieldValues((prev) => ({ ...prev, [field.id]: e.target.value }))
                      }
                      className="bg-white border-gray-300 text-gray-900"
                    />
                  ) : (
                    <Input
                      type="text"
                      value={fieldValues[field.id] || ""}
                      onChange={(e) =>
                        setFieldValues((prev) => ({ ...prev, [field.id]: e.target.value }))
                      }
                      placeholder={field.placeholder || "Enter text"}
                      className="bg-white border-gray-300 text-gray-900"
                    />
                  )}
                </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>

            <div className="pt-2 pb-6 space-y-3">
              <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed text-muted-foreground">
                <Checkbox
                  checked={eSignConsentAccepted}
                  onCheckedChange={(checked) => setESignConsentAccepted(checked === true)}
                  className="mt-0.5"
                />
                <span>{eSignConsentText}</span>
              </label>
              <Button
                ref={submitBtnRef}
                onClick={handleSign}
                disabled={signing}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                size="lg"
              >
                {signing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Submitting Signature...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4 mr-2" />
                    Complete Signature
                  </>
                )}
              </Button>
              <button
                type="button"
                onClick={() => setActiveStep("review")}
                className="w-full text-center text-sm text-gray-500 hover:text-gray-700"
              >
                ← Back to Document Review
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
