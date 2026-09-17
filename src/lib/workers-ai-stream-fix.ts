/**
 * Workaround for double-emitted text in `workers-ai-provider` (through 4.0.0).
 *
 * Workers AI streams every content chunk in *both* wire formats at once — the
 * native `response` field and the OpenAI-compatible `choices[0].delta.content`
 * — carrying identical text:
 *
 *   data: {"response":"hello","choices":[{"delta":{"content":"hello"}}], ...}
 *
 * The provider maps them in two consecutive `if` blocks with no `else`
 * (`getMappedStream`), so each token is enqueued twice and the UI renders
 * "hellohello world world". It reproduces on Llama 3.3 and is invisible on
 * models that emit only one format, which is why the upstream starter template
 * never hit it.
 *
 * Tool calls duplicate the same way, and that failure is worse than cosmetic:
 * arguments stream as incremental JSON fragments, so doubling produces
 * `{"topic": "{"topic": "CloudCloudflare...` — unparseable, leaving the tool
 * call with empty input and the model retrying until it hits the step cap.
 *
 * The fix keeps exactly one copy of each payload by dropping the native field
 * whenever the OpenAI-compatible side carries the same thing, so precisely one
 * of the provider's two branches does the work. Reasoning, finish reasons and
 * usage are untouched, and a chunk carrying only one format passes through
 * unchanged — so this is a no-op once the provider is fixed or a model changes
 * its wire format.
 */

function deduplicateFrame(line: string): string {
  if (!line.startsWith("data:")) return line;

  const body = line.slice(5).trim();
  if (!body || body === "[DONE]") return line;

  try {
    const chunk = JSON.parse(body);
    const delta = chunk?.choices?.[0]?.delta;
    let rewritten = false;

    const compatibleText = delta?.content;
    if (
      typeof compatibleText === "string" &&
      compatibleText !== "" &&
      chunk.response != null
    ) {
      delete chunk.response;
      rewritten = true;
    }

    const compatibleCalls = delta?.tool_calls;
    if (
      Array.isArray(compatibleCalls) &&
      compatibleCalls.length > 0 &&
      Array.isArray(chunk.tool_calls) &&
      chunk.tool_calls.length > 0
    ) {
      delete chunk.tool_calls;
      rewritten = true;
    }

    if (rewritten) return `data: ${JSON.stringify(chunk)}`;
  } catch {
    // Not JSON we understand — forward it untouched.
  }
  return line;
}

/** SSE frames can split across reads, so lines are buffered before rewriting. */
function deduplicateTextStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${deduplicateFrame(line)}\n`));
      }
    },
    flush(controller) {
      if (pending) {
        controller.enqueue(encoder.encode(deduplicateFrame(pending)));
      }
    }
  });
}

/**
 * Wrap an Ai binding so streamed responses are de-duplicated on the way out.
 * Non-streaming calls are passed straight through.
 */
export function withStreamFix(binding: Ai): Ai {
  return new Proxy(binding, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "run" || typeof value !== "function") return value;

      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => unknown).apply(
          target,
          args
        );
        return result instanceof ReadableStream
          ? result.pipeThrough(deduplicateTextStream())
          : result;
      };
    }
  }) as Ai;
}
