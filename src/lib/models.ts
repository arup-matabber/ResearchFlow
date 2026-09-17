import { createWorkersAI } from "workers-ai-provider";
import { withStreamFix } from "./workers-ai-stream-fix";

/**
 * Every model choice in the application lives here.
 *
 * The split between `synthesis` and `summarize` is what makes the brief
 * possible: Llama 3.3 70B fp8-fast has a 24k token budget covering input *and*
 * output, so raw source pages cannot be concatenated into one call. Each source
 * is reduced by the cheap 8B model first, and only the summaries reach the 70B
 * synthesis call. It also keeps a run well inside the 10k neuron/day free tier.
 */
export const MODELS = {
  chat: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  plan: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  synthesis: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  summarize: "@cf/meta/llama-3.1-8b-instruct-fast",
  embedding: "@cf/baai/bge-base-en-v1.5"
} as const;

/** bge-base-en-v1.5 output width. */
export const EMBEDDING_DIMENSIONS = 768;

/** Characters of extracted source text handed to the summarizer. */
export const MAX_SOURCE_CHARS = 12_000;

export function workersAI(binding: Ai) {
  return createWorkersAI({ binding: withStreamFix(binding) });
}
