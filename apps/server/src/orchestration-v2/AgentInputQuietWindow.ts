import { MAX_AGENT_INPUT_QUIET_SECONDS } from "@t3tools/contracts/settings";

/** However often siblings keep it open, a held input starts its run by then. */
export const AGENT_INPUT_MAX_HOLD_MS = MAX_AGENT_INPUT_QUIET_SECONDS * 1_000;

/**
 * When an idle thread's collected agent input starts its run, or null to start it now.
 * Each new input moves the start a quiet period on; running siblings of a delegated
 * completion keep it waiting, both only up to the cap after the first input arrived.
 */
export function agentInputHoldUntil(input: {
  readonly quietMs: number;
  readonly nowMs: number;
  readonly firstHeldAtMs: number | undefined;
  readonly threadIdle: boolean;
  readonly siblingsRunning: boolean;
}): number | null {
  if (input.quietMs <= 0 || !input.threadIdle) return null;
  const capAtMs = (input.firstHeldAtMs ?? input.nowMs) + AGENT_INPUT_MAX_HOLD_MS;
  const dueAtMs = input.siblingsRunning ? capAtMs : Math.min(input.nowMs + input.quietMs, capAtMs);
  return dueAtMs > input.nowMs ? dueAtMs : null;
}
