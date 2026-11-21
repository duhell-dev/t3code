// duhell: which offered environments a device joins now (state/deviceJoin.ts).
import type { EnvironmentId } from "@t3tools/contracts";

export interface DeviceJoinPlan {
  /** Offered environments this device has not saved and the user has not removed. */
  readonly join: ReadonlyArray<EnvironmentId>;
  /** Joined environments still saved here. */
  readonly joined: ReadonlyArray<string>;
  /** Environments the user removed after joining them; never joined again. */
  readonly dismissed: ReadonlyArray<string>;
}

export function planDeviceJoin(input: {
  readonly home: EnvironmentId;
  readonly offered: ReadonlyArray<EnvironmentId>;
  /** Environments saved on this device. */
  readonly saved: ReadonlySet<string>;
  readonly joined: ReadonlyArray<string>;
  readonly dismissed: ReadonlyArray<string>;
}): DeviceJoinPlan {
  const dismissed = new Set(input.dismissed);
  // Joined once and gone from the device since: the user removed it.
  for (const id of input.joined) if (!input.saved.has(id)) dismissed.add(id);
  const joined = input.joined.filter((id) => input.saved.has(id));
  const join = [...new Set(input.offered)].filter(
    (id) => id !== input.home && !input.saved.has(id) && !dismissed.has(id),
  );
  return { join, joined, dismissed: [...dismissed] };
}
