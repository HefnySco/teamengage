import { describe, it, expect } from "vitest";
import {
  ItemMeta,
  Claim,
  DecisionMeta,
  Event,
  Session,
  WorkspaceConfig,
  ResourceConfig,
  WorkspacesRegistry,
  ItemRef,
  TargetRef,
  turnOf,
  isStale,
  parseDuration,
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  ClaimRefusedError,
  NotFoundError,
  ConflictMarkersError,
  ValidationError,
} from "./index.js";

const validItem = {
  id: "GL-0013",
  type: "task",
  title: "Mission re-run resets sequence tracking",
  status: "in_progress",
  project: "global",
  targets: ["@mavlink:src/mission/**", "@rpi-field:config/**"],
  depends_on: ["GL-0012", "mcp:SL-0007"],
  parent: "DE-0003",
  priority: 2,
  version: 7,
  created: "2026-09-20",
  updated: "2026-10-08",
};

describe("ItemMeta", () => {
  it("accepts a full valid item", () => {
    const m = ItemMeta.parse(validItem);
    expect(m.id).toBe("GL-0013");
    expect(m.depends_on).toHaveLength(2);
  });

  it("accepts a minimal item and applies defaults", () => {
    const m = ItemMeta.parse({ id: "TE-0001", type: "epic", title: "x" });
    expect(m.status).toBe("draft");
    expect(m.version).toBe(1);
    expect(m.targets).toEqual([]);
  });

  it("preserves unknown frontmatter fields", () => {
    const m = ItemMeta.parse({ ...validItem, custom_field: { a: 1 }, x_note: "keep me" });
    expect((m as Record<string, unknown>).custom_field).toEqual({ a: 1 });
    expect((m as Record<string, unknown>).x_note).toBe("keep me");
  });

  it.each([
    [{ status: "blocked" }, "bad status"],
    [{ status: "doing" }, "bad status"],
    [{ id: "gl-0013" }, "bad id"],
    [{ id: "GL0013" }, "bad id"],
    [{ type: "chore" }, "bad type"],
    [{ title: "" }, "empty title"],
    [{ depends_on: ["gl-0012"] }, "bad ref"],
    [{ targets: ["mavlink:src/**"] }, "target missing @"],
    [{ version: 0 }, "bad version"],
  ])("rejects %o (%s)", (patch) => {
    expect(() => ItemMeta.parse({ ...validItem, ...patch })).toThrow();
  });

  it("turn derivation matches DESIGN §5", () => {
    expect(turnOf("draft")).toBe("human");
    expect(turnOf("in_review")).toBe("human");
    expect(turnOf("waiting")).toBe("human");
    expect(turnOf("ready")).toBe("agent");
    expect(turnOf("in_progress")).toBe("agent");
    expect(turnOf("done")).toBe("agent");
  });
});

describe("refs", () => {
  it.each(["MP-0042", "mcp:SL-0007", "TE-1"])("ItemRef accepts %s", (r) => {
    expect(ItemRef.parse(r)).toBe(r);
  });
  it.each(["MP0042", "mp-0042", "MCP:SL-0007", "x:y:z"])("ItemRef rejects %s", (r) => {
    expect(() => ItemRef.parse(r)).toThrow();
  });
  it.each(["@mavlink", "@rpi-field:config/**", "@docs:~/a b"])("TargetRef accepts %s", (r) => {
    expect(TargetRef.parse(r)).toBe(r);
  });
  it.each(["mavlink", "@UPPER:x", "@"])("TargetRef rejects %s", (r) => {
    expect(() => TargetRef.parse(r)).toThrow();
  });
});

describe("Claim", () => {
  const valid = {
    item: "GL-0013",
    holder: "claude-code@desktop#a1f3",
    actor: "agent",
    machine: "desktop",
    targets: ["@mavlink:src/mission/**"],
    claimed_at: "2026-10-08T09:00:00Z",
    last_seen: "2026-10-08T09:30:00Z",
  };
  it("accepts a valid claim", () => {
    expect(Claim.parse(valid).item).toBe("GL-0013");
  });
  it("accepts human claims and flags", () => {
    const c = Claim.parse({ ...valid, holder: "human", actor: "human", conflicted: true });
    expect(c.actor).toBe("human");
    expect(c.conflicted).toBe(true);
  });
  it("rejects bad item id and actor kind", () => {
    expect(() => Claim.parse({ ...valid, item: "bad" })).toThrow();
    expect(() => Claim.parse({ ...valid, actor: "robot" })).toThrow();
  });
  it("stale computation uses last_seen + stale_after", () => {
    const c = Claim.parse(valid);
    const t = Date.parse("2026-10-09T10:00:00Z");
    expect(isStale(c, 86_400_000, t)).toBe(true);
    expect(isStale(c, 90_000_000, t)).toBe(false);
    expect(isStale({ ...c, conflicted: true }, 1, t)).toBe(false);
  });
});

describe("DecisionMeta / Event / Session", () => {
  it("decision requires D-id and item ref", () => {
    expect(
      DecisionMeta.parse({ id: "D-0007", title: "use X", item: "GL-0013" }).id,
    ).toBe("D-0007");
    expect(() => DecisionMeta.parse({ id: "GL-0007", title: "x", item: "GL-0013" })).toThrow();
    expect(() => DecisionMeta.parse({ id: "D-7", title: "x", item: "bad ref" })).toThrow();
  });
  it("event round-trips and tolerates extra keys", () => {
    const e = Event.parse({
      ts: "2026-10-08T09:12:00Z",
      machine: "desktop",
      actor: "claude-code@desktop#a1f3",
      item: "GL-0013",
      action: "claim",
      extra: "kept",
    });
    expect(e.action).toBe("claim");
    expect((e as Record<string, unknown>).extra).toBe("kept");
  });
  it("session shape", () => {
    const s = Session.parse({
      id: "gemini-cli@desktop#77b0",
      agent: "gemini-cli",
      machine: "desktop",
      connected_at: "2026-10-08T09:00:00Z",
      last_seen: "2026-10-08T09:00:00Z",
    });
    expect(s.machine).toBe("desktop");
  });
});

describe("WorkspaceConfig / ResourceConfig", () => {
  it("parses the DESIGN §4 sample shape", () => {
    const ws = WorkspaceConfig.parse({
      name: "droneengage",
      prefix: "DE",
      plans: "Tasks",
      projects: { mission_planner: { prefix: "MP" }, global: { prefix: "GL" } },
      resources: {
        mavlink: { kind: "git", path: "droneengage_mavlink", base: "master" },
        sdk: { kind: "git", url: "git@github.com:x/y.git" },
        "rpi-field": { kind: "ssh", host: "pi@rpi4.local", path: "/home/pi/de" },
        docs: { kind: "folder", path: "~/Documents/de_specs" },
        wiki: { kind: "url", url: "https://cloud.ardupilot.org/" },
      },
      links: { mcp: "~/code/mcp" },
    });
    expect(ws.sync).toBe("manual");
    expect(ws.stale_after).toBe("24h");
    expect(ws.resources["rpi-field"].kind).toBe("ssh");
  });

  it("rejects unknown resource kind and incomplete git resource", () => {
    expect(() => ResourceConfig.parse({ kind: "ftp", path: "x" })).toThrow();
    expect(() => ResourceConfig.parse({ kind: "git" })).toThrow();
    expect(() => ResourceConfig.parse({ kind: "ssh", host: "h" })).toThrow();
  });

  it("defaults plans/sync/stale_after", () => {
    const ws = WorkspaceConfig.parse({ name: "x", prefix: "X" });
    expect(ws.plans).toBe(".teamengage");
    expect(ws.sync).toBe("manual");
  });

  it("rejects lowercase prefix", () => {
    expect(() => WorkspaceConfig.parse({ name: "x", prefix: "de" })).toThrow();
  });

  it("registry entries carry per-machine path overrides", () => {
    const reg = WorkspacesRegistry.parse({
      workspaces: {
        droneengage: { root: "~/de_code", overrides: { andruav: { path: "/other/path" } } },
      },
    });
    expect(reg.workspaces.droneengage.overrides?.andruav.path).toBe("/other/path");
  });
});

describe("parseDuration", () => {
  it.each([
    ["24h", 86_400_000],
    ["30m", 1_800_000],
    ["7d", 604_800_000],
    ["90s", 90_000],
    ["500ms", 500],
  ])("%s → %d", (s, ms) => {
    expect(parseDuration(s)).toBe(ms);
  });
  it("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("24")).toThrow();
  });
});

describe("errors", () => {
  it("each error carries its code", () => {
    expect(new ConflictError("x").code).toBe("CONFLICT");
    expect(new NotFoundError("x").code).toBe("NOT_FOUND");
    expect(new ForbiddenError("x").code).toBe("FORBIDDEN");
    expect(new InvalidTransitionError("x", "ready", "accept").code).toBe("INVALID_TRANSITION");
    expect(new ClaimRefusedError("x", "a@b#1", "desktop", "@r").code).toBe("CLAIM_REFUSED");
    expect(new ValidationError("x").code).toBe("VALIDATION");
    expect(new ConflictMarkersError("f.md").code).toBe("CONFLICT_MARKERS");
  });
});
