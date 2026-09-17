import { MODELS } from "./models";

/**
 * Direct Workers AI binding calls for the Workflow.
 *
 * The chat path uses the AI SDK because it needs streaming and tool calling;
 * the Workflow does not. Calling the binding directly keeps each step's result
 * a plain serializable value, which is what the durable checkpoint stores.
 */

type Messages = { role: "system" | "user" | "assistant"; content: string }[];

interface TextOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export async function runText(
  ai: Ai,
  model: string,
  { system, prompt, maxTokens = 1024, temperature = 0.3 }: TextOptions
): Promise<string> {
  const messages: Messages = [
    { role: "system", content: system },
    { role: "user", content: prompt }
  ];

  const result = await ai.run(
    model as never,
    {
      messages,
      max_tokens: maxTokens,
      temperature
    } as never
  );

  const text = extractCompletion(result).trim();
  if (!text) throw new Error(`empty completion from ${model}`);
  return text;
}

/**
 * Pull the completion text out of a Workers AI result.
 *
 * The shape is not stable across prompts: `response` is normally the string,
 * but when a completion is itself valid JSON, Workers AI parses it and
 * `response` arrives as an *object* while `choices[0].message.content` keeps
 * the verbatim string. The raw string is preferred when both are present, so
 * callers see exactly what the model emitted.
 */
function extractCompletion(result: unknown): string {
  const payload = result as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };

  const native = payload?.response;
  if (typeof native === "string") return native;

  const compatible = payload?.choices?.[0]?.message?.content;
  if (typeof compatible === "string") return compatible;

  if (native != null && typeof native === "object") {
    return JSON.stringify(native);
  }

  throw new Error("Workers AI returned no readable completion");
}

/**
 * Small models wrap JSON in prose or code fences often enough that parsing has
 * to be forgiving. Returns `null` rather than throwing so the caller decides
 * whether a malformed plan is fatal.
 */
export function parseJsonObject<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

/** Embed a batch of texts. Returns unit-normalized vectors. */
export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const result = (await ai.run(
    MODELS.embedding as never,
    {
      text: texts
    } as never
  )) as { data?: number[][] };

  const vectors = result?.data;
  if (!vectors || vectors.length !== texts.length) {
    throw new Error("embedding model returned an unexpected shape");
  }
  return vectors.map(normalize);
}

/**
 * Vectors are normalized once on the way in, so similarity at query time is a
 * plain dot product instead of a division per comparison.
 */
export function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

export function dot(a: number[], b: number[]): number {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) total += a[i] * b[i];
  return total;
}
