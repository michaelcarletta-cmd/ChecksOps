import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2, FileSignature, Check, AlertTriangle } from "lucide-react";

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
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const [drawingFields, setDrawingFields] = useState<Record<string, boolean>>({});

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

  const startDrawing = (fieldId: string, e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    setDrawingFields(prev => ({ ...prev, [fieldId]: true }));
    const canvas = canvasRefs.current[fieldId];
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    
    let clientX: number, clientY: number;
    if ("touches" in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    
    ctx.beginPath();
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.moveTo(clientX - rect.left, clientY - rect.top);
  };

  const draw = (fieldId: string, e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!drawingFields[fieldId]) return;
    const canvas = canvasRefs.current[fieldId];
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    
    let clientX: number, clientY: number;
    if ("touches" in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    
    ctx.lineTo(clientX - rect.left, clientY - rect.top);
    ctx.stroke();
  };

  const stopDrawing = (fieldId: string) => {
    setDrawingFields(prev => ({ ...prev, [fieldId]: false }));
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
    
    // Get placed fields for this signer
    const fields = (request.field_data || []).filter(
      (f: any) => f.signerIndex === signer.signing_order - 1
    );

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
        body: JSON.stringify({ token, fieldValues: collectedValues }),
      });

      const data = await response.json();

      if (!response.ok || data?.ok === false) {
        // Handle validation errors specifically
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

  const signerFields = (request.field_data || []).filter(
    (field: any) => field.signerIndex === signer.signing_order - 1
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileSignature className="w-6 h-6" />
            <CardTitle>Sign Document</CardTitle>
          </div>
          <CardDescription>
            {request.document_name}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm">
              <span className="font-medium">Signer:</span> {signer.signer_name}
            </p>
            <p className="text-sm text-muted-foreground">
              Please review the document and complete all required fields below
            </p>
          </div>

          {documentUrl && (
            <div className="border rounded-lg overflow-hidden bg-muted">
              <iframe
                src={documentUrl}
                className="w-full h-96"
                title="Document Preview"
              />
            </div>
          )}

          {validationErrors.length > 0 && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 space-y-1">
              <div className="flex items-center gap-2 text-destructive text-sm font-medium">
                <AlertTriangle className="w-4 h-4" />
                Please complete all required fields
              </div>
              {validationErrors.map((err, i) => (
                <p key={i} className="text-sm text-destructive/80 ml-6">• {err}</p>
              ))}
            </div>
          )}

          <div className="space-y-4">
            <Label>Complete Required Fields</Label>
            {signerFields.map((field: any) => (
              <div key={field.id} className="space-y-2">
                <Label className="text-sm font-medium">
                  {field.label}
                  {field.required !== false && <span className="text-destructive ml-1">*</span>}
                </Label>
                {field.type === "signature" ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Draw your signature using your mouse or touchscreen
                    </p>
                    <div className="border-2 border-dashed rounded-lg p-2 bg-background">
                      <canvas
                        ref={(el) => (canvasRefs.current[field.id] = el)}
                        width={400}
                        height={120}
                        className="w-full border rounded cursor-crosshair bg-white"
                        style={{ touchAction: "none" }}
                        onMouseDown={(e) => startDrawing(field.id, e)}
                        onMouseMove={(e) => draw(field.id, e)}
                        onMouseUp={() => stopDrawing(field.id)}
                        onMouseLeave={() => stopDrawing(field.id)}
                        onTouchStart={(e) => { e.preventDefault(); startDrawing(field.id, e); }}
                        onTouchMove={(e) => { e.preventDefault(); draw(field.id, e); }}
                        onTouchEnd={() => stopDrawing(field.id)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => clearSignature(field.id)}
                    >
                      Clear Signature
                    </Button>
                  </div>
                ) : field.type === "checkbox" ? (
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={field.id}
                      checked={!!fieldValues[field.id]}
                      onCheckedChange={(checked) =>
                        setFieldValues((prev) => ({ ...prev, [field.id]: checked }))
                      }
                    />
                    <label htmlFor={field.id} className="text-sm text-muted-foreground cursor-pointer">
                      {field.checkboxLabel || "I agree"}
                    </label>
                  </div>
                ) : field.type === "date" ? (
                  <Input
                    type="date"
                    value={fieldValues[field.id] || ""}
                    onChange={(e) =>
                      setFieldValues((prev) => ({ ...prev, [field.id]: e.target.value }))
                    }
                    className="bg-background"
                  />
                ) : (
                  <Input
                    type="text"
                    value={fieldValues[field.id] || ""}
                    onChange={(e) =>
                      setFieldValues((prev) => ({ ...prev, [field.id]: e.target.value }))
                    }
                    placeholder={field.placeholder || "Enter text"}
                    className="bg-background"
                  />
                )}
              </div>
            ))}
          </div>

          <Button onClick={handleSign} disabled={signing} className="w-full">
            {signing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Signing...
              </>
            ) : (
              "Complete Signature"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
