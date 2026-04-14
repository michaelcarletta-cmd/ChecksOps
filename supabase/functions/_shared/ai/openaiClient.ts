/**
 * Centralized AI client — all calls go directly to OpenAI.
 * Supports text, vision (multimodal), and tool calling.
 */

const OPENAI_API_KEY = () => {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return key;
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

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

/**
 * Standard text-only chat completion via OpenAI directly.
 */
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

  const res = await fetch(OPENAI_URL, {
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

// ── Vision / Multimodal support ──────────────────────────────────────

export interface VisionMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface VisionChatOptions {
  model: string;
  messages: VisionMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface VisionResult {
  text: string;
  model: string;
}

/**
 * Vision/multimodal chat completion via OpenAI directly.
 */
export async function callVision(opts: VisionChatOptions): Promise<VisionResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4000,
  };

  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("OpenAI vision error:", JSON.stringify(data).slice(0, 500));
    if (res.status === 429) throw new Error("RATE_LIMIT");
    throw new Error(`OpenAI ${res.status}: ${data?.error?.message || "Unknown error"}`);
  }

  return {
    text: data.choices?.[0]?.message?.content || "",
    model: data.model || opts.model,
  };
}

// ── Tool calling support ─────────────────────────────────────────────

export interface ToolCallOptions {
  model: string;
  messages: VisionMessage[];
  tools: any[];
  toolChoice?: any;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolCallResult {
  text: string;
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
  model: string;
}

/**
 * Tool-calling chat completion via OpenAI directly.
 */
export async function callWithTools(opts: ToolCallOptions): Promise<ToolCallResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4000,
  };

  if (opts.toolChoice) {
    body.tool_choice = opts.toolChoice;
  }

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("OpenAI tool call error:", JSON.stringify(data).slice(0, 500));
    if (res.status === 429) throw new Error("RATE_LIMIT");
    throw new Error(`OpenAI ${res.status}: ${data?.error?.message || "Unknown error"}`);
  }

  const message = data.choices?.[0]?.message;
  return {
    text: message?.content || "",
    toolCalls: message?.tool_calls || [],
    model: data.model || opts.model,
  };
}
