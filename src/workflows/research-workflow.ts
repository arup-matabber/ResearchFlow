import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { getAgentByName } from "agents";
import { MODELS } from "../lib/models";
import { embed, parseJsonObject, runText } from "../lib/inference";
import { fetchAndExtract } from "../lib/extract";
import { chunkMarkdown } from "../lib/chunk";
import { partitionUrls } from "../lib/url-guard";
import {
  PLAN_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  SYNTHESIZE_SYSTEM_PROMPT,
  planPrompt,
  summarizePrompt,
  synthesizePrompt
} from "../lib/prompts";
import type {
  AgentBroadcast,
  FetchedSource,
  PlanApproval,
  ResearchParams,
  ResearchPlan,
  SourceSummary,
  StepState
} from "../types";

/** Transient failures (a flaky host, a rate limit) are worth retrying. */
const FETCH_RETRIES = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }
} as const;

const MODEL_RETRIES = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "3 minutes"
} as const;

/**
 * The durable half of the application.
 *
 * Every `step.do` below is a checkpoint: its result is persisted before the
 * next step begins, so an eviction, a crash, or a `wrangler dev` restart
 * resumes here rather than starting the research over. The approval gate in
 * step 2 is the reason this is a Workflow at all — the run parks for up to an
 * hour with no compute held open, and a Durable Object releases it later.
 */
export class ResearchWorkflow extends WorkflowEntrypoint<Env, ResearchParams> {
  async run(event: WorkflowEvent<ResearchParams>, step: WorkflowStep) {
    const { sessionId, topic } = event.payload;
    const instanceId = event.instanceId;

    const progress = (
      stepKey: string,
      label: string,
      state: StepState,
      detail?: string
    ) =>
      this.#notify(sessionId, {
        type: "research-progress",
        instanceId,
        step: stepKey,
        label,
        state,
        detail,
        at: new Date().toISOString()
      });

    try {
      const { allowed: urls, rejected } = partitionUrls(event.payload.urls);
      for (const { url, reason } of rejected) {
        await progress(`reject:${url}`, `Rejected ${url}`, "failed", reason);
      }
      if (urls.length === 0) {
        throw new Error("no usable source URLs were supplied");
      }

      // ---- 1. Plan -------------------------------------------------------
      await progress("plan", "Planning research", "running");
      const plan = await step.do("plan", MODEL_RETRIES, async () => {
        const raw = await runText(this.env.AI, MODELS.plan, {
          system: PLAN_SYSTEM_PROMPT,
          prompt: planPrompt(topic, urls),
          maxTokens: 700,
          temperature: 0.4
        });

        const parsed = parseJsonObject<ResearchPlan>(raw);
        // A malformed plan is recoverable — the run is still worth doing with
        // the bare topic as its single question.
        return {
          subtopics: parsed?.subtopics?.filter(Boolean)?.slice(0, 5) ?? [topic],
          gaps: parsed?.gaps?.filter(Boolean)?.slice(0, 5) ?? [],
          rationale: parsed?.rationale ?? "Fell back to the topic as stated."
        } satisfies ResearchPlan;
      });
      await progress(
        "plan",
        "Planning research",
        "done",
        `${plan.subtopics.length} research questions`
      );

      await this.#notify(sessionId, {
        type: "research-plan",
        instanceId,
        topic,
        plan,
        at: new Date().toISOString()
      });

      // ---- 2. Human-in-the-loop gate -------------------------------------
      // The instance parks here. It holds no compute and does not count
      // against the concurrent-instance limit while waiting.
      await progress("approval", "Awaiting your approval", "waiting");
      const approvedPlan = await this.#awaitApproval(step, plan);
      await progress(
        "approval",
        "Plan approved",
        "done",
        `${approvedPlan.subtopics.length} questions confirmed`
      );

      // ---- 3. Fetch and extract ------------------------------------------
      const fetched = await Promise.all(
        urls.map(async (url) => {
          const key = `fetch:${url}`;
          await progress(key, `Reading ${hostOf(url)}`, "running");
          try {
            const source = await step.do(key, FETCH_RETRIES, () =>
              fetchAndExtract(url)
            );
            await progress(
              key,
              `Read ${hostOf(url)}`,
              source.status === "ok" ? "done" : "failed",
              source.status === "ok"
                ? `${source.chars.toLocaleString()} characters`
                : source.error
            );
            return source;
          } catch (error) {
            // Retries are exhausted. One dead link must not sink the brief.
            const message = describe(error);
            await progress(key, `Failed ${hostOf(url)}`, "failed", message);
            return {
              url,
              status: "failed",
              title: url,
              text: "",
              chars: 0,
              error: message
            } satisfies FetchedSource;
          }
        })
      );

      const readable = fetched.filter((s) => s.status === "ok" && s.text);
      if (readable.length === 0) {
        throw new Error("none of the supplied sources could be read");
      }

      // ---- 4. Summarize each source (the "map") --------------------------
      const summaries = await Promise.all(
        fetched.map(async (source) => {
          if (source.status !== "ok" || !source.text) {
            return {
              url: source.url,
              title: source.title,
              status: "failed",
              summary: "",
              error: source.error
            } satisfies SourceSummary;
          }

          const key = `summarize:${source.url}`;
          await progress(key, `Summarizing ${hostOf(source.url)}`, "running");
          try {
            const summary = await step.do(key, MODEL_RETRIES, () =>
              runText(this.env.AI, MODELS.summarize, {
                system: SUMMARIZE_SYSTEM_PROMPT,
                prompt: summarizePrompt(topic, approvedPlan.subtopics, source),
                maxTokens: 700,
                temperature: 0.2
              })
            );

            const irrelevant = summary.trim().startsWith("NOT RELEVANT");
            await progress(
              key,
              `Summarized ${hostOf(source.url)}`,
              irrelevant ? "failed" : "done",
              irrelevant ? "not relevant to the topic" : undefined
            );

            return {
              url: source.url,
              title: source.title,
              status: irrelevant ? "failed" : "ok",
              summary: irrelevant ? "" : summary,
              error: irrelevant ? "not relevant to the topic" : undefined
            } satisfies SourceSummary;
          } catch (error) {
            const message = describe(error);
            await progress(
              key,
              `Failed to summarize ${hostOf(source.url)}`,
              "failed",
              message
            );
            return {
              url: source.url,
              title: source.title,
              status: "failed",
              summary: "",
              error: message
            } satisfies SourceSummary;
          }
        })
      );

      if (summaries.every((s) => s.status !== "ok")) {
        throw new Error("no source produced a usable summary");
      }

      // ---- 5. Synthesize (the "reduce") ----------------------------------
      await progress("synthesize", "Writing the brief", "running");
      const markdown = await step.do("synthesize", MODEL_RETRIES, () =>
        runText(this.env.AI, MODELS.synthesis, {
          system: SYNTHESIZE_SYSTEM_PROMPT,
          prompt: synthesizePrompt(topic, approvedPlan, summaries),
          maxTokens: 2000,
          temperature: 0.3
        })
      );
      await progress("synthesize", "Brief written", "done");

      // ---- 6. Embed and commit to long-term memory -----------------------
      await progress("persist", "Filing to memory", "running");
      const stored = await step.do("persist", MODEL_RETRIES, async () => {
        const chunks = chunkMarkdown(markdown);
        const vectors = await embed(this.env.AI, chunks);
        const agent = await getAgentByName(this.env.ResearchAgent, sessionId);

        // `briefId` is the instance id, and the agent replaces any existing
        // rows for it, so a retry of this step overwrites rather than
        // duplicates.
        await agent.saveBrief({
          briefId: instanceId,
          topic,
          markdown,
          sources: summaries,
          chunks: chunks.map((text, i) => ({
            briefId: instanceId,
            topic,
            text,
            embedding: vectors[i]
          }))
        });

        return { chunks: chunks.length };
      });
      await progress(
        "persist",
        "Filed to memory",
        "done",
        `${stored.chunks} passages indexed`
      );

      await this.#notify(sessionId, {
        type: "research-brief",
        instanceId,
        briefId: instanceId,
        topic,
        markdown,
        sources: summaries,
        at: new Date().toISOString()
      });

      return { briefId: instanceId, sources: summaries.length };
    } catch (error) {
      await this.#notify(sessionId, {
        type: "research-failed",
        instanceId,
        topic,
        error: describe(error),
        at: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Park until the user approves the plan.
   *
   * A `waitForEvent` timeout throws and would otherwise fail the whole
   * instance, so an unattended run degrades to proceeding with the plan as
   * proposed rather than discarding the work already checkpointed.
   */
  async #awaitApproval(
    step: WorkflowStep,
    plan: ResearchPlan
  ): Promise<ResearchPlan> {
    try {
      const event = await step.waitForEvent<PlanApproval>(
        "await plan approval",
        { type: "plan-approval", timeout: "1 hour" }
      );

      const payload = event.payload;
      if (payload?.approved === false) {
        throw new Error("research plan was rejected");
      }
      // Bounded independently of the agent's own check: this event is the
      // one place external input re-enters an already-running pipeline.
      const subtopics = payload?.subtopics
        ?.filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0
        )
        .slice(0, 5)
        .map((s) => s.slice(0, 300));
      return subtopics?.length ? { ...plan, subtopics } : plan;
    } catch (error) {
      if (describe(error).includes("rejected")) throw error;
      return plan;
    }
  }

  /**
   * Fan a state change out to the chat UI.
   *
   * Deliberately called outside `step.do`: these are transient UI signals, not
   * durable state, and a replay re-emitting them is harmless because every
   * event is keyed by step. It must never throw — a browser that closed its
   * WebSocket is not a reason to fail the research.
   */
  async #notify(sessionId: string, event: AgentBroadcast): Promise<void> {
    try {
      const agent = await getAgentByName(this.env.ResearchAgent, sessionId);
      await agent.onResearchEvent(event);
    } catch (error) {
      console.error("progress notification dropped:", describe(error));
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
