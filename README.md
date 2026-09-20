# Durable Research Agent

An AI research analyst built on Cloudflare. You give it a topic and a handful of
source URLs; it proposes a research plan, **pauses for your approval**, then runs
a durable multi-step pipeline that reads each source, summarizes it, synthesizes
a cited brief, and files the result into searchable long-term memory.

Everything runs on Cloudflare primitives. There is no third-party API key.

Built with AI assistance (Claude Code), as the assignment encourages. The prompt
history is in [PROMPTS.md](PROMPTS.md).

## Quick start

```bash
npm install          # if sharp fails to build: npm install --ignore-scripts
npx wrangler login   # opens a browser; Workers AI needs a Cloudflare account
npm run dev          # then open http://localhost:5173
```

First time on a Cloudflare account? Register a free `workers.dev` subdomain
before running `npm run dev` — see [Authenticate](#authenticate). Then follow
[Try it](#try-it) and the [testing checklist](#testing).

---

## Why this app

The assignment asks for four components. The goal here was to make each one
_load-bearing_ — something the app genuinely could not work without — rather than
bolted on to tick a box.

| Requirement                                        | How it is used                                                                                                                                                                              | Why it is not decorative                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM** — Llama 3.3 on Workers AI                  | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for chat, planning and synthesis; `@cf/meta/llama-3.1-8b-instruct-fast` for per-source summarization; `@cf/baai/bge-base-en-v1.5` for embeddings | Two chat models, deliberately split. The 70B model's 24k window covers input _and_ output, so raw pages cannot all fit in one call — see [Map-reduce](#why-map-reduce)        |
| **Workflow / coordination** — Cloudflare Workflows | Six-step research pipeline with per-step retries and a human-in-the-loop pause                                                                                                              | The run parks at `step.waitForEvent` for up to an hour holding no compute, and a Durable Object releases it later with `sendEvent`. A request/response chatbot cannot do this |
| **User input** — chat                              | React SPA on Workers Static Assets, over the Agents WebSocket                                                                                                                               | Live step tracker, plan approval card, and rendered brief all stream into the same session                                                                                    |
| **Memory / state** — three tiers                   | Conversation in Durable Object SQLite; run tracker in synced agent state; brief archive + embeddings in SQLite with semantic recall                                                         | `recallBriefs` makes memory _used_, not merely stored — the agent answers new questions from old briefs                                                                       |

---

## Architecture

```
Browser (React + Kumo, served by Workers Static Assets)
  │  WebSocket via useAgentChat / useAgent
  ▼
ResearchAgent ── Durable Object (AIChatAgent), one per session
  • conversation history        → DO SQLite (automatic)
  • live run tracker            → this.setState, synced to the browser
  • brief archive + embeddings  → DO SQLite (briefs, brief_chunks)
  • tools: startResearch, approveActivePlan, recallBriefs, listBriefs
  │
  ├─ env.RESEARCH_WORKFLOW.create({ params }) ───────────┐
  │                                                       ▼
  │                                      ResearchWorkflow (durable, retryable)
  │                                        1. plan subtopics       Llama 3.3 70B
  │                                        2. ⏸ waitForEvent "plan-approval"
  │  instance.sendEvent(...)  ◄─────────────  (parks; no compute held)
  │                                        3. fetch + extract      3x exp. backoff
  │                                        4. summarize each       Llama 3.1 8B
  │                                        5. synthesize brief     Llama 3.3 70B
  │                                        6. embed + persist      bge-base-en-v1.5
  │                                                       │
  └─ getAgentByName(...).onResearchEvent(evt) ◄──────────┘
       └─ setState → tracker updates in the UI
```

Both classes are exported from the same Worker script, so the Workflow reaches
the Durable Object over a binding rather than the network.

---

## Getting started

### Prerequisites

- Node.js 22+ (required by Wrangler 4)
- A Cloudflare account (free plan is sufficient)

### Install

```bash
npm install
```

> If the install fails building **sharp**, install with scripts disabled:
> `npm install --ignore-scripts`. Sharp is a transitive dependency of
> `miniflare`, and its postinstall check fails on newer Node versions. This
> application never touches it, and the prebuilt binary still installs
> correctly — only the postinstall verification step fails.

### Authenticate

```bash
npx wrangler login
```

**Then register a `workers.dev` subdomain**, once per account, at
**Workers & Pages → your account → Set up a subdomain** in the
[Cloudflare dashboard](https://dash.cloudflare.com/). It is free on the Workers
Free plan and takes about thirty seconds. Without it the dev server fails with:

```
You need to register a workers.dev subdomain before running the dev command in remote mode.
... /workers/subdomain/edge-preview failed  (code 10063)
```

**Both steps are required even though nothing is deployed.** Workers AI has no
local emulation, so the `AI` binding proxies inference to the real Cloudflare
network, and that proxy runs through an edge preview session — which needs the
subdomain to exist. Removing `"remote": true` does not avoid this; the binding
forces a remote connection either way.

Everything else — the Durable Object and its SQLite, the Workflow engine,
static assets — runs genuinely locally.

### Run

```bash
npm run dev
```

Open http://localhost:5173.

---

## Try it

Paste this into the chat:

```
Research how Cloudflare Workflows handles durable execution and retries.
Sources:
https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/
https://developers.cloudflare.com/workflows/build/events-and-parameters/
https://developers.cloudflare.com/workflows/reference/limits/
https://this-domain-does-not-exist-9f3a2b.com/article
```

The last URL is dead on purpose — watch it retry three times with exponential
backoff, fail, and _not_ take the brief down with it.

1. A plan card appears with 3–5 proposed questions. **The workflow is parked
   here.** Uncheck anything you do not want, then Approve.
2. The tracker shows each source being read and summarized.
3. The brief renders with `[Source N]` attributions and a source list.
4. Ask a follow-up question — the agent calls `recallBriefs` and answers from
   the stored brief rather than re-reading anything.

### Proving it is actually durable

While the run is in the summarize stage, kill the dev server with `Ctrl-C` and
start it again with `npm run dev`. The instance resumes from its last completed
step — already-fetched pages are not re-fetched, already-written summaries are
not regenerated. Workflow state lives in `.wrangler/state` and survives the
restart.

Inspect step history directly:

```bash
npx wrangler workflows instances describe research-workflow <INSTANCE_ID> --local
```

Or press `e` during `npm run dev` to open the Local Explorer at
`http://localhost:8787/cdn-cgi/local/explorer`, which shows per-step status,
attempt counts, and the parked `waitForEvent`.

---

## Testing

### Automated checks

```bash
npm run check    # formatting (oxfmt), lint (oxlint), typecheck (tsc)
npx vite build   # production build
```

These are the same steps the `Sanity Check` GitHub Action runs on every push,
alongside a Semgrep security scan.

### Manual checklist

Run `npm run dev` and work through these in the browser. Every tool call shows
up in the chat as a card with its input and output, so each result is visible.

| What                 | Do this                                                                                                 | Expect                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Chat                 | Say hello                                                                                               | A reply that streams in once, with no doubled words                                                       |
| Plan + approval gate | Paste the [Try it](#try-it) prompt                                                                      | A plan card with 3–5 checkbox questions; the tracker waits there                                          |
| Approval resumes it  | Untick one question, click **Approve**                                                                  | The tracker moves on to reading and summarizing each source                                               |
| Dead source          | Keep the dead URL from the Try it prompt                                                                | That source fails after its retries, and the brief still renders, listing it as **Failed**                |
| Cited brief          | Wait for the run to finish                                                                              | A markdown brief with `[Source N]` citations and a source list                                            |
| Memory recall        | Ask "What did the brief say about retries?"                                                             | A `recallBriefs` card with matching passages, and an answer drawn from them                               |
| Brief list           | Ask "What have you researched so far?"                                                                  | A `listBriefs` card listing the stored briefs                                                             |
| Cancel               | Start another run, then click **Cancel run** on the plan card                                           | The run is marked failed and no brief is written                                                          |
| URL guard (SSRF)     | Ask it to research `http://169.254.169.254/latest/meta-data/` and `http://localhost:8787/`              | The `startResearch` card lists both under `rejected` with a reason, and no run starts ("No usable URLs.") |
| Session isolation    | Open the app in a private window                                                                        | An empty chat; "What have you researched so far?" finds nothing from the other window                     |
| Durability           | Restart the dev server mid-run, as in [Proving it is actually durable](#proving-it-is-actually-durable) | The run resumes from its last completed step                                                              |

---

## Design notes

### Why map-reduce

`llama-3.3-70b-instruct-fp8-fast` has a **24,000 token budget covering input and
output together**. Four full web pages exceed that before the model writes a
word. So each source is reduced independently by the cheaper 8B model, and only
those summaries reach the 70B synthesis call.

This also isolates failure: one unreachable source costs one summary, not the
whole brief. And it keeps a run comfortably inside the free tier's daily neuron
allowance.

### Why the approval gate

It is the clearest demonstration that durable execution is real. The instance
suspends inside `step.waitForEvent` for up to an hour, holding no compute and
counting nothing against the concurrency limit, and is resumed later by a
completely separate request that lands on the Durable Object. Nothing about that
is expressible in a plain request/response handler.

A timeout on that gate throws and would fail the instance, so it is caught and
degrades to proceeding with the plan as proposed — an unattended run still
produces a brief rather than losing the work already checkpointed.

### Why SQLite for memory, not Vectorize

Vectorize has no local emulation. Using it would mean `remote: true` plus real
index provisioning, so the repository would no longer clone and run. Instead,
embeddings are stored as `Float32Array` BLOBs in the Durable Object's own
SQLite, beside the conversation they belong to, and cosine similarity is
computed in JS. Vectors are unit-normalized on write so scoring is a plain dot
product.

At demo corpus size this is exact and effectively instant. The seam is what
matters — see below.

### Swapping in Vectorize

`MemoryStore` in [`src/lib/memory.ts`](src/lib/memory.ts) has two
implementations. To switch:

```bash
npx wrangler vectorize create research-briefs --dimensions=768 --metric=cosine
```

```jsonc
// wrangler.jsonc
"vectorize": [
  { "binding": "VECTORIZE", "index_name": "research-briefs", "remote": true }
]
```

```ts
// src/agents/research-agent.ts — the only call site that changes
#memory(): MemoryStore {
  return new VectorizeStore(this.env.VECTORIZE);
}
```

No other code changes: the workflow, the tools, and the UI all talk to the
interface.

### The Workers AI streaming workaround

[`src/lib/workers-ai-stream-fix.ts`](src/lib/workers-ai-stream-fix.ts) exists
because of a bug in `workers-ai-provider` (through 4.0.0, which also requires
`ai@^7`, so upgrading is not a fix).

Workers AI streams every chunk in _both_ wire formats simultaneously — the
native `response` field and the OpenAI-compatible `choices[0].delta` — carrying
identical payloads. The provider maps them in two consecutive `if` blocks with
no `else`, so everything is emitted twice. For text that renders as
"YourYour input input is is". For tool calls it is worse: arguments stream as
incremental JSON fragments, so doubling produces
`{"topic": "{"topic": "CloudCloudflare...` — unparseable, leaving every tool
call with empty input.

The fix wraps the `AI` binding and drops the native copy whenever the
OpenAI-compatible side carries the same payload, so exactly one of the
provider's branches does the work. Chunks carrying only one format pass through
untouched, making it a no-op once the provider is fixed.

Two related details in the same area:

- The chat model sets an explicit `maxOutputTokens`. Workers AI's default
  completion budget is small enough to truncate a long tool call's arguments
  mid-JSON, which fails the same way.
- `runText` reads either `response` or `choices[0].message.content`, because
  the non-streaming shape is not stable: `response` is normally a string, but
  when a completion is itself valid JSON — exactly what the planning step asks
  for — Workers AI parses it and `response` arrives as an object.

None of this affects the Workflow's own inference, which calls the binding
directly rather than through the provider.

### Fetching untrusted URLs

The agent fetches URLs supplied by whoever is chatting with it, which is
SSRF-shaped by construction. [`src/lib/url-guard.ts`](src/lib/url-guard.ts)
rejects non-HTTP(S) schemes, embedded credentials, loopback, link-local
(`fe80::/10`) and unique-local addresses, RFC1918 and CGNAT ranges, cloud
metadata endpoints (`169.254.169.254`), multicast, and internal TLDs.

Two details matter more than the denylist itself:

- **Hosts are normalized before matching.** A trailing dot is the root-anchored
  form of the same name, so `localhost.` and `metadata.google.internal.`
  resolve identically to their bare forms and must not survive as distinct
  strings.
- **IPv6 is parsed numerically, not prefix-matched.** `URL` normalizes
  IPv4-mapped addresses to hex groups, and an IPv4 address can be embedded four
  different ways (`::ffff:0:0/96` mapped, `::ffff:0:0:0/96` translated,
  `::/96` compatible, `64:ff9b::/96` NAT64). The guard expands the literal to
  its eight groups and range-checks it.

**Redirects are followed manually.** `redirect: "follow"` would hand choice of
the final host to the remote server — one `302` to `169.254.169.254` and every
rule above is bypassed, with the response body flowing on into the brief. Each
hop is re-validated exactly as the user's original URL was, capped at 4 hops,
and the _final_ URL is what gets recorded as the source.

Responses are capped at 4 MB, non-HTML content types are refused, and extraction
is bounded to 12k characters.

**Stated limitation:** this validates the host in the URL. It does not defeat
DNS rebinding, because Workers resolve the name inside `fetch` and the resolved
address is never exposed to user code. A deployment that needs that guarantee
should egress through a proxy with an allowlist.

### Sessions and authentication

Each browser gets its own Durable Object, keyed by a random id in
`localStorage`. That is **isolation, not authentication** — it keeps one
visitor's conversation and brief archive separate from another's, but anyone who
can reach the deployment can create a session.

This is why the project is scoped to local development. Before deploying it
anywhere reachable, add a real check in
[`src/server.ts`](src/server.ts) ahead of `routeAgentRequest` — Cloudflare
Access, a signed cookie, or an equivalent — and derive the agent name from the
authenticated identity rather than from client-side storage.

Approval events are also ownership-checked: `approvePlan` verifies the
`instanceId` belongs to the calling session _before_ releasing the gate, and
the approved subtopics are intersected with what the model actually proposed, so
a crafted call cannot steer another session's run or inject text into its
prompts.

---

## Cost

Free tier throughout:

- **Workers AI** — 10,000 neurons/day, no card required. A four-source brief is
  well inside a day's allowance.
- **Workflows** — 100 concurrent instances, 1,024 steps per workflow.
- **Durable Objects with SQLite storage** — included.

The only account interaction during local development is proxied Workers AI
inference.

---

## Project structure

```
src/
  server.ts                      Worker entry: routeAgentRequest + class exports
  types.ts                       Contracts shared by Worker, DO, and Workflow
  agents/research-agent.ts       Durable Object: state, tools, RPC surface
  workflows/research-workflow.ts WorkflowEntrypoint: the six durable steps
  lib/
    models.ts                    Every model choice, in one place
    inference.ts                 Direct AI binding calls + embedding helpers
    prompts.ts                   Plan / summarize / synthesize prompts
    extract.ts                   HTMLRewriter → clean text
    chunk.ts                     Overlapping windows for embedding
    memory.ts                    MemoryStore + SQLite and Vectorize backends
    url-guard.ts                 SSRF validation for user-supplied URLs
  app.tsx                        Chat UI
  components/research-panel.tsx  Step tracker, approval card, brief card
```

---

## Limitations

- **No web search.** The agent reads URLs you give it. Adding search means an
  external API key, which would break the no-third-party-key property.
- **Text sources only.** PDFs and JavaScript-rendered pages are refused rather
  than mis-parsed. Cloudflare Browser Rendering would cover the latter.
- **Memory is per session.** Each Durable Object is one conversation. Briefs are
  recalled within a session, not across them — Vectorize would be the natural
  way to make the archive global.
- **One active run at a time** per session, by design; the tracker models a
  single active run.
- **No authentication.** See [Sessions and authentication](#sessions-and-authentication)
  — this is a local-development project and would need an auth check before
  being exposed.
