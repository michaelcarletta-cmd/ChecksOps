import { useState, useCallback, useRef } from "react";

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training' | 'strategy';

export interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export function useDarwinCopilot(claimId: string) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<CopilotMode>('strategy');
  const abortRef = useRef<AbortController | null>(null);

  const askCopilot = useCallback(async (question?: string, overrideMode?: CopilotMode) => {
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

      const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/darwin-copilot`;
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          claimId,
          mode: overrideMode || mode,
          userQuestion: userContent,
          conversationHistory,
        }),
        signal: abortRef.current.signal,
      });

      if (!resp.ok || !resp.body) {
        const errText = await resp.text();
        throw new Error(errText || `Copilot error ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      // Add empty assistant message
      const assistantMsg: CopilotMessage = { role: 'assistant', content: '', timestamp: Date.now() };
      setMessages(prev => [...prev, assistantMsg]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              accumulated += content;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { ...updated[updated.length - 1], content: accumulated };
                return updated;
              });
            }
          } catch { /* partial chunk */ }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      const errorMsg: CopilotMessage = { role: 'assistant', content: `Error: ${err.message}`, timestamp: Date.now() };
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
