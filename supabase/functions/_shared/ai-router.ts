export type DarwinTaskType =
  | "copilot_reasoning"
  | "copilot_drafting"
  | "autonomous_agent"
  | "client_update"
  | "war_room"
  | "rebuttal"
  | "demand_package"
  | "strategy_research_summary";

type OpenAITextOptions = {
  system: string;
  user: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
  maxOutputTokens?: number;
  jsonSchema?: Record<string, unknown>;
};

type PerplexityOptions = {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
};

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_REASONING_MODEL =
  Deno.env.get("OPENAI_REASONING_MODEL") || "gpt-5.4";
const OPENAI_FAST_MODEL =
  Deno.env.get("OPENAI_FAST_MODEL") || "gpt-5.4-mini";
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

function requireEnv(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

export function getModelForTask(task: DarwinTaskType) {
  switch (task) {
    case "copilot_reasoning":
    case "war_room":
    case "rebuttal":
    case "demand_package":
    case "strategy_research_summary":
      return {
        provider: "openai" as const,
        model: OPENAI_REASONING_MODEL,
        reasoningEffort: "high" as const,
        temperature: 0.2,
        maxOutputTokens: 3500,
      };
    case "copilot_drafting":
    case "autonomous_agent":
    case "client_update":
      return {
        provider: "openai" as const,
        model: OPENAI_FAST_MODEL,
        reasoningEffort: "medium" as const,
        temperature: 0.4,
        maxOutputTokens: 1800,
      };
    default:
      return {
        provider: "openai" as const,
        model: OPENAI_FAST_MODEL,
        reasoningEffort: "medium" as const,
        temperature: 0.3,
        maxOutputTokens: 1800,
      };
  }
}

export async function callOpenAIText(opts: OpenAITextOptions) {
  const apiKey = requireEnv("OPENAI_API_KEY", OPENAI_API_KEY);

  const body: Record<string, unknown> = {
    model: opts.model || OPENAI_REASONING_MODEL,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: opts.system }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: opts.user }],
      },
    ],
    reasoning: {
      effort: opts.reasoningEffort || "medium",
    },
    max_output_tokens: opts.maxOutputTokens || 2000,
  };

  if (typeof opts.temperature === "number") {
    body.temperature = opts.temperature;
  }

  if (opts.jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "darwin_response",
        schema: opts.jsonSchema,
        strict: true,
      },
    };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("OpenAI error:", data);
    throw new Error(
      `OpenAI request failed: ${res.status} ${JSON.stringify(data)}`,
    );
  }

  const text =
    data.output_text ||
    data.output?.flatMap((item: any) => item.content || [])
      ?.filter((c: any) => c.type === "output_text")
      ?.map((c: any) => c.text)
      ?.join("\n") ||
    "";

  return {
    raw: data,
    text,
    id: data.id,
    model: data.model,
  };
}

export async function callPerplexityResearch(opts: PerplexityOptions) {
  const apiKey = requireEnv("PERPLEXITY_API_KEY", PERPLEXITY_API_KEY);

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1800,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("Perplexity error:", data);
    throw new Error(
      `Perplexity request failed: ${res.status} ${JSON.stringify(data)}`,
    );
  }

  return {
    raw: data,
    text: data?.choices?.[0]?.message?.content || "",
    citations: data?.citations || [],
  };
}

export async function runDarwinTask(
  task: DarwinTaskType,
  system: string,
  user: string,
) {
  const config = getModelForTask(task);

  if (config.provider === "openai") {
    return await callOpenAIText({
      system,
      user,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
    });
  }

  throw new Error(`Unsupported provider for task ${task}`);
}
