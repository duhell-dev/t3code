import { T, useGT } from "gt-react";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import type { ReactNode } from "react";

import { useSideThreadTrigger } from "~/hooks/useSideThreadTrigger";
import { tickTextContent } from "~/lib/tickTextContent";
import { useEnvironment } from "~/state/environments";
import { useLinkedThreadOpener } from "~/state/linkedThreadView";
import { InlineButton } from "../ui/button";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";

export interface BackgroundWorkRow {
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly label: ReactNode;
  /** The label as plain text, to tell whether it already shows the whole command. */
  readonly labelText: string;
  readonly activity: string | null;
  readonly startedAtMs: number | null;
  readonly childThreadId: ThreadId | undefined;
}

/** Every task the background work line counts, one row each, for its expanded state. */
export function BackgroundWorkList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkRow>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  return (
    <ul
      aria-label={gt("Background work")}
      className="ms-1.5 max-h-[min(24rem,50dvh)] list-none space-y-2 overflow-y-auto overscroll-contain border-s border-border ps-3 text-xs text-muted-foreground"
    >
      {props.rows.map((row) => (
        <BackgroundWorkListRow
          key={row.task.taskId}
          row={row}
          environmentId={props.environmentId}
          threadId={props.threadId}
          turnItems={props.turnItems}
          streamsOutput={streamsOutput}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </ul>
  );
}

function BackgroundWorkListRow(props: {
  readonly row: BackgroundWorkRow;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly streamsOutput: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row, onOpenThread } = props;
  const { task } = row;
  const item = props.turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === (task.nativeItemId ?? task.taskId)
      : candidate.id === task.itemId,
  );
  // A delegated task running in a linked environment, which has no thread here.
  const remoteChild =
    task.kind === "subagent" && item?.type === "subagent" ? item.remoteChild : undefined;
  const remoteEnvironment = useEnvironment(remoteChild?.environmentId ?? null);
  const opener = useLinkedThreadOpener(
    scopeThreadRef(props.environmentId, props.threadId),
    remoteChild,
    row.labelText,
  );
  const trigger = useSideThreadTrigger();
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
  const startedAtMs = row.startedAtMs;
  const openProps =
    row.childThreadId !== undefined
      ? { onClick: () => onOpenThread(row.childThreadId!) }
      : opener
        ? trigger(opener.open, { panel: opener.mode === "linked" })
        : null;
  return (
    <li className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <span className="min-w-0 flex-1 truncate text-foreground/80">{row.label}</span>
        {remoteChild === undefined ? null : (
          <span className="shrink-0">on {remoteEnvironment?.label ?? remoteChild.label}</span>
        )}
        {startedAtMs === null ? null : (
          <span
            ref={tickTextContent(
              (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs)),
              true,
            )}
            className="shrink-0 tabular-nums"
          />
        )}
        {openProps === null ? null : (
          <InlineButton tone="muted" {...openProps}>
            <T context="verb, opens a background task's thread">Open</T>
          </InlineButton>
        )}
      </div>
      {row.activity ? <div className="truncate">{row.activity}</div> : null}
      {command && command.trim() !== row.labelText.trim() ? (
        <div className="rounded-md border border-border bg-muted/20 p-2 font-mono whitespace-pre-wrap break-words">
          <ShellCommandBlock command={command} />
        </div>
      ) : null}
      {itemId && props.streamsOutput && item?.status === "running" ? (
        <div className="font-mono whitespace-pre-wrap break-words">
          <CommandOutputPanel
            environmentId={props.environmentId}
            threadId={task.sourceThreadId ?? item.threadId ?? props.threadId}
            itemId={itemId}
          />
        </div>
      ) : null}
    </li>
  );
}
