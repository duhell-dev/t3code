import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planDeviceJoin } from "./deviceJoin.logic";

const home = EnvironmentId.make("home");
const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");

describe("planDeviceJoin", () => {
  it("joins offered environments this device has not saved", () => {
    expect(
      planDeviceJoin({
        home,
        offered: [a, b],
        saved: new Set(["home", "a"]),
        joined: [],
        dismissed: [],
      }).join,
    ).toEqual([b]);
  });

  it("never offers the home environment itself", () => {
    expect(
      planDeviceJoin({
        home,
        offered: [home, a],
        saved: new Set(["home"]),
        joined: [],
        dismissed: [],
      }).join,
    ).toEqual([a]);
  });

  it("does not bring back an environment the user removed after joining it", () => {
    const plan = planDeviceJoin({
      home,
      offered: [a, b],
      saved: new Set(["home", "b"]),
      joined: ["a", "b"],
      dismissed: [],
    });
    expect(plan.join).toEqual([]);
    expect(plan.dismissed).toEqual(["a"]);
    expect(plan.joined).toEqual(["b"]);
  });

  it("keeps earlier removals and joins nothing when nothing is offered", () => {
    expect(
      planDeviceJoin({ home, offered: [a], saved: new Set(["home"]), joined: [], dismissed: ["a"] })
        .join,
    ).toEqual([]);
    expect(
      planDeviceJoin({ home, offered: [], saved: new Set(["home"]), joined: [], dismissed: [] })
        .join,
    ).toEqual([]);
  });
});
