/** Shared contracts between the Worker, the Durable Object agent, and the Workflow. */

export type SourceStatus = "ok" | "failed";

/** Raw text pulled off one source URL. */
export interface FetchedSource {
  url: string;
  status: SourceStatus;
  title: string;
  text: string;
  chars: number;
  error?: string;
}

/** One source after the map stage of the map-reduce. */
export interface SourceSummary {
  url: string;
  title: string;
  status: SourceStatus;
  summary: string;
  error?: string;
}

/** The plan the model proposes before any fetching happens. */
export interface ResearchPlan {
  subtopics: string[];
  gaps: string[];
  rationale: string;
}

/** Payload handed to the Workflow at creation time. */
export interface ResearchParams {
  sessionId: string;
  topic: string;
  urls: string[];
}

/** Payload delivered through `instance.sendEvent` to release the approval gate. */
export interface PlanApproval {
  approved: boolean;
  subtopics: string[];
}

export type StepState = "pending" | "running" | "waiting" | "done" | "failed";

/**
 * Progress events are keyed by `step` so a Workflow replay overwrites the
 * previous value instead of appending a duplicate to the tracker.
 */
export interface ProgressEvent {
  type: "research-progress";
  instanceId: string;
  step: string;
  label: string;
  state: StepState;
  detail?: string;
  at: string;
}

export interface PlanProposedEvent {
  type: "research-plan";
  instanceId: string;
  topic: string;
  plan: ResearchPlan;
  at: string;
}

export interface BriefReadyEvent {
  type: "research-brief";
  instanceId: string;
  briefId: string;
  topic: string;
  markdown: string;
  sources: SourceSummary[];
  at: string;
}

export interface ResearchFailedEvent {
  type: "research-failed";
  instanceId: string;
  topic: string;
  error: string;
  at: string;
}

export type AgentBroadcast =
  | ProgressEvent
  | PlanProposedEvent
  | BriefReadyEvent
  | ResearchFailedEvent;

/** A stored brief, as returned to the chat model by the recall tools. */
export interface StoredBrief {
  id: string;
  topic: string;
  markdown: string;
  createdAt: string;
  instanceId: string;
}

/** One embedded window of a stored brief. */
export interface MemoryChunk {
  briefId: string;
  topic: string;
  text: string;
  embedding: number[];
}

export interface MemoryHit {
  briefId: string;
  topic: string;
  text: string;
  score: number;
}

/** Written by the Workflow's persist step through a Durable Object RPC call. */
export interface SaveBriefPayload {
  briefId: string;
  topic: string;
  markdown: string;
  sources: SourceSummary[];
  chunks: MemoryChunk[];
}

export type RunStatus =
  | "planning"
  | "awaiting-approval"
  | "running"
  | "done"
  | "failed";

export interface TrackedStep {
  label: string;
  state: StepState;
  detail?: string;
  at: string;
}

/**
 * Synced to the browser automatically by the Agents state channel, so a page
 * reload mid-run rehydrates the tracker instead of losing it.
 */
export interface ResearchRun {
  instanceId: string;
  topic: string;
  status: RunStatus;
  startedAt: string;
  plan?: ResearchPlan;
  steps: Record<string, TrackedStep>;
  brief?: { briefId: string; markdown: string; sources: SourceSummary[] };
  error?: string;
}

export interface AgentState {
  activeRun: ResearchRun | null;
}
