import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const THREAD_CATCH_UP_WS_METHOD = "orchestration.getThreadCatchUp";

export const ThreadCatchUpInput = Schema.Struct({
  threadId: ThreadId,
  /** The reader's boundary: what came after it is new to them. */
  since: IsoDateTime,
});
export type ThreadCatchUpInput = typeof ThreadCatchUpInput.Type;

export const ThreadCatchUpSummary = Schema.Struct({
  /** What the reader has to decide or do, first. */
  todo: Schema.Array(Schema.String),
  points: Schema.Array(Schema.String),
  messageCount: NonNegativeInt,
  /** The model that wrote it, so the box can say who summarized. */
  model: Schema.String,
});
export type ThreadCatchUpSummary = typeof ThreadCatchUpSummary.Type;

export const ThreadCatchUpResult = Schema.Struct({
  /** Null when too little happened after the boundary to be worth a summary. */
  summary: Schema.NullOr(ThreadCatchUpSummary),
});
export type ThreadCatchUpResult = typeof ThreadCatchUpResult.Type;

export class ThreadCatchUpError extends Schema.TaggedError<ThreadCatchUpError>()(
  "ThreadCatchUpError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
