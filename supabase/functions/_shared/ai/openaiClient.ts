/**
 * OpenAI API wrapper for chat completions.
 */

const OPENAI_API_KEY = () => {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return key;
};

export interface OpenAIChatOptions {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface OpenAIResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export async function callOpenAI(opts: OpenAIChatOptions): Promise<OpenAIResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 2000,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };

  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("OpenAI error:", JSON.stringify(data).slice(0, 500));
    throw new Error(`OpenAI ${res.status}: ${data?.error?.message || "Unknown error"}`);
  }

  return {
    text: data.choices?.[0]?.message?.content || "",
    model: data.model || opts.model,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}
