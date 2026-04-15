import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training' | 'strategy' | 'draft' | 'search_web' | 'search_argue';

export interface DraftFacts {
  claim_number: string;
  property_address: string;
  carrier: string;
  claim_status: string;
  loss_type: string;
  loss_date: string;
  last_contact_date: string;
  last_contact_with: string;
  last_contact_subject: string;
  latest_note: string;
  latest_update: string;
  next_action: string;
  pending_deadlines: string[];
  has_correspondence: boolean;
  has_notes: boolean;
}

export interface DraftData {
  type: 'sms' | 'email';
  facts: DraftFacts;
  draft: string;
  generated_at: string;
}

export interface AiMeta {
  model?: string;
  usedSearch?: boolean;
  cached?: boolean;
  sources?: Array<{ title: string; url: string }>;
  promptHash?: string;
  searchCount?: number;
}

export interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  draftData?: DraftData;
  meta?: AiMeta;
  isError?: boolean;
}

export function useDarwinCopilot(claimId: string) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<CopilotMode>('strategy');
  const abortRef = useRef<AbortController | null>(null);

  const askCopilot = useCallback(async (question?: string, overrideMode?: CopilotMode, extra?: { htmlContent?: string; attachedFileIds?: string[] }) => {
    const userContent = question || `Give me the full Darwin Copilot briefing for this claim in ${overrideMode || mode} mode.`;
    const userMsg: CopilotMessage = { role: 'user', content: userContent, timestamp: Date.now() };

    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    // Build conversation history for the API
    const conversationHistory = [...messages, userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }));

    try {
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error('No active session. Please sign in again.');

      const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/darwin-copilot`;
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          claimId,
          mode: overrideMode || mode,
          userQuestion: userContent,
          conversationHistory,
          ...(extra?.attachedFileIds?.length ? { attachedFileIds: extra.attachedFileIds } : {}),
        }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(errText || `Copilot error ${resp.status}`);
      }

      const data = await resp.json();

      if (!data.ok || (!data.response && !data.draftData)) {
        throw new Error(data.error || 'Empty response from Copilot');
      }

      const assistantMsg: CopilotMessage = {
        role: 'assistant',
        content: data.response || data.draftData?.draft || '',
        timestamp: Date.now(),
        draftData: data.draftData || undefined,
        meta: {
          model: data.model,
          usedSearch: data.usedSearch,
          cached: data.cached,
          sources: data.sources,
          promptHash: data.promptHash,
          searchCount: data.searchCount,
        },
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      console.error('[Darwin Copilot] Error details:', { error: err, claimId, mode: overrideMode || mode });

      // Map known backend errors to user-friendly messages
      const rawMsg = err.message || 'Unknown error';
      let friendlyMsg: string;
      if (/cannot access.*before initialization|initialization/i.test(rawMsg)) {
        friendlyMsg = 'Claim data is still loading. Please wait a moment and try again.';
      } else if (/could not load claim details for communication/i.test(rawMsg)) {
        friendlyMsg = 'Unable to load claim details. Please refresh the page or select a claim again.';
      } else if (/no active session/i.test(rawMsg)) {
        friendlyMsg = 'Your session has expired. Please sign in again.';
      } else {
        friendlyMsg = `Something went wrong. Please try again. (${rawMsg.length > 120 ? rawMsg.slice(0, 120) + '…' : rawMsg})`;
      }

      const errorMsg: CopilotMessage = { role: 'assistant', content: friendlyMsg, timestamp: Date.now(), isError: true };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }, [claimId, mode, messages]);

  const clearConversation = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
  }, []);

  return { messages, loading, mode, setMode, askCopilot, clearConversation, stopGeneration };
}
