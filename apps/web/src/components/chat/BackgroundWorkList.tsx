import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import type { ReactNode } from "react";

import { tickTextContent } from "~/lib/tickTextContent";
import { useEnvironment } from "~/state/environments";
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
  /** A delegated task running in a linked environment, which has no thread here. */
  readonly remoteChild:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId; readonly label: string }
    | undefined;
}

/** Every task the background work line counts, one row each, for its expanded state. */
export function BackgroundWorkList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundWorkRow>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  return (
    <ul
      aria-label="Background work"
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
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const { row, onOpenThread } = props;
  const { task, remoteChild } = row;
  // A linked environment opens only while this client is connected to it.
  const remoteEnvironment = useEnvironment(remoteChild?.environmentId ?? null);
  const item = props.turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  const itemId = task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
  const startedAtMs = row.startedAtMs;
  const open =
    row.childThreadId !== undefined
      ? () => onOpenThread(row.childThreadId!)
      : remoteChild !== undefined && remoteEnvironment !== null
        ? () => onOpenThread(remoteChild.threadId, remoteChild.environmentId)
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
        {open === null ? null : (
          <InlineButton tone="muted" onClick={open}>
            Open
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
