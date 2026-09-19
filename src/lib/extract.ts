import { MAX_SOURCE_CHARS } from "./models";
import { checkSourceUrl } from "./url-guard";
import type { FetchedSource } from "../types";

/**
 * Readable text is pulled with HTMLRewriter, which is built into the runtime —
 * no DOM parser dependency, and it streams rather than buffering the document.
 * Only prose-bearing selectors are collected, so script/style/nav content never
 * enters the result in the first place.
 */
const CONTENT_SELECTOR =
  "article p, article li, main p, main li, p, h1, h2, h3, h4, li, blockquote, dd, td, pre";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 4;

const REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
  "user-agent": "DurableResearchAgent/1.0 (+Cloudflare Workers)"
};

function tidy(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function failed(url: string, error: string): FetchedSource {
  return { url, status: "failed", title: url, text: "", chars: 0, error };
}

type GuardedFetch =
  | { ok: true; response: Response; finalUrl: string }
  | { ok: false; reason: string };

/**
 * Follow redirects manually, re-validating every hop.
 *
 * `redirect: "follow"` would hand control of the final host to the remote
 * server: one 302 to 169.254.169.254 and the guard is bypassed entirely, with
 * the response body flowing on into the brief. The destination of each hop is
 * therefore checked exactly as the user's original URL was.
 */
async function guardedFetch(startUrl: string): Promise<GuardedFetch> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = checkSourceUrl(current);
    if (!check.ok || !check.url) {
      const where = hop === 0 ? "" : ` after ${hop} redirect(s)`;
      return { ok: false, reason: `${check.reason ?? "rejected"}${where}` };
    }

    const resolved = check.url.toString();
    const response = await fetch(resolved, {
      headers: REQUEST_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (!isRedirect || !location) {
      return { ok: true, response, finalUrl: resolved };
    }

    try {
      current = new URL(location, resolved).toString();
    } catch {
      return { ok: false, reason: "redirect to a malformed URL" };
    }
  }

  return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects` };
}

/**
 * Fetch one URL and reduce it to plain text.
 *
 * Throws on transport or HTTP failure so the enclosing `step.do` sees a failed
 * attempt and applies its retry policy. A URL rejected by the guard, or one
 * that yields no prose, resolves as a `failed` source instead — retrying those
 * would only produce the same answer.
 */
export async function fetchAndExtract(rawUrl: string): Promise<FetchedSource> {
  const fetched = await guardedFetch(rawUrl);
  if (fetched.ok === false) return failed(rawUrl, fetched.reason);

  const { response, finalUrl: url } = fetched;

  if (!response.ok) {
    // Thrown, not returned: let the step's retry policy decide.
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BYTES) {
    return failed(url, `document too large (${declaredLength} bytes)`);
  }

  if (contentType.includes("text/plain")) {
    const body = tidy(await response.text());
    if (!body) return failed(url, "empty document");
    return {
      url,
      status: "ok",
      title: url,
      text: body.slice(0, MAX_SOURCE_CHARS),
      chars: body.length
    };
  }

  if (!contentType.includes("html") && !contentType.includes("xml")) {
    return failed(
      url,
      `unsupported content-type "${contentType || "unknown"}"`
    );
  }

  const parts: string[] = [];
  let title = "";
  let budget = MAX_SOURCE_CHARS * 3; // headroom before whitespace collapsing

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        title += chunk.text;
      }
    })
    .on(CONTENT_SELECTOR, {
      element() {
        parts.push("\n");
      },
      text(chunk) {
        if (budget <= 0 || !chunk.text) return;
        parts.push(chunk.text);
        budget -= chunk.text.length;
      }
    });

  // Drain into a null sink: the transformed bytes are irrelevant, the handler
  // side effects are the point, and this avoids buffering the whole document.
  await rewriter.transform(response).body?.pipeTo(new WritableStream());

  const text = tidy(parts.join(""));
  if (!text) return failed(url, "no readable text found");

  return {
    url,
    status: "ok",
    title: tidy(title) || url,
    text: text.slice(0, MAX_SOURCE_CHARS),
    chars: text.length
  };
}
