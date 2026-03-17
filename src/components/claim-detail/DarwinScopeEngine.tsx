import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";

type ScopeWarning = {
  type: "no_match" | "low_confidence" | "manual_review" | "code_upgrade" | "matching_issue";
  message: string;
  observationIndex?: number;
};

type DamageObservation = {
  category: "roof" | "siding" | "interior" | "window" | "gutter" | "fence" | "other";
  component: string;
  material: string;
  damageType: string;
  severity: "low" | "medium" | "high";
  repairability: "repair" | "replace" | "undetermined";
  quantityBasis: string;
  recommendedQuantity: number;
  unit: string;
  confidence: number;
  rationale: string;
};

type EstimateLineItem = {
  code: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  total: number;
  reasoning: string;
};

type AnalyzeResponse = {
  observations: DamageObservation[];
  estimateItems: EstimateLineItem[];
  summary: string;
  aiSummary?: string;
  warnings?: ScopeWarning[];
  assumptions?: string[];
  metrics?: {
    roofSquares: number;
    sidingSf: number;
    interiorSf: number;
    gutterLf: number;
    windowCount: number;
    grossTotal: number;
  };
  contextUsed?: Record<string, unknown>;
};

interface DarwinScopeEngineProps {
  claimId: string;
  claim: any;
}

export const DarwinScopeEngine = ({ claim }: DarwinScopeEngineProps) => {
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState("");

  const stateCode = useMemo(
    () => claim?.property_state || claim?.policyholder_state || "NJ",
    [claim?.property_state, claim?.policyholder_state]
  );

  async function handleFileChange(file: File | null) {
    if (!file) return;

    setFileName(file.name);
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      const { data, error: fnError } = await supabase.functions.invoke("darwin-scope-engine", {
        body: {
          imageBase64: base64,
          mimeType: file.type,
          state: stateCode,
          matchingRequired: true,
          ridgeVentPresent: true,
          dripEdgePresent: false,
          iceBarrierPresent: false,
          wasteFactor: 0.1,
        },
      });

      if (fnError) throw new Error(fnError.message || "Analyze failed");
      if (data?.error) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const grandTotal =
    result?.estimateItems?.reduce((sum, item) => sum + item.total, 0) ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Darwin Scope Engine</CardTitle>
        <CardDescription>
          Upload a damage photo to generate deterministic scope, warnings, and Xactimate-ready
          line items in Rebuttals &amp; Responses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>Scope API endpoint</AlertTitle>
          <AlertDescription>
            Using <code>{API_ENDPOINT}</code>. Configure{" "}
            <code>VITE_DARWIN_SCOPE_API_URL</code> if your analyze API is hosted elsewhere.
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
          />
          {fileName ? <p className="text-sm text-muted-foreground">Selected: {fileName}</p> : null}
          {loading ? <p className="text-sm text-muted-foreground">Analyzing...</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        {result && (
          <div className="space-y-4 text-sm">
            <div>
              <p>
                <strong>AI Summary:</strong> {result.aiSummary || "-"}
              </p>
              <p>
                <strong>Scope Summary:</strong> {result.summary}
              </p>
            </div>

            <div className="grid gap-1 md:grid-cols-2 lg:grid-cols-3">
              <div>Roof: {result.metrics?.roofSquares ?? 0} SQ</div>
              <div>Siding: {result.metrics?.sidingSf ?? 0} SF</div>
              <div>Interior: {result.metrics?.interiorSf ?? 0} SF</div>
              <div>Gutters: {result.metrics?.gutterLf ?? 0} LF</div>
              <div>Windows: {result.metrics?.windowCount ?? 0} EA</div>
              <div className="font-semibold">
                Gross: $
                {result.metrics?.grossTotal?.toFixed(2) ?? grandTotal.toFixed(2)}
              </div>
            </div>

            <div>
              <h4 className="font-semibold mb-1">Warnings</h4>
              {result.warnings?.length ? (
                <ul className="list-disc pl-5 space-y-1">
                  {result.warnings.map((w, i) => (
                    <li key={i}>
                      <strong>{w.type}</strong>: {w.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No warnings.</p>
              )}
            </div>

            <div>
              <h4 className="font-semibold mb-1">Assumptions</h4>
              {result.assumptions?.length ? (
                <ul className="list-disc pl-5 space-y-1">
                  {result.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No assumptions recorded.</p>
              )}
            </div>

            <div className="overflow-x-auto">
              <h4 className="font-semibold mb-1">Xactimate-Ready Scope</h4>
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Code</th>
                    <th className="text-left p-2">Description</th>
                    <th className="text-left p-2">Qty</th>
                    <th className="text-left p-2">Unit</th>
                    <th className="text-left p-2">Unit Price</th>
                    <th className="text-left p-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {result.estimateItems.map((item, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2">{item.code}</td>
                      <td className="p-2">{item.description}</td>
                      <td className="p-2">{item.quantity}</td>
                      <td className="p-2">{item.unit}</td>
                      <td className="p-2">${item.unitPrice.toFixed(2)}</td>
                      <td className="p-2">${item.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
