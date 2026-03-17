"use client";

import { useState, type CSSProperties } from "react";
import { AnalyzeResponse } from "@/types";

export default function Page() {
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState("");

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

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: file.type,
          state: "NJ",
          matchingRequired: true,
          ridgeVentPresent: true,
          dripEdgePresent: false,
          iceBarrierPresent: false,
          wasteFactor: 0.1
        })
      });

      const rawText = await res.text();
      console.log("RAW API RESPONSE:", rawText);

      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(
          `Non-JSON response from server. Status ${res.status}. First 300 chars: ${rawText.slice(0, 300)}`
        );
      }

      if (!res.ok) {
        throw new Error(data?.error || `Analyze failed with status ${res.status}`);
      }

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
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24, fontFamily: "Arial, sans-serif" }}>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>Darwin Scope Engine</h1>
      <p style={{ marginBottom: 24 }}>
        Upload a damage photo. Darwin will analyze material and damage, build a deterministic scope,
        add dependency items, and flag likely code or matching issues.
      </p>

      <div style={card}>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
        />
        {fileName ? <p style={{ marginTop: 10 }}>Selected: {fileName}</p> : null}
        {loading ? <p style={{ marginTop: 10 }}>Analyzing...</p> : null}
        {error ? <p style={{ marginTop: 10, color: "red" }}>{error}</p> : null}
      </div>

      {result && (
        <>
          <section style={card}>
            <h2 style={h2}>Scope Summary</h2>
            <p>
              <strong>AI Summary:</strong> {result.aiSummary || "—"}
            </p>
            <p>
              <strong>Scope Summary:</strong> {result.summary}
            </p>
          </section>

          <section style={card}>
            <h2 style={h2}>Metrics</h2>
            <div>Roof: {result.metrics?.roofSquares ?? 0} SQ</div>
            <div>Siding: {result.metrics?.sidingSf ?? 0} SF</div>
            <div>Interior: {result.metrics?.interiorSf ?? 0} SF</div>
            <div>Gutters: {result.metrics?.gutterLf ?? 0} LF</div>
            <div>Windows: {result.metrics?.windowCount ?? 0} EA</div>
            <div>
              <strong>
                Gross Total: $
                {result.metrics?.grossTotal?.toFixed(2) ?? grandTotal.toFixed(2)}
              </strong>
            </div>
          </section>

          <section style={card}>
            <h2 style={h2}>Warnings</h2>
            {result.warnings?.length ? (
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>
                    <strong>{w.type}</strong>: {w.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No warnings.</p>
            )}
          </section>

          <section style={card}>
            <h2 style={h2}>Assumptions</h2>
            {result.assumptions?.length ? (
              <ul>
                {result.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            ) : (
              <p>No assumptions recorded.</p>
            )}
          </section>

          <section style={card}>
            <h2 style={h2}>Observations</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {result.observations.map((obs, i) => (
                <div key={i} style={subCard}>
                  <strong>{obs.component}</strong>
                  <div>Category: {obs.category}</div>
                  <div>Material: {obs.material}</div>
                  <div>Damage: {obs.damageType}</div>
                  <div>Severity: {obs.severity}</div>
                  <div>Repairability: {obs.repairability}</div>
                  <div>Qty: {obs.recommendedQuantity} {obs.unit}</div>
                  <div>Confidence: {obs.confidence}</div>
                  <div>Basis: {obs.quantityBasis}</div>
                  <div>Rationale: {obs.rationale}</div>
                </div>
              ))}
            </div>
          </section>

          <section style={card}>
            <h2 style={h2}>Xactimate-Ready Scope</h2>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Code</th>
                  <th style={th}>Description</th>
                  <th style={th}>Qty</th>
                  <th style={th}>Unit</th>
                  <th style={th}>Unit Price</th>
                  <th style={th}>Total</th>
                  <th style={th}>Reasoning</th>
                </tr>
              </thead>
              <tbody>
                {result.estimateItems.map((item, i) => (
                  <tr key={i}>
                    <td style={td}>{item.code}</td>
                    <td style={td}>{item.description}</td>
                    <td style={td}>{item.quantity}</td>
                    <td style={td}>{item.unit}</td>
                    <td style={td}>${item.unitPrice.toFixed(2)}</td>
                    <td style={td}>${item.total.toFixed(2)}</td>
                    <td style={td}>{item.reasoning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 style={{ marginTop: 18 }}>Grand Total: ${grandTotal.toFixed(2)}</h3>
          </section>
        </>
      )}
    </main>
  );
}

const h2: CSSProperties = {
  fontSize: 24,
  marginBottom: 12
};

const card: CSSProperties = {
  border: "1px solid #ddd",
  padding: 20,
  borderRadius: 12,
  marginBottom: 24
};

const subCard: CSSProperties = {
  border: "1px solid #eee",
  borderRadius: 10,
  padding: 14
};

const th: CSSProperties = {
  borderBottom: "1px solid #ddd",
  textAlign: "left",
  padding: "10px 8px",
  verticalAlign: "top"
};

const td: CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "10px 8px",
  verticalAlign: "top"
};
