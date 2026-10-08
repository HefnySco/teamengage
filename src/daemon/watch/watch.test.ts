import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { PlansWatcher, type WatchEvent } from "./watch.js";

/**
 * DM-0002: the watcher must accept human edits as real writes, suppress the
 * daemon's own writes, surface unparseable files without rewriting them,
 * and track claim-file changes.
 */

let home: string;
let root: string;
let plans: string;
let store: PlansStore;
let watcher: PlansWatcher;
let events: WatchEvent[];

function item(id: string, status = "ready", extra = "") {
  return `---\nid: ${id}\ntype: task\ntitle: ${id}\nstatus: ${status}\nversion: 1\n${extra}---\n\n## Summary\n${id}\n`;
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "te-watch-"));
  root = join(home, "ws");
  plans = join(root, ".teamengage");
  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(join(plans, "workspace.yaml"), "name: ws\nprefix: WS\nresources: {}\n");
  writeFileSync(join(plans, "items", "WS", "WS-0001.md"), item("WS-0001"));
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });

  store = new PlansStore(resolveWorkspace(root, { home }), "test");
  await store.init();
  events = [];
  watcher = new PlansWatcher(store, {
    debounceMs: 30,
    onEvent: (e) => events.push(e),
  });
  await watcher.start();
});

afterAll(async () => {
  await watcher.close();
  rmSync(home, { recursive: true, force: true });
});

describe("file watcher (DM-0002)", () => {
  it("a human edit re-indexes the item and bumps its version", async () => {
    const p = join(plans, "items", "WS", "WS-0001.md");
    writeFileSync(p, item("WS-0001", "in_progress", "assignee: sam\n"));
    await waitFor(() => events.some((e) => e.kind === "human_edit" && e.item === "WS-0001"));
    const it = store.idx.items.get("WS-0001");
    expect(it?.meta.status).toBe("in_progress");
    expect(it?.meta.version).toBe(2);
  });

  it("the daemon's own writes are suppressed", async () => {
    const p = join(plans, "items", "WS", "WS-0002.md");
    mkdirSync(join(plans, "items", "WS"), { recursive: true });
    events = [];
    // simulate a daemon write: mark the exact bytes, then write them
    const text = item("WS-0002");
    watcher.markOwnWrite(p, text);
    writeFileSync(p, text);
    await new Promise((r) => setTimeout(r, 600));
    expect(events.some((e) => e.item === "WS-0002" && e.kind === "human_edit")).toBe(false);
    rmSync(p, { force: true });
  });

  it("conflict-marker files are flagged invalid and never rewritten", async () => {
    const p = join(plans, "items", "WS", "WS-0003.md");
    const bad = `---\nid: WS-0003\ntype: task\nstatus: ready\nversion: 1\n---\n\n## Summary\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n`;
    writeFileSync(p, bad);
    await waitFor(() => events.some((e) => e.kind === "invalid" && e.path === p));
    expect(store.idx.invalidFiles.has(p)).toBe(true);
    // untouched on disk
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(p, "utf8")).toBe(bad);
    rmSync(p, { force: true });
  });

  it("claim file changes update the index", async () => {
    mkdirSync(join(plans, "claims"), { recursive: true });
    const p = join(plans, "claims", "WS-0001.yaml");
    writeFileSync(
      p,
      "item: WS-0001\nholder: s1\nactor: agent\nmachine: m1\nclaimed_at: '2025-01-01T00:00:00Z'\nlast_seen: '2025-01-01T00:00:00Z'\n",
    );
    await waitFor(() => events.some((e) => e.kind === "claim_change" && e.item === "WS-0001"));
    expect(store.idx.claims.get("WS-0001")?.holder).toBe("s1");
    rmSync(p, { force: true });
    await waitFor(() => !store.idx.claims.has("WS-0001"));
  });

  it("deleting an item file removes it from the index", async () => {
    const p = join(plans, "items", "WS", "WS-0004.md");
    writeFileSync(p, item("WS-0004"));
    await waitFor(() => store.idx.items.has("WS-0004"));
    rmSync(p, { force: true });
    await waitFor(() => events.some((e) => e.kind === "removed" && e.path === p));
    expect(store.idx.items.has("WS-0004")).toBe(false);
  });
});
