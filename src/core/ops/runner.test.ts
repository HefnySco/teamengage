import { describe, it, expect } from "vitest";
import { hostKey } from "./runner.js";

describe("hostKey (DE-0152)", () => {
  it("keeps every label of an IPv4 literal — 15.235.101.105 is not '15'", () => {
    expect(hostKey("15.235.101.105")).toBe("15-235-101-105");
    expect(hostKey("15.235.101.105")).not.toBe("15");
    // two IP hosts on the same first label must not collide
    expect(hostKey("15.235.101.99")).not.toBe(hostKey("15.235.101.105"));
  });

  it("still keeps only the first label of a hostname", () => {
    expect(hostKey("mhefnyDT.local")).toBe("mhefnydt");
    expect(hostKey("mhefnyDT")).toBe("mhefnydt");
    expect(hostKey("  box.lan  ")).toBe("box");
  });
});
