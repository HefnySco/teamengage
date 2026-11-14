import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureFreshWebBundle } from "./restart.js";

/** Build a fake web/ dir with controlled mtimes; returns its path. */
function fakeWeb(appM: number, cssM: number, distM: number | null): { dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "te-restart-"));
  const dir = join(root, "web");
  mkdirSync(join(dir, "dist"), { recursive: true });
  const files: [string, number | null][] = [
    [join(dir, "app.js"), appM],
    [join(dir, "teamengage.css"), cssM],
    [join(dir, "dist", "app.js"), distM],
  ];
  for (const [f, m] of files) {
    if (m === null) continue;
    writeFileSync(f, "x");
    utimesSync(f, new Date(m), new Date(m));
  }
  return { dir, root };
}

describe("ensureFreshWebBundle (GL-0368)", () => {
  it("rebuilds when web/app.js is newer than dist/app.js", () => {
    const { dir, root } = fakeWeb(3000, 1000, 2000);
    let cwd: string | undefined;
    const ok = ensureFreshWebBundle(dir, false, (c) => ((cwd = c), true));
    expect(ok).toBe(true);
    expect(cwd).toBe(dirname(dir));
    rmSync(root, { recursive: true, force: true });
  });

  it("rebuilds when web/teamengage.css is newer than dist/app.js", () => {
    const { dir, root } = fakeWeb(1000, 3000, 2000);
    let called = false;
    const ok = ensureFreshWebBundle(dir, false, () => ((called = true), true));
    expect(ok).toBe(true);
    expect(called).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not rebuild when the bundle is fresh", () => {
    const { dir, root } = fakeWeb(1000, 1000, 2000);
    let called = false;
    const ok = ensureFreshWebBundle(dir, false, () => ((called = true), true));
    expect(ok).toBe(true);
    expect(called).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("rebuilds on --build even when the bundle is fresh", () => {
    const { dir, root } = fakeWeb(1000, 1000, 2000);
    let called = false;
    const ok = ensureFreshWebBundle(dir, true, () => ((called = true), true));
    expect(ok).toBe(true);
    expect(called).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports failure so restart does not continue", () => {
    const { dir, root } = fakeWeb(3000, 1000, 2000);
    const ok = ensureFreshWebBundle(dir, false, () => false);
    expect(ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
