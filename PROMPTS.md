# Prompt history

The assignment permits AI-assisted coding and requires the prompt history to be
submitted. This project was built in a single [Claude Code](https://claude.com/claude-code)
session (model: Claude Opus 5).

**About the wording.** The original session transcript was not kept. The initial
brief (§1) is verbatim, copied from the assignment. Every later instruction is
**reconstructed from memory** and marked _(reconstructed)_: the order and
substance are what happened, but the exact wording is approximate. The scoping
answers (§2) were selections from the assistant's questions, not free text.

---

## 1 — Initial brief

> In this workspace, create a new folder to work on a technical requirement
>
> Optional Assignment: Please share GitHub repo URL for the project here
> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.
>
> Scope out the requirements first. How can we achieve this. Use the internet to research about the project and the tool required to be used

**Response.** Researched the current Cloudflare stack from primary documentation
before proposing anything — Workers AI model IDs and context limits, the Agents
SDK, Workflows' `step.do` / `waitForEvent` / `sendEvent` APIs, Vectorize limits,
free-plan constraints, and the `cloudflare/agents-starter` template. Two findings
shaped the whole design:

1. **Workers AI has no local emulation.** The binding must be `remote: true`, so
   "local dev only" still requires `wrangler login`.
2. **Vectorize has no local emulation either.** Using it as the default memory
   store would break clone-and-run, so it was moved off the critical path behind
   a `MemoryStore` interface.

Then presented four scoping questions rather than assuming.

---

## 2 — Scoping decisions

Answers given to the scoping questions:

| Question            | Decision                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Application concept | **Durable Research Agent** — chat agent + multi-step Workflow with a human-in-the-loop approval pause, live progress, and semantic recall |
| Voice input         | **Chat only** — satisfies the requirement without depending on the Beta `@cloudflare/voice` package                                       |
| Deployment          | **Local dev only** — no deploy, no account provisioning beyond the login that Workers AI forces                                           |
| Repository          | **New self-contained folder**, pushed to its own standalone GitHub repo later                                                             |

The plan was written to a plan file for review.

---

## 3 — Approving the plan

> _(reconstructed)_ The plan looks good. Go ahead and build it.

**Response.** Carried out against the approved plan:

1. **Scaffold.** Shallow-cloned `cloudflare/agents-starter` (MIT) as the base —
   it already wires AI SDK v6, `AIChatAgent`, `useAgentChat`, and Workers AI with
   no third-party key. Stripped the demo surface: MCP server management, the
   weather/timezone/calculator tools, and the scheduling tools.
2. **Core modules.** `types.ts`, `lib/models.ts`, `lib/inference.ts`,
   `lib/prompts.ts`, `lib/extract.ts` (HTMLRewriter), `lib/chunk.ts`,
   `lib/memory.ts`, `lib/url-guard.ts`.
3. **Workflow.** Six durable steps with per-step retry policies and the
   `waitForEvent` approval gate.
4. **Agent.** Durable Object owning conversation, run tracker, and brief archive;
   RPC surface for the Workflow, callable surface for the browser.
5. **UI.** Rewired `app.tsx` to the new agent and added the step tracker, plan
   approval card, and brief card.
6. **Verification.** Typecheck, lint, format, production build, and a
   verification pass over the pure logic.

**A dependency failure that silently rolled back the install.** `npm install`
reported success while actually failing: `sharp` (a transitive dependency of
`miniflare`) could not run its postinstall check on Node 26 and npm rolled back
`node_modules` entirely. The exit code came from a pipe, not from npm. Diagnosed
by confirming the prebuilt `@img/sharp-darwin-arm64` binary installs correctly on
its own — only the postinstall verification fails — and resolved with
`npm install --ignore-scripts`, now documented in the README.

---

## 4 — Security review

No new instruction: a standing instruction requires a security review over the
branch diff before work is called done. It was run against the completed code and
found three exploitable bugs in the first draft, each confirmed independently
before being fixed:

1. **SSRF via trailing-dot hostnames.** `localhost.` and
   `metadata.google.internal.` bypassed the denylist entirely — DNS treats the
   trailing dot as the same name, but `"localhost."` is not `"localhost"` and
   `"db.internal."` does not `endsWith(".internal")`. Fixed by normalizing the
   host before matching.
2. **SSRF via redirects.** The fetch used `redirect: "follow"`, so the guard
   validated only the URL the user typed. One `302` from an attacker-controlled
   page to `169.254.169.254` reached the cloud metadata endpoint and piped the
   response into the brief — and the UI would still have displayed the benign
   pre-redirect URL as the source. Fixed with manual redirects, re-validating
   every hop, capped at 4, recording the final URL.
3. **Missing ownership check on a client-callable RPC.** `approvePlan` passed a
   browser-supplied `instanceId` straight to `RESEARCH_WORKFLOW.get(...).sendEvent()`.
   The workflow binding is account-scoped, so any caller could release another
   session's approval gate and inject arbitrary text into its research prompts.
   Fixed by checking ownership _before_ sending, and intersecting the approved
   subtopics with what the model actually proposed.

Also fixed: IPv6 coverage gaps (`fe80::/10` was matched as `fe80::/16`;
IPv4-translated, IPv4-compatible and NAT64 embeddings were unhandled), now
resolved by parsing the literal into its eight groups and range-checking
numerically instead of prefix-matching strings. Sessions were given per-browser
Durable Object names rather than all visitors sharing one `"default"` object.

An earlier bug was caught the same way, before the review: the guard failed to
reject `http://[::ffff:127.0.0.1]/` because `URL` normalizes IPv4-mapped
addresses to hex groups (`::ffff:7f00:1`), not dotted-quad.

Verification covers 45 cases including every bypass listed above, and asserts
not merely that a blocked redirect returns an error but that the internal
address is _never fetched at all_.

---

## 5 — Running it: doubled output

Static checks (typecheck, lint, build, 45 logic/security cases) all passed while
the application was still broken in three separate ways, found only by running
it. Each was diagnosed from evidence rather than guessed at, using a throwaway
probe Worker to capture Workers AI's raw wire format.

> _(reconstructed)_ I opened it in the browser and every reply comes out
> doubled, like "YourYour input input is is not not sufficient". Can you look
> into it?

**Response.** Workers AI streams each chunk in _both_ wire formats at once, the
native `response` field and the OpenAI-compatible `choices[0].delta.content`,
carrying identical text. `workers-ai-provider` maps them in two consecutive `if`
blocks with no `else`, so each token is enqueued twice. Version 4.0.0 has the
same bug and requires `ai@^7`, so upgrading was neither a fix nor safe. Worked
around in `src/lib/workers-ai-stream-fix.ts`.

---

## 6 — Running it: tool calls with empty arguments

> _(reconstructed)_ The text looks fine now, but starting a research run doesn't
> work. It calls startResearch over and over until it gives up.

**Response.** The model retried `startResearch` ten times until it hit the step
cap because every tool call arrived with empty arguments. Same root cause, worse
consequence: tool arguments stream as incremental JSON fragments, so doubling
produced `{"topic": "{"topic": "CloudCloudflare...` — unparseable. Found by
reading `rawInput` in the UI's debug view. Fixing the stream de-duplication to
cover `tool_calls` as well as text resolved it. A missing `maxOutputTokens` on
the chat model was a genuine second defect found along the way: Workers AI's
default completion budget truncated long tool-call arguments mid-JSON.

---

## 7 — Running it: the workflow fails on its first step

> _(reconstructed)_ The run starts now but the plan never shows up. The workflow
> errors with `result?.response?.trim is not a function`.

**Response.** Workers AI's non-streaming response shape is not stable:
`response` is normally a string, but when a completion is itself valid JSON —
exactly what the planning step asks for — it is parsed and `response` arrives as
an _object_, while `choices[0].message.content` keeps the verbatim string.
`runText` now reads whichever is present.

The Workflows step history was the decisive diagnostic tool throughout, exposed
in local development at `/cdn-cgi/explorer/api/workflows/...`. It shows per-step
status and attempt counts, which is how the retry policy was confirmed working
(`attempts=3` on the failing step) and how the approval gate was proven to be a
genuine suspension rather than a busy wait:

```
step: plan-1                | type: step          | attempts: 1
step: await plan approval-1 | type: waitForEvent  | attempts: 0
```

---

## 8 — Documentation

> _(reconstructed)_ Write the README: the architecture, where each of the four
> requirements lives in the code, setup steps, and the main design decisions.
> Then write up the prompt history for PROMPTS.md.

**Response.** Wrote `README.md` and this file.

---

## Standing preferences

- **Security review before done.** Applied in §4.
- **No new test files.** Verification of the pure logic (URL guard, chunker) was
  written and run as a throwaway script outside the repository rather than
  committed as a spec file.

---

## Provenance

Derived from [`cloudflare/agents-starter`](https://github.com/cloudflare/agents-starter),
MIT licensed; the upstream `LICENSE` is retained. The research pipeline, Durable
Object design, memory layer, URL guard, prompts, and UI components in
`src/components/` are original to this project.
