import { useEffect, useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  ClockIcon,
  FileTextIcon,
  LinkSimpleIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import type { ResearchRun, StepState, TrackedStep } from "../types";

/**
 * Steps arrive keyed rather than ordered, because the Workflow reports them
 * concurrently and may replay them. This restores pipeline order for display.
 */
const STAGE_RANK: [prefix: string, rank: number][] = [
  ["plan", 0],
  ["approval", 1],
  ["reject:", 2],
  ["fetch:", 3],
  ["summarize:", 4],
  ["synthesize", 5],
  ["persist", 6]
];

function rankOf(key: string): number {
  for (const [prefix, rank] of STAGE_RANK) {
    if (key === prefix || key.startsWith(prefix)) return rank;
  }
  return 99;
}

function orderSteps(
  steps: Record<string, TrackedStep>
): [string, TrackedStep][] {
  return Object.entries(steps).sort(([a, sa], [b, sb]) => {
    const delta = rankOf(a) - rankOf(b);
    return delta !== 0 ? delta : sa.at.localeCompare(sb.at);
  });
}

function StateIcon({ state }: { state: StepState }) {
  switch (state) {
    case "running":
      return (
        <CircleNotchIcon
          size={14}
          className="text-kumo-accent animate-spin shrink-0"
        />
      );
    case "waiting":
      return <ClockIcon size={14} className="text-kumo-warning shrink-0" />;
    case "done":
      return (
        <CheckCircleIcon
          size={14}
          weight="fill"
          className="text-kumo-success shrink-0"
        />
      );
    case "failed":
      return <XCircleIcon size={14} className="text-kumo-danger shrink-0" />;
    default:
      return (
        <CircleDashedIcon size={14} className="text-kumo-inactive shrink-0" />
      );
  }
}

function StepTracker({ steps }: { steps: Record<string, TrackedStep> }) {
  const ordered = orderSteps(steps);
  if (ordered.length === 0) return null;

  return (
    <ol className="space-y-1.5">
      {ordered.map(([key, step]) => (
        <li key={key} className="flex items-start gap-2">
          <span className="mt-0.5">
            <StateIcon state={step.state} />
          </span>
          <span className="min-w-0">
            <span
              className={
                step.state === "failed"
                  ? "text-sm text-kumo-danger"
                  : "text-sm text-kumo-default"
              }
            >
              {step.label}
            </span>
            {step.detail && (
              <span className="text-xs text-kumo-subtle ml-2">
                {step.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The approval gate. While this is on screen the Workflow instance is parked in
 * `step.waitForEvent`, holding no compute.
 */
function PlanApproval({
  run,
  onApprove,
  onReject,
  busy
}: {
  run: ResearchRun;
  onApprove: (subtopics: string[]) => void;
  onReject: () => void;
  busy: boolean;
}) {
  const proposed = run.plan?.subtopics ?? [];
  const [selected, setSelected] = useState<string[]>(proposed);

  // Re-seed if a new plan arrives for a different run.
  useEffect(() => {
    setSelected(run.plan?.subtopics ?? []);
  }, [run.instanceId, run.plan]);

  const toggle = (subtopic: string) =>
    setSelected((current) =>
      current.includes(subtopic)
        ? current.filter((s) => s !== subtopic)
        : [...current, subtopic]
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ClockIcon size={16} className="text-kumo-warning" />
        <Text size="sm" bold>
          Approve the research plan
        </Text>
      </div>

      {run.plan?.rationale && (
        <Text size="xs" variant="secondary">
          {run.plan.rationale}
        </Text>
      )}

      <div className="space-y-1.5">
        {proposed.map((subtopic) => (
          <label
            key={subtopic}
            className="flex items-start gap-2 cursor-pointer group"
          >
            <input
              type="checkbox"
              checked={selected.includes(subtopic)}
              onChange={() => toggle(subtopic)}
              className="mt-1 accent-current"
            />
            <span className="text-sm text-kumo-default group-hover:text-kumo-accent">
              {subtopic}
            </span>
          </label>
        ))}
      </div>

      {run.plan?.gaps?.length ? (
        <div className="pt-1">
          <Text size="xs" variant="secondary">
            Likely gaps: {run.plan.gaps.join("; ")}
          </Text>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || selected.length === 0}
          onClick={() => onApprove(selected)}
        >
          {busy
            ? "Releasing…"
            : `Approve ${selected.length} question${selected.length === 1 ? "" : "s"}`}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReject}>
          Cancel run
        </Button>
      </div>
    </div>
  );
}

function BriefCard({ run }: { run: ResearchRun }) {
  const brief = run.brief;
  if (!brief) return null;

  const ok = brief.sources.filter((s) => s.status === "ok");
  const failed = brief.sources.filter((s) => s.status !== "ok");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FileTextIcon size={16} className="text-kumo-success" />
        <Text size="sm" bold>
          {run.topic}
        </Text>
        <Badge variant="secondary">
          {ok.length} source{ok.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="text-sm text-kumo-default prose-sm max-w-none">
        <Streamdown>{brief.markdown}</Streamdown>
      </div>

      <div className="pt-2 border-t border-kumo-line space-y-1">
        {ok.map((source, i) => (
          <div key={source.url} className="flex items-start gap-1.5">
            <LinkSimpleIcon
              size={12}
              className="text-kumo-inactive mt-1 shrink-0"
            />
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-kumo-accent hover:underline break-all"
            >
              [Source {i + 1}] {source.title}
            </a>
          </div>
        ))}
        {failed.map((source) => (
          <div key={source.url} className="flex items-start gap-1.5">
            <XCircleIcon size={12} className="text-kumo-danger mt-1 shrink-0" />
            <span className="text-xs text-kumo-subtle break-all">
              {source.url} — {source.error ?? "unavailable"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<ResearchRun["status"], string> = {
  planning: "Planning",
  "awaiting-approval": "Waiting for you",
  running: "Researching",
  done: "Brief ready",
  failed: "Failed"
};

/**
 * Rendered from synced agent state rather than from transient events, so a
 * page reload mid-run restores the tracker exactly as it was.
 */
export function ResearchPanel({
  run,
  onApprove,
  onReject
}: {
  run: ResearchRun | null;
  onApprove: (subtopics: string[]) => void;
  onReject: () => void;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => setBusy(false), [run?.status]);

  if (!run) return null;

  const awaitingApproval = run.status === "awaiting-approval" && run.plan;

  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate">
          <Text size="xs" variant="secondary">
            {run.topic}
          </Text>
        </span>
        <Badge variant={run.status === "failed" ? "error" : "secondary"}>
          {STATUS_LABEL[run.status]}
        </Badge>
      </div>

      <StepTracker steps={run.steps} />

      {awaitingApproval && (
        <div className="pt-3 border-t border-kumo-line">
          <PlanApproval
            run={run}
            busy={busy}
            onApprove={(subtopics) => {
              setBusy(true);
              onApprove(subtopics);
            }}
            onReject={() => {
              setBusy(true);
              onReject();
            }}
          />
        </div>
      )}

      {run.status === "done" && run.brief && (
        <div className="pt-3 border-t border-kumo-line">
          <BriefCard run={run} />
        </div>
      )}

      {run.status === "failed" && run.error && (
        <div className="pt-3 border-t border-kumo-line">
          <span className="text-kumo-danger">
            <Text size="xs">{run.error}</Text>
          </span>
        </div>
      )}
    </Surface>
  );
}
