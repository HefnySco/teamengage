import { describe, it, expect } from "vitest";
import { normalizeDomain, normalizeDomains, suggestDomains, domainColor } from "./domains.js";

describe("domains", () => {
  it("normalizes names like hashtags", () => {
    expect(normalizeDomain("Web Client")).toBe("web-client");
    expect(normalizeDomain("#MAVLink")).toBe("mavlink");
    expect(normalizeDomain("  de_comm ")).toBe("de_comm");
    expect(normalizeDomain("Sécurité!")).toBe("securite");
    expect(normalizeDomains(["A", "a", "", "b c", "B-C"])).toEqual(["a", "b-c"]);
  });

  it("suggests by whole-word keywords or the name itself", () => {
    const defs = {
      mavlink: { keywords: ["droneengage_mavlink", "de_mavlink"] },
      comm: { keywords: ["de_comm"] },
      security: { keywords: ["tls", "trust-all"] },
      gpio: {},
    };
    expect(suggestDomains("fix in droneengage_mavlink/src and de_comm", defs)).toEqual(["mavlink", "comm"]);
    expect(suggestDomains("Remove the Trust-All TLS bypass", defs)).toEqual(["security"]);
    expect(suggestDomains("gpio.<pin>.verb", defs)).toEqual(["gpio"]);
    // no partial words
    expect(suggestDomains("communication, tlsx", defs)).toEqual([]);
  });

  it("stable colours, explicit colour wins", () => {
    expect(domainColor("mavlink")).toBe(domainColor("mavlink"));
    expect(domainColor("mavlink", { color: "#123456" })).toBe("#123456");
  });
});

describe("rankDomains", () => {
  const defs = {
    mavlink: { keywords: ["de_mavlink"] },
    comm: { keywords: ["de_comm"] },
    webclient: { keywords: ["webclient"] },
    missions: { keywords: ["mission_planner"] },
  };
  it("title/touches outweigh passing mentions; max 3, best first", async () => {
    const { rankDomains } = await import("./domains.js");
    expect(
      rankDomains(
        {
          strong: "Reset seq in de_mavlink and de_comm",
          lead: "de_mavlink forwards…",
          body: "the webclient shows it once.",
        },
        defs,
      ),
    ).toEqual(["mavlink", "comm"]); // one webclient mention is not enough
    expect(rankDomains({ strong: "x", lead: "", body: "webclient ".repeat(50) }, defs)).toEqual([]); // volume capped
    expect(rankDomains({ strong: "", lead: "webclient webclient", body: "webclient webclient" }, defs)).toEqual(["webclient"]);
    expect(
      rankDomains({ strong: "de_mavlink de_comm webclient mission_planner", lead: "", body: "" }, defs),
    ).toHaveLength(3);
  });
});
