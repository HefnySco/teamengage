import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDaemon } from "../client.js";
import { readDaemonInfo, runningDaemon } from "../../daemon/server/server.js";

/**
 * `te restart` — restart teamengaged. Uses the systemd user unit when one
 * is installed (scripts/service.sh writes it); otherwise kills the pid in
 * ~/.teamengage/daemon.json and lets ensureDaemon spawn a fresh daemon.
 * With nothing running it just starts one.
 */

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

export async function restartCmd(_args: string[], home?: string): Promise<number> {
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
