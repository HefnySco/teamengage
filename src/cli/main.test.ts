import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

describe("scaffold", () => {
  it("package.json declares ESM, node>=22 and the te/teamengage bins", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      type: string;
      version: string;
      engines: { node: string };
      bin: Record<string, string>;
    };
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.bin.te).toBeDefined();
    expect(pkg.bin.teamengage).toBeDefined();
    expect(pkg.bin.teamengaged).toBeDefined();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("module folders exist", () => {
    for (const d of ["core", "daemon", "mcp", "cli"]) {
      expect(existsSync(join(root, "src", d, "index.ts")), `src/${d}`).toBe(true);
    }
    expect(existsSync(join(root, "web"))).toBe(true);
  });
});
