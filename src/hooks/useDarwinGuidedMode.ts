import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface GuidedDraft {
  subject?: string;
  to?: string;
  body: string;
  recommendedAttachments?: string[];
  clientSendNote?: string;
}

export function useDarwinGuidedMode() {
  const [draft, setDraft] = useState<GuidedDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef<{ description: string; claimId?: string }>({ description: "" });

  const generateDraft = useCallback(async (description: string, claimId?: string) => {
    if (!description.trim()) {
      setError("Please describe the claim issue first.");
      return;
    }

    lastInputRef.current = { description, claimId };
    setLoading(true);
    setError(null);
    setDraft(null);

    try {
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error("No active session. Please sign in again.");

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/darwin-copilot`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            claimId: claimId || "general",
            mode: "draft",
            userQuestion: `GUIDED CLAIM MODE — Policyholder Voice Draft\n\nThe policyholder needs to communicate the following issue to the carrier. Write a professional, first-person email from the policyholder's perspective. Do NOT include any representation language, agent signatures, or implication that anyone other than the policyholder is writing.\n\nIssue description:\n${description}\n\nFormat the response as:\nSUBJECT: [email subject line]\nTO: [Insurance Carrier / Claims Department]\n---\n[email body in clean prose, first-person policyholder voice]\n---\nRECOMMENDED ATTACHMENTS: [list if applicable, or "None"]\nCLIENT SEND NOTE: [brief instruction for the policyholder about sending this]`,
          }),
          signal: abortRef.current.signal,
        }
      );

      if (!resp.ok) {
        if (resp.status === 429) throw new Error("Rate limited — please wait a moment and try again.");
        if (resp.status === 402) throw new Error("AI credits exhausted — please add funds in Settings.");
        const errText = await resp.text();
        throw new Error(errText || `Error ${resp.status}`);
      }

      const data = await resp.json();
      const raw = data.response || data.draftData?.draft || "";

      if (!raw) throw new Error("Empty response — please try again.");

      // Parse structured response
      const parsed = parseGuidedDraft(raw);
      setDraft(parsed);
    } catch (err: any) {
      if (err.name === "AbortError") return;
      const msg = err.message || "Something went wrong";
      setError(msg);
      toast.error(msg, { duration: 5000 });
    } finally {
      setLoading(false);
    }
  }, []);

  const regenerate = useCallback(() => {
    if (lastInputRef.current.description) {
      generateDraft(lastInputRef.current.description, lastInputRef.current.claimId);
    }
  }, [generateDraft]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setDraft(null);
    setError(null);
    setLoading(false);
  }, []);

  return { draft, loading, error, generateDraft, regenerate, clear };
}

function parseGuidedDraft(raw: string): GuidedDraft {
  let subject: string | undefined;
  let to: string | undefined;
  let body = raw;
  let recommendedAttachments: string[] | undefined;
  let clientSendNote: string | undefined;

  // Extract SUBJECT:
  const subjectMatch = raw.match(/^SUBJECT:\s*(.+)$/im);
  if (subjectMatch) subject = subjectMatch[1].trim();

  // Extract TO:
  const toMatch = raw.match(/^TO:\s*(.+)$/im);
  if (toMatch) to = toMatch[1].trim();

  // Extract body between --- markers
  const bodyParts = raw.split(/^---$/m);
  if (bodyParts.length >= 3) {
    body = bodyParts[1].trim();
  } else {
    // Fallback: strip known headers
    body = raw
      .replace(/^SUBJECT:\s*.+$/im, "")
      .replace(/^TO:\s*.+$/im, "")
      .replace(/^RECOMMENDED ATTACHMENTS:\s*.+$/im, "")
      .replace(/^CLIENT SEND NOTE:\s*.+$/im, "")
      .replace(/^---$/gm, "")
      .trim();
  }

  // Extract RECOMMENDED ATTACHMENTS:
  const attachMatch = raw.match(/RECOMMENDED ATTACHMENTS:\s*(.+?)(?:\n|$)/i);
  if (attachMatch && !/none/i.test(attachMatch[1])) {
    recommendedAttachments = attachMatch[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  }

  // Extract CLIENT SEND NOTE:
  const noteMatch = raw.match(/CLIENT SEND NOTE:\s*(.+?)$/ims);
  if (noteMatch) clientSendNote = noteMatch[1].trim();

  return { subject, to, body, recommendedAttachments, clientSendNote };
}
