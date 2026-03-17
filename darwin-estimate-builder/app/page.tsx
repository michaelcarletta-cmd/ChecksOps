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
          mimeType: file.type
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Analyze failed");
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
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: 24,
        fontFamily: "Arial, sans-serif"
      }}
    >
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>AI Estimate Builder</h1>
      <p style={{ marginBottom: 24 }}>
        Upload a damage photo. AI will generate observations and estimate line
        items.
      </p>

      <div
        style={{
          border: "1px solid #ddd",
          padding: 20,
          borderRadius: 12,
          marginBottom: 24
        }}
      >
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
          <section
            style={{
              border: "1px solid #ddd",
              padding: 20,
              borderRadius: 12,
              marginBottom: 24
            }}
          >
            <h2 style={{ fontSize: 24, marginBottom: 12 }}>Summary</h2>
            <p>{result.summary}</p>
          </section>

          <section
            style={{
              border: "1px solid #ddd",
              padding: 20,
              borderRadius: 12,
              marginBottom: 24
            }}
          >
            <h2 style={{ fontSize: 24, marginBottom: 12 }}>Observations</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {result.observations.map((obs, i) => (
                <div
                  key={i}
                  style={{ border: "1px solid #eee", borderRadius: 10, padding: 14 }}
                >
                  <strong>{obs.component}</strong>
                  <div>Category: {obs.category}</div>
                  <div>Material: {obs.material}</div>
                  <div>Damage: {obs.damageType}</div>
                  <div>Severity: {obs.severity}</div>
                  <div>Repairability: {obs.repairability}</div>
                  <div>
                    Qty: {obs.recommendedQuantity} {obs.unit}
                  </div>
                  <div>Confidence: {obs.confidence}</div>
                  <div>Basis: {obs.quantityBasis}</div>
                  <div>Rationale: {obs.rationale}</div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ border: "1px solid #ddd", padding: 20, borderRadius: 12 }}>
            <h2 style={{ fontSize: 24, marginBottom: 12 }}>Estimate Line Items</h2>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Code</th>
                  <th style={th}>Description</th>
                  <th style={th}>Qty</th>
                  <th style={th}>Unit</th>
                  <th style={th}>Unit Price</th>
                  <th style={th}>Total</th>
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

const th: CSSProperties = {
  borderBottom: "1px solid #ddd",
  textAlign: "left",
  padding: "10px 8px"
};

const td: CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "10px 8px"
};
