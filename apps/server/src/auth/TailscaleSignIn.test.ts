import { describe, expect, it } from "vite-plus/test";

import {
  decideTailscaleSignIn,
  parseListEnv,
  parseTailscaleSelf,
  parseTailscaleWhois,
  type TailscaleSelf,
  type TailscaleWhois,
} from "./TailscaleSignIn.ts";

const self: TailscaleSelf = { nodeId: "n-server", addresses: ["100.64.0.10", "fd7a::10"] };
const laptop: TailscaleWhois = {
  nodeId: "n-laptop",
  nodeName: "laptop.example.ts.net",
  tags: [],
  addresses: ["100.64.0.20", "fd7a::20"],
  login: "user@example.com",
};
const base = {
  peerIsLoopback: true,
  headerLogin: "user@example.com",
  clientIp: "100.64.0.20",
  whois: laptop,
  self,
  allowedLogins: ["user@example.com"],
  refuseNodes: [],
};

describe("decideTailscaleSignIn", () => {
  it("lets an allowed login on another device sign in", () => {
    expect(decideTailscaleSignIn(base)).toEqual({ type: "allow", nodeName: "laptop" });
  });

  it("refuses the server's own machine, whoever runs the request there", () => {
    // Another OS user on the server reaches Serve from the server's node, with the owner's login.
    const fromServer = {
      ...base,
      clientIp: "100.64.0.10",
      whois: {
        ...laptop,
        nodeId: "n-server",
        nodeName: "server.example.ts.net",
        addresses: self.addresses,
      },
    };
    expect(decideTailscaleSignIn(fromServer).type).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, clientIp: "fd7a::10" }).type).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, whois: { ...laptop, nodeId: "n-server" } }).type).toBe(
      "refuse",
    );
  });

  it("fails closed when its own node or the device cannot be read", () => {
    expect(decideTailscaleSignIn({ ...base, self: null }).type).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, whois: null }).type).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, clientIp: undefined }).type).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, headerLogin: undefined }).type).toBe("refuse");
  });

  it("is off without allowed logins and only answers requests through Serve", () => {
    expect(decideTailscaleSignIn({ ...base, allowedLogins: [] }).type).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, peerIsLoopback: false }).type).toBe("refuse");
  });

  it("refuses tagged devices, other logins and listed devices", () => {
    expect(decideTailscaleSignIn({ ...base, whois: { ...laptop, tags: ["tag:ci"] } }).type).toBe(
      "refuse",
    );
    expect(
      decideTailscaleSignIn({ ...base, whois: { ...laptop, login: "other@example.com" } }).type,
    ).toBe("refuse");
    expect(
      decideTailscaleSignIn({
        ...base,
        headerLogin: "other@example.com",
        whois: { ...laptop, login: "other@example.com" },
      }).type,
    ).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, refuseNodes: ["laptop"] }).type).toBe("refuse");
    expect(decideTailscaleSignIn({ ...base, refuseNodes: ["100.64.0.20"] }).type).toBe("refuse");
  });

  it("compares logins without case", () => {
    expect(decideTailscaleSignIn({ ...base, headerLogin: "User@Example.com" }).type).toBe("allow");
  });
});

describe("parsing tailscale output", () => {
  it("reads a whois answer", () => {
    expect(
      parseTailscaleWhois(
        JSON.stringify({
          Node: {
            ID: 123,
            Name: "laptop.example.ts.net.",
            Tags: null,
            Addresses: ["100.64.0.20/32", "fd7a::20/128"],
          },
          UserProfile: { LoginName: "user@example.com" },
        }),
      ),
    ).toEqual({
      nodeId: "123",
      nodeName: "laptop.example.ts.net",
      tags: [],
      addresses: ["100.64.0.20", "fd7a::20"],
      login: "user@example.com",
    });
    expect(parseTailscaleWhois("not json")).toBeNull();
    expect(parseTailscaleWhois(JSON.stringify({ Node: { ID: "" } }))).toBeNull();
  });

  it("reads this machine's node", () => {
    expect(
      parseTailscaleSelf(
        JSON.stringify({ Self: { ID: "n1", TailscaleIPs: ["100.64.0.10", "fd7a::10"] } }),
      ),
    ).toEqual({ nodeId: "n1", addresses: ["100.64.0.10", "fd7a::10"] });
    expect(parseTailscaleSelf(JSON.stringify({}))).toBeNull();
  });

  it("splits list variables", () => {
    expect(parseListEnv(" A@x.com, ,b@y.com ")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseListEnv(undefined)).toEqual([]);
  });
});
