/**
 * Centralized AI client — provider-aware.
 *
 * Routes calls to the cheapest viable provider based on the model name:
 *   - "google/*"          -> Lovable AI Gateway (Gemini family)
 *   - "openai/gpt-5*"     -> Lovable AI Gateway (GPT-5 family)
 *   - everything else     -> direct OpenAI (legacy gpt-4o, gpt-4o-mini, etc.)
 *
 * On 429 (rate limit) or 402 (out of credits) from the Lovable gateway,
 * falls back ONCE to direct OpenAI using a sensible equivalent model so
 * the claims pipeline never hard-stops.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const LOVABLE_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

type Provider = "openai" | "lovable";

function getOpenAIKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return key;
}

function getLovableKey(): string {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY is not configured");
  return key;
}

/** Decide provider based on the model identifier. */
function pickProvider(model: string): Provider {
  if (model.startsWith("google/")) return "lovable";
  if (model.startsWith("openai/gpt-5")) return "lovable";
  return "openai";
}

/**
 * Map a gateway model to a direct-OpenAI fallback model when the gateway
 * returns 402/429. Only used for openai/* models — Gemini calls fall back to
 * gpt-4o-mini / gpt-4o so the call still completes.
 */
function fallbackOpenAIModel(model: string): string {
  if (model.startsWith("openai/gpt-5") && model.includes("nano")) return "gpt-4o-mini";
  if (model.startsWith("openai/gpt-5") && model.includes("mini")) return "gpt-4o-mini";
  if (model.startsWith("openai/gpt-5")) return "gpt-4o";
  if (model.startsWith("google/") && (model.includes("pro") || model.includes("2.5-pro"))) return "gpt-4o";
  return "gpt-4o-mini";
}

/**
 * Pick the correct token-limit parameter name for the target model.
 * GPT-5 / o1 / o3 reasoning models reject `max_tokens` and require
 * `max_completion_tokens`. Gemini and legacy gpt-4o still accept `max_tokens`.
 */
function tokenLimitKey(model: string): "max_tokens" | "max_completion_tokens" {
  if (/^openai\/(gpt-5|o[13])/i.test(model)) return "max_completion_tokens";
  return "max_tokens";
}

/**
 * GPT-5 / o1 / o3 via the Lovable gateway only support the default
 * temperature behavior, so omit the parameter entirely for those models.
 */
function temperatureField(model: string, temperature?: number): Record<string, number> {
  if (/^openai\/(gpt-5|o[13])/i.test(model)) return {};
  return { temperature: temperature ?? 0.3 };
}

interface RequestConfig {
  url: string;
  headers: Record<string, string>;
  bodyModel: string; // model name to send in payload
}

function buildRequestConfig(model: string): RequestConfig {
  const provider = pickProvider(model);
  if (provider === "lovable") {
    return {
      url: LOVABLE_GATEWAY_URL,
      headers: {
        Authorization: `Bearer ${getLovableKey()}`,
        "Content-Type": "application/json",
      },
      bodyModel: model,
    };
  }
  return {
    url: OPENAI_URL,
    headers: {
      Authorization: `Bearer ${getOpenAIKey()}`,
      "Content-Type": "application/json",
    },
    bodyModel: model,
  };
}

/**
 * Execute a chat-completions POST. On 402/429 from the Lovable gateway,
 * retry once against direct OpenAI with an equivalent fallback model.
 */
async function executeChat(
  model: string,
  body: Record<string, unknown>,
  contextLabel: string,
): Promise<{ data: any; resolvedModel: string }> {
  const cfg = buildRequestConfig(model);
  const payload = { ...body, model: cfg.bodyModel };

  let res = await fetch(cfg.url, {
    method: "POST",
    headers: cfg.headers,
    body: JSON.stringify(payload),
  });

  // Auto-fallback: gateway out-of-credits or rate-limited -> hit OpenAI directly.
  // Only fall back when an OpenAI key is configured; otherwise surface the
  // original gateway error so callers see the real cause (and we don't mask it
  // with a misleading 401 from a stale OpenAI key).
  const isLovable = pickProvider(model) === "lovable";
  const openAIKey = Deno.env.get("OPENAI_API_KEY");
  if (isLovable && (res.status === 402 || res.status === 429) && openAIKey) {
    const fbModel = fallbackOpenAIModel(model);
    console.warn(
      `[aiClient] ${contextLabel}: Lovable gateway returned ${res.status} for ${model}. Falling back to OpenAI ${fbModel}.`,
    );
    try {
      // Legacy OpenAI endpoint (gpt-4o/gpt-4o-mini) uses `max_tokens`,
      // not `max_completion_tokens`. Rewrite the body for the fallback.
      const fbBody: Record<string, unknown> = { ...body, model: fbModel };
      if ("max_completion_tokens" in fbBody) {
        fbBody.max_tokens = fbBody.max_completion_tokens;
        delete fbBody.max_completion_tokens;
      }
      const fbRes = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAIKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fbBody),
      });
      const fbData = await fbRes.json();
      if (!fbRes.ok) {
        // If the fallback key is invalid/expired (401/403), don't mask the
        // gateway's original failure — re-raise the gateway condition instead.
        if (fbRes.status === 401 || fbRes.status === 403) {
          console.error(
            `[aiClient] ${contextLabel}: OpenAI fallback key rejected (${fbRes.status}). Re-raising original gateway ${res.status}.`,
          );
          if (res.status === 429) throw new Error("RATE_LIMIT");
          if (res.status === 402) throw new Error("AI_CREDITS_EXHAUSTED");
        }
        console.error(`[aiClient] ${contextLabel} fallback failed:`, JSON.stringify(fbData).slice(0, 500));
        if (fbRes.status === 429) throw new Error("RATE_LIMIT");
        throw new Error(`OpenAI fallback ${fbRes.status}: ${fbData?.error?.message || "Unknown error"}`);
      }
      return { data: fbData, resolvedModel: fbData.model || fbModel };
    } catch (err) {
      console.error(`[aiClient] ${contextLabel} fallback threw:`, err);
      throw err;
    }
  }

  const data = await res.json();
  if (!res.ok) {
    console.error(
      `[aiClient] ${contextLabel} error (${pickProvider(model)} ${model}):`,
      JSON.stringify(data).slice(0, 500),
    );
    if (res.status === 429) throw new Error("RATE_LIMIT");
    if (res.status === 402) throw new Error("AI_CREDITS_EXHAUSTED");
    throw new Error(`AI ${res.status}: ${data?.error?.message || "Unknown error"}`);
  }
  return { data, resolvedModel: data.model || model };
}

// ── Text-only chat ────────────────────────────────────────────────────

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
    ...temperatureField(opts.model, opts.temperature),
    [tokenLimitKey(opts.model)]: opts.maxTokens ?? 2000,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const { data, resolvedModel } = await executeChat(opts.model, body, "callOpenAI");
  return {
    text: data.choices?.[0]?.message?.content || "",
    model: resolvedModel,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ── Vision / Multimodal ──────────────────────────────────────────────

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
 * Vision/multimodal chat completion.
 * NOTE: Neither OpenAI nor Gemini accept application/pdf directly via the
 * vision schema — convert PDFs to text or images first.
 */
export async function callVision(opts: VisionChatOptions): Promise<VisionResult> {
  for (const msg of opts.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image_url" && part.image_url?.url?.startsWith("data:application/pdf")) {
          console.warn("[callVision] WARNING: application/pdf mime sent to vision API — will likely fail. Use extractPdfWithOcrFallback().");
        }
      }
    }
  }

  const body: Record<string, unknown> = {
    messages: opts.messages,
    ...temperatureField(opts.model, opts.temperature),
    [tokenLimitKey(opts.model)]: opts.maxTokens ?? 4000,
  };
  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const { data, resolvedModel } = await executeChat(opts.model, body, "callVision");
  return {
    text: data.choices?.[0]?.message?.content || "",
    model: resolvedModel,
  };
}

// ── Tool calling ─────────────────────────────────────────────────────

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

export async function callWithTools(opts: ToolCallOptions): Promise<ToolCallResult> {
  const body: Record<string, unknown> = {
    messages: opts.messages,
    tools: opts.tools,
    ...temperatureField(opts.model, opts.temperature),
    [tokenLimitKey(opts.model)]: opts.maxTokens ?? 4000,
  };
  if (opts.toolChoice) {
    body.tool_choice = opts.toolChoice;
  }

  const { data, resolvedModel } = await executeChat(opts.model, body, "callWithTools");
  const message = data.choices?.[0]?.message;
  return {
    text: message?.content || "",
    toolCalls: message?.tool_calls || [],
    model: resolvedModel,
  };
}
