import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDaemon } from "../client.js";
import { readDaemonInfo, runningDaemon } from "../../daemon/server/server.js";
import { webBundleStale } from "../../core/validate/validate.js";

/**
 * `te restart` — restart teamengaged. Uses the systemd user unit when one
 * is installed (scripts/service.sh writes it); otherwise kills the pid in
 * ~/.teamengage/daemon.json and lets ensureDaemon spawn a fresh daemon.
 * With nothing running it just starts one.
 * GL-0368: rebuilds web/dist first when a web source file is newer than
 * the bundle, or when --build is passed — the daemon serves web/dist, so
 * a stale bundle would keep hiding source changes after the restart.
 */

/** repo root — src/cli/commands → root (same depth in dist/). */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const webDir = join(repoRoot, "web");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitRunning(home?: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await runningDaemon(home)) return true;
    await sleep(500);
  }
  return false;
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250);
  return !pidAlive(pid);
}

/** GL-0368: rebuild web/dist when the bundle is stale or force is set.
 *  Returns false only when the build ran and failed. `run` is injectable
 *  for tests; it receives the repo root and returns true on success. */
export function ensureFreshWebBundle(
  dir: string,
  force = false,
  run?: (cwd: string) => boolean,
): boolean {
  const stale = webBundleStale(dir);
  if (!force && !stale) return true;
  process.stdout.write(
    force && !stale ? "rebuilding web/dist (--build)\n" : "web bundle is stale — rebuilding web/dist\n",
  );
  const build =
    run ??
    ((cwd: string) =>
      spawnSync("npm", ["run", "build:web"], {
        cwd,
        stdio: "inherit",
        windowsHide: true,
        // npm is a .cmd on Windows — it only runs through cmd.exe
        shell: process.platform === "win32",
      }).status === 0);
  return build(dirname(dir));
}

export async function restartCmd(args: string[], home?: string): Promise<number> {
  if (!ensureFreshWebBundle(webDir, args.includes("--build"))) {
    process.stderr.write("te: web build failed — not restarting\n");
    return 1;
  }
  const unit = join(
    home ?? homedir(),
    ".config",
    "systemd",
    "user",
    "teamengaged.service",
  );
  if (existsSync(unit)) {
    const r = spawnSync("systemctl", ["--user", "restart", "teamengaged"], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (r.status !== 0) {
      process.stderr.write("te: systemctl --user restart teamengaged failed\n");
      return 1;
    }
    if (!(await waitRunning(home))) {
      process.stderr.write("te: daemon did not come back\n");
      return 1;
    }
    const { port } = await ensureDaemon(home);
    process.stdout.write(`teamengaged restarted — http://127.0.0.1:${port}\n`);
    return 0;
  }
  const info = readDaemonInfo(home);
  if (info && pidAlive(info.pid)) {
    let dead = false;
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      try {
        process.kill(info.pid, sig);
      } catch {
        dead = true;
        break;
      }
      if ((dead = await waitDead(info.pid))) break;
    }
    if (!dead) {
      process.stderr.write(`te: daemon pid ${info.pid} did not stop\n`);
      return 1;
    }
  }
  const { port } = await ensureDaemon(home);
  process.stdout.write(`teamengaged restarted — http://127.0.0.1:${port}\n`);
  return 0;
}
