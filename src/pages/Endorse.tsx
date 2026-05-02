import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

interface EndorsementData {
  id: string;
  payee_name: string;
  status: string;
  carrier_name: string;
  check_number: string;
  amount: number | null;
  token: string;
  requires_payment_direction?: boolean;
}

export default function Endorse() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [data, setData] = useState<EndorsementData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Payment direction state
  const [paymentDirection, setPaymentDirection] = useState<"pay_contractor" | "pay_insured" | null>(null);
  const [contractorName, setContractorName] = useState("");
  const [eSignConsentAccepted, setESignConsentAccepted] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastPointRef = useRef<{ x: number; y: number; pressure: number } | null>(null);

  const endorsementConsentText = "I agree to use electronic records and electronic signatures for this endorsement. I confirm my identity as the named payee, intend my electronic signature to be legally binding, and authorize the electronic endorsement of this insurance check payment. I understand I may decline to sign electronically and request another process.";

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://nbcqwpysqgyxrrbgtmkw.supabase.co";
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw";
  const fnUrl = `${supabaseUrl}/functions/v1/check-endorsement`;

  useEffect(() => {
    if (!token) {
      setError("No endorsement token provided.");
      setLoading(false);
      return;
    }
    fetchData();
  }, [token]);

  const fetchData = async () => {
    try {
      const resp = await fetch(fnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey },
        body: JSON.stringify({ action: "get_endorsement_data", token }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "Failed to load endorsement");
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  // Canvas setup
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      const width = parent.clientWidth;
      const height = 140;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.strokeStyle = "#1e293b";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [data]);

  const getCtx = () => canvasRef.current?.getContext("2d") ?? null;

  const startDraw = (x: number, y: number, pressure = 0.5) => {
    drawingRef.current = true;
    lastPointRef.current = { x, y, pressure };
    const ctx = getCtx();
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const moveDraw = (x: number, y: number, pressure = 0.5) => {
    if (!drawingRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    const last = lastPointRef.current ?? { x, y, pressure };
    ctx.lineWidth = 1.35 + Math.max(pressure || last.pressure || 0.5, 0.25) * 2.6;
    ctx.quadraticCurveTo(last.x, last.y, (last.x + x) / 2, (last.y + y) / 2);
    ctx.stroke();
    lastPointRef.current = { x, y, pressure };
  };

  const endDraw = () => { drawingRef.current = false; lastPointRef.current = null; };

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pressure: event.pressure && event.pressure > 0 ? event.pressure : 0.5,
    };
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = getCtx();
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const getSignatureData = (): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let empty = true;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { empty = false; break; } }
    if (empty) return null;
    return canvas.toDataURL("image/png");
  };

  const submit = async (type: "approve" | "reject") => {
    if (type === "approve") {
      const sig = getSignatureData();
      if (!sig) {
        setMessage({ text: "Please provide your signature before endorsing.", type: "error" });
        return;
      }
      if (!eSignConsentAccepted) {
        setMessage({ text: "Please review and accept the electronic signature consent before endorsing.", type: "error" });
        return;
      }
      // Validate payment direction is selected if required
      if (data?.requires_payment_direction && !paymentDirection) {
        setMessage({ text: "Please select a payment direction before endorsing.", type: "error" });
        return;
      }
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const action = type === "approve" ? "submit_endorsement" : "reject_endorsement";
      const payload: Record<string, unknown> = { action, token };
      if (type === "approve") {
        payload.signatureData = getSignatureData();
        payload.eSignConsentAccepted = eSignConsentAccepted;
        payload.consentText = endorsementConsentText;
        if (paymentDirection) {
          payload.paymentDirection = paymentDirection;
          if (paymentDirection === "pay_contractor" && contractorName.trim()) {
            payload.contractorName = contractorName.trim();
          }
        }
      }
      if (type === "reject") payload.reason = "Payee declined";

      const resp = await fetch(fnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey },
        body: JSON.stringify(payload),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "Request failed");

      if (type === "approve") {
        // If another payee at this same address still needs to sign, hop directly to them.
        if (json.next_token) {
          const nextName = json.next_payee_name ? ` Now signing as ${json.next_payee_name}.` : "";
          setMessage({ text: `Signature recorded.${nextName}`, type: "success" });
          // Reset form state for the next signer
          setPaymentDirection(null);
          setContractorName("");
          setESignConsentAccepted(false);
          clearCanvas();
          // Hard navigate to refresh data cleanly
          window.location.assign(`/endorse?token=${json.next_token}`);
          return;
        }
        // Show the thank-you state directly without re-fetching (avoids "invalid link" error)
        setData((prev) => prev ? { ...prev, status: "signed" } : prev);
      } else {
        setData((prev) => prev ? { ...prev, status: "rejected" } : prev);
      }
    } catch (e: unknown) {
      setMessage({ text: `Error: ${e instanceof Error ? e.message : "Unknown error"}`, type: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const formatAmount = (amt: number | null) =>
    amt != null ? `$${amt.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "N/A";

  if (loading) {
    return (
      <div style={styles.body}>
        <div style={styles.card}>
          <p style={{ textAlign: "center", color: "#94a3b8" }}>Loading endorsement...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.body}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Endorsement Error</h1>
          <p style={{ color: "#ef4444", textAlign: "center", marginTop: 16 }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const alreadySigned = data.status === "signed" || data.status === "waived";
  const isRejected = data.status === "rejected";
  const isExpired = data.status === "expired";

  return (
    <div style={styles.body}>
      <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&display=swap" rel="stylesheet" />
      <div style={styles.card}>
        <h1 style={styles.h1}>Insurance Check Endorsement</h1>
        <p style={styles.sub}>You have been identified as a payee on the following check.</p>

        <div style={styles.detail}>
          <span style={styles.label}>Carrier</span>
          <span style={styles.value}>{data.carrier_name}</span>
        </div>
        <div style={styles.detail}>
          <span style={styles.label}>Check #</span>
          <span style={styles.value}>{data.check_number}</span>
        </div>
        <div style={styles.detail}>
          <span style={styles.label}>Your Name</span>
          <span style={styles.value}>{data.payee_name}</span>
        </div>
        <div style={styles.amount}>{formatAmount(data.amount)}</div>

        {alreadySigned && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>
              Thank You for Your Signature!
            </div>
            <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.6, maxWidth: 360, margin: "0 auto" }}>
              Your endorsement for this check has been received and recorded. No further action is needed from you.
            </p>
            <p style={{ color: "#64748b", fontSize: 12, marginTop: 16 }}>
              If you have questions about this check, please contact your adjuster.
            </p>
          </div>
        )}
        {isRejected && (
          <div style={{ ...styles.status, color: "#ef4444" }}>✗ You have rejected this endorsement.</div>
        )}
        {isExpired && (
          <div style={{ ...styles.status, color: "#94a3b8" }}>This endorsement link has expired.</div>
        )}

        {!alreadySigned && !isRejected && !isExpired && (
          <>
            <div style={styles.authText}>
              <strong>Authorization:</strong> I, <strong>{data.payee_name}</strong>, authorize the endorsement of the above check. I confirm my identity as the named payee and consent to use electronic records and signatures for this endorsement.
            </div>

            <div style={{ marginTop: 20 }}>
              <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8, fontWeight: 600 }}>Your Signature</p>
              <p style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>Use a stylus, finger, or mouse. A pressure-sensitive stylus will produce a more natural line.</p>
              <div style={styles.canvasWrap} ref={containerRef}>
                <canvas
                  ref={canvasRef}
                  height={120}
                  style={{ display: "block", width: "100%", borderRadius: 8, cursor: "crosshair", touchAction: "none" }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const p = getCanvasPoint(e);
                    startDraw(p.x, p.y, p.pressure);
                  }}
                  onPointerMove={(e) => {
                    e.preventDefault();
                    const p = getCanvasPoint(e);
                    moveDraw(p.x, p.y, p.pressure);
                  }}
                  onPointerUp={endDraw}
                  onPointerCancel={endDraw}
                  onPointerLeave={endDraw}
                />
                <button style={styles.clearBtn} onClick={clearCanvas}>Clear</button>
              </div>
            </div>

            <label style={styles.consentBox}>
              <input
                type="checkbox"
                checked={eSignConsentAccepted}
                onChange={(e) => setESignConsentAccepted(e.target.checked)}
                style={styles.consentCheckbox}
              />
              <span>{endorsementConsentText}</span>
            </label>

            {/* Payment Direction Section */}
            {data.requires_payment_direction && (
              <div style={styles.pdSection}>
                <div style={styles.pdHeader}>
                  <span style={styles.pdIcon}>💰</span>
                  <div>
                    <p style={styles.pdTitle}>Payment Direction <span style={styles.pdRequired}>Required</span></p>
                    <p style={styles.pdSubtitle}>How would you like the funds from this check handled?</p>
                  </div>
                </div>

                <div style={styles.pdOptions}>
                  <label
                    style={{
                      ...styles.pdOption,
                      ...(paymentDirection === "pay_contractor" ? styles.pdOptionSelected : {}),
                    }}
                  >
                    <input
                      type="radio"
                      name="payment_direction"
                      value="pay_contractor"
                      checked={paymentDirection === "pay_contractor"}
                      onChange={() => setPaymentDirection("pay_contractor")}
                      style={{ display: "none" }}
                    />
                    <div style={styles.pdRadio}>
                      {paymentDirection === "pay_contractor" && <div style={styles.pdRadioDot} />}
                    </div>
                    <div>
                      <p style={styles.pdOptionTitle}>Pay my contractor directly</p>
                      <p style={styles.pdOptionDesc}>Authorize payment to your contractor for work to begin</p>
                    </div>
                  </label>

                  <label
                    style={{
                      ...styles.pdOption,
                      ...(paymentDirection === "pay_insured" ? styles.pdOptionSelected : {}),
                    }}
                  >
                    <input
                      type="radio"
                      name="payment_direction"
                      value="pay_insured"
                      checked={paymentDirection === "pay_insured"}
                      onChange={() => setPaymentDirection("pay_insured")}
                      style={{ display: "none" }}
                    />
                    <div style={styles.pdRadio}>
                      {paymentDirection === "pay_insured" && <div style={styles.pdRadioDot} />}
                    </div>
                    <div>
                      <p style={styles.pdOptionTitle}>Send funds to me</p>
                      <p style={styles.pdOptionDesc}>Have the check funds issued directly to you</p>
                    </div>
                  </label>
                </div>

                {paymentDirection === "pay_contractor" && (
                  <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>Contractor name (optional)</p>
                    <input
                      type="text"
                      style={styles.contractorInput}
                      placeholder="Enter contractor name..."
                      value={contractorName}
                      onChange={(e) => setContractorName(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <div style={styles.actions}>
              <button
                style={{ ...styles.btn, ...styles.btnApprove, ...(submitting ? { opacity: 0.5 } : {}) }}
                disabled={submitting}
                onClick={() => submit("approve")}
              >Endorse Check</button>
              <button
                style={{ ...styles.btn, ...styles.btnReject, ...(submitting ? { opacity: 0.5 } : {}) }}
                disabled={submitting}
                onClick={() => submit("reject")}
              >Reject</button>
            </div>

            {message && (
              <p style={{ textAlign: "center", marginTop: 12, fontSize: 13, color: message.type === "success" ? "#22c55e" : "#ef4444" }}>
                {message.text}
              </p>
            )}

            <p style={styles.consent}>
              By selecting Endorse Check, your signature, consent language, timestamp, IP address, and device details are recorded with this endorsement.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    background: "#0f172a",
    color: "#e2e8f0",
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 12,
    maxWidth: 520,
    width: "100%",
    padding: 32,
  },
  h1: { fontSize: 20, marginBottom: 4 },
  sub: { color: "#94a3b8", fontSize: 14, marginBottom: 24 },
  detail: {
    display: "flex",
    justifyContent: "space-between",
    padding: "10px 0",
    borderBottom: "1px solid #334155",
    fontSize: 14,
  },
  label: { color: "#94a3b8" },
  value: { fontWeight: 600 },
  amount: { fontSize: 28, fontWeight: 700, textAlign: "center", padding: "20px 0", color: "#22c55e" },
  status: { textAlign: "center", padding: 24, fontSize: 18, fontWeight: 600 },
  authText: {
    fontSize: 13,
    color: "#94a3b8",
    marginBottom: 12,
    padding: 12,
    background: "#0f172a",
    borderRadius: 8,
    border: "1px solid #334155",
    lineHeight: 1.6,
  },
  sigTabs: { display: "flex", gap: 8, marginBottom: 12 },
  sigTab: {
    padding: "8px 16px",
    borderRadius: 6,
    border: "1px solid #334155",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  },
  sigTabActive: { background: "#334155", color: "#e2e8f0" },
  canvasWrap: {
    border: "2px dashed #334155",
    borderRadius: 8,
    position: "relative",
    background: "#0f172a",
    marginBottom: 8,
    overflow: "hidden",
    boxShadow: "inset 0 0 0 1px rgba(148,163,184,0.08)",
  },
  consentBox: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 1.5,
    cursor: "pointer",
  },
  consentCheckbox: {
    width: 16,
    height: 16,
    marginTop: 2,
    accentColor: "#22c55e",
    flexShrink: 0,
  },
  clearBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    background: "#334155",
    border: "none",
    color: "#94a3b8",
    padding: "4px 10px",
    borderRadius: 4,
    fontSize: 11,
    cursor: "pointer",
  },
  sigInput: {
    width: "100%",
    padding: 14,
    border: "2px solid #334155",
    borderRadius: 8,
    background: "#0f172a",
    color: "#e2e8f0",
    fontSize: 24,
    fontFamily: "'Dancing Script',cursive,'Brush Script MT',cursive",
    boxSizing: "border-box" as const,
  },
  typedPreview: {
    textAlign: "center",
    fontSize: 32,
    fontFamily: "'Dancing Script',cursive,'Brush Script MT',cursive",
    color: "#e2e8f0",
    padding: 20,
    border: "2px dashed #334155",
    borderRadius: 8,
    background: "#0f172a",
    minHeight: 80,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  actions: { display: "flex", gap: 12, marginTop: 20 },
  btn: {
    flex: 1,
    padding: 14,
    borderRadius: 8,
    border: "none",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnApprove: { background: "#22c55e", color: "#0f172a" },
  btnReject: { background: "#334155", color: "#e2e8f0" },
  consent: { fontSize: 11, color: "#64748b", marginTop: 16, textAlign: "center", lineHeight: 1.5 },

  // Payment Direction styles
  pdSection: {
    marginTop: 24,
    padding: 16,
    background: "#0f172a",
    borderRadius: 10,
    border: "1px solid #334155",
  },
  pdHeader: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 16,
  },
  pdIcon: { fontSize: 24 },
  pdTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#e2e8f0",
    margin: 0,
  },
  pdRequired: {
    fontSize: 10,
    fontWeight: 700,
    color: "#f59e0b",
    background: "#78350f",
    padding: "2px 6px",
    borderRadius: 4,
    marginLeft: 8,
    verticalAlign: "middle",
  },
  pdSubtitle: {
    fontSize: 12,
    color: "#94a3b8",
    margin: "4px 0 0",
  },
  pdOptions: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  pdOption: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "14px 16px",
    borderRadius: 8,
    border: "2px solid #334155",
    background: "#1e293b",
    cursor: "pointer",
    transition: "border-color 0.15s",
  },
  pdOptionSelected: {
    borderColor: "#22c55e",
    background: "#14532d20",
  },
  pdRadio: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    border: "2px solid #475569",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 2,
  },
  pdRadioDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#22c55e",
  },
  pdOptionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e2e8f0",
    margin: 0,
  },
  pdOptionDesc: {
    fontSize: 12,
    color: "#94a3b8",
    margin: "2px 0 0",
  },
  contractorInput: {
    width: "100%",
    padding: 10,
    border: "1px solid #334155",
    borderRadius: 6,
    background: "#1e293b",
    color: "#e2e8f0",
    fontSize: 14,
    boxSizing: "border-box" as const,
  },
};