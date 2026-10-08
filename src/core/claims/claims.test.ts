import { describe, it, expect } from "vitest";
import { targetsOverlap, resolveDoubleClaim, parseClaimFile, claimToYaml } from "./claims.js";
import type { Claim } from "../model/claim.js";

const T = (xs: string[]) => xs;

describe("targetsOverlap", () => {
  const cases: Array<[string[], string[], boolean, string]> = [
    [T(["@m:src/a.ts"]), T(["@m:src/a.ts"]), true, "identical"],
    [T(["@m:src/**"]), T(["@m:src/mission/x.ts"]), true, "glob contains file"],
    [T(["@m:src/**"]), T(["@m:src/mission/**"]), true, "nested globs"],
    [T(["@m:src/comm/**"]), T(["@m:src/mission/**"]), false, "sibling dirs"],
    [T(["@m:src/missionx/**"]), T(["@m:src/mission/**"]), false, "prefix-name sibling"],
    [T(["@a:x/**"]), T(["@b:x/**"]), false, "different resources"],
    [T(["@m"]), T(["@m:anything/x.ts"]), true, "whole resource vs path"],
    [T(["@m:**"]), T(["@m:deep/dir/f.ts"]), true, "** vs file"],
    [T(["@rpi:/home/pi/de/config"]), T(["@rpi:/home/pi/de/**"]), true, "absolute ssh paths"],
    [T(["@rpi:/home/pi/a"]), T(["@rpi:/home/pi/b"]), false, "disjoint abs paths"],
    [T(["@m:src/*.ts"]), T(["@m:lib/**"]), false, "different subtrees"],
    // CR-0008 regression: equivalent spellings must compare equal
    [T(["@m:./src/x/**"]), T(["@m:src/x/a.cpp"]), true, "./ prefix"],
    [T(["@m:src//x"]), T(["@m:src/x"]), true, "double slash"],
    [T(["@m:src/../lib/a"]), T(["@m:lib/**"]), true, ".. segment"],
    [T(["@m:src/x/"]), T(["@m:src/x"]), true, "trailing slash"],
  ];
  it.each(cases)("%j vs %j → %s (%s)", (a, b, want) => {
    expect(targetsOverlap(a, b).overlap).toBe(want);
  });

  it("absolute targets relativize against the resource root", () => {
    const roots = { rpi: "/home/pi/drone_engage" };
    expect(
      targetsOverlap(T(["@rpi:config/**"]), T(["@rpi:/home/pi/drone_engage/config"]), roots).overlap,
    ).toBe(true);
    expect(
      targetsOverlap(T(["@rpi:other/**"]), T(["@rpi:/home/pi/drone_engage/config"]), roots).overlap,
    ).toBe(false);
  });

  it("unparseable targets are treated as overlap (no false negatives)", () => {
    expect(targetsOverlap(["garbage!!"], ["@m:x"]).overlap).toBe(true);
  });
});

describe("resolveDoubleClaim", () => {
  const c = (claimed_at: string, machine: string, holder = "a@b#1"): Claim => ({
    item: "GL-0001",
    holder,
    actor: "agent",
    machine,
    targets: [],
    claimed_at,
    last_seen: claimed_at,
  });
  it("earliest claimed_at wins regardless of input order", () => {
    const laptop = c("2026-10-08T09:00Z", "laptop");
    const desktop = c("2026-10-08T10:00Z", "desktop");
    for (const arr of [
      [laptop, desktop],
      [desktop, laptop],
    ]) {
      const r = resolveDoubleClaim(arr);
      expect(r.winner).toBe(laptop);
      expect(r.losers).toEqual([desktop]);
    }
  });
  it("ties break on machine name", () => {
    const a = c("2026-10-08T09:00Z", "alpha");
    const b = c("2026-10-08T09:00Z", "beta");
    const r = resolveDoubleClaim([b, a]);
    expect(r.winner.machine).toBe("alpha");
    expect(r.losers[0].machine).toBe("beta");
  });
});

describe("claim file io", () => {
  it("round-trips yaml", () => {
    const claim: Claim = {
      item: "GL-0013",
      holder: "claude-code@desktop#a1f3",
      actor: "agent",
      machine: "desktop",
      targets: ["@m:src/**"],
      claimed_at: "t1",
      last_seen: "t2",
      paths: { mavlink: "/x/worktrees/GL-0013/mavlink" },
    };
    const back = parseClaimFile(claimToYaml(claim));
    expect(back).toEqual(claim);
  });
});
