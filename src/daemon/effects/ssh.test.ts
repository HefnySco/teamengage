import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PlansStore } from "../store/store.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { SessionRegistry } from "../sessions/sessions.js";
import { WorkspaceOps } from "../api/ops.js";
import { snapshotDiff } from "./effects.js";
import type { Session } from "../../core/model/session.js";
import type { LoadedWorkspace } from "../../core/config/config.js";

/**
 * RS-0006: ssh resource against a real sshd — an ubuntu container with
 * openssh-server + rsync, keyed auth, non-standard port via `ssh_opts`.
 * Skipped when docker or the image is unavailable.
 */

const IMAGE = "ubuntu:24.04";

/**
 * Docker usable AND the image available (pulled here, up front): a missing
 * daemon, an image that can't be pulled (registry limits, retired tags) or
 * no network skips this suite instead of failing the whole run.
 */
const dockerOk = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    return false;
  }
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    /* not cached — try to pull */
  }
  try {
    execFileSync("docker", ["pull", "-q", IMAGE], { stdio: "ignore", timeout: 180_000 });
    return true;
  } catch {
    console.warn(`ssh.test: docker can't provide ${IMAGE} — skipping the real-sshd suite`);
    return false;
  }
})();

const PORT = 2299;
const NAME = "te-sshd-test";
const REMOTE_DIR = "/home/te/data";

let home: string;
let root: string;
let plans: string;
let key: string;
let ops: WorkspaceOps;
let store: PlansStore;
let sshOpts: string[];
let agent: Session;
let wsPath: LoadedWorkspace;

const ssh = (cmd: string) =>
  execFileSync("ssh", [...sshOpts, "-p", String(PORT), "te@127.0.0.1", cmd], {
    encoding: "utf8",
  }).trim();

beforeAll(async () => {
  if (!dockerOk) return;
  home = mkdtempSync(join(tmpdir(), "te-ssh-"));
  root = join(home, "ws");
  plans = join(root, ".teamengage");
  key = join(home, "id_ed25519");
  sshOpts = [
    "-i",
    key,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
  ];
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-q"]);
  const pub = readFileSync(`${key}.pub`, "utf8").trim();

  execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  execFileSync("docker", [
    "run", "-d", "--name", NAME, "-p", `${PORT}:22`, IMAGE,
    "bash", "-c",
    `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server rsync >/dev/null 2>&1 && mkdir /run/sshd && useradd -m te && mkdir -p /home/te/.ssh ${REMOTE_DIR} && echo '${pub}' > /home/te/.ssh/authorized_keys && chown -R te:te /home/te && chmod 700 /home/te/.ssh && chmod 600 /home/te/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e`,
  ]);
  // wait for sshd (apt install can take a while)
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      ssh("true");
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  ssh(`mkdir -p ${REMOTE_DIR}/cfg && echo remote-v1 > ${REMOTE_DIR}/cfg/a.conf && echo other > ${REMOTE_DIR}/b.conf`);

  mkdirSync(join(plans, "items", "WS"), { recursive: true });
  writeFileSync(
    join(plans, "workspace.yaml"),
    `name: ws\nprefix: WS\nresources:\n  rpi: { kind: ssh, host: te@127.0.0.1, path: ${REMOTE_DIR}, snapshot: true, ssh_opts: ${JSON.stringify(sshOpts.concat(["-p", String(PORT)]))} }\n`,
  );
  writeFileSync(
    join(plans, "items", "WS", "WS-0001.md"),
    `---\nid: WS-0001\ntype: task\ntitle: ssh task\nstatus: ready\nversion: 1\ntargets: ["@rpi:cfg/**"]\n---\n\n## Summary\nssh\n`,
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: plans });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: plans });
  execFileSync("git", ["config", "user.name", "t"], { cwd: plans });
  execFileSync("git", ["add", "-A"], { cwd: plans });
  execFileSync("git", ["commit", "-m", "init"], { cwd: plans });
  const ws = resolveWorkspace(root, { home });
  store = new PlansStore(ws, "test");
  await store.init();
  const sessions = new SessionRegistry("test");
  ops = new WorkspaceOps({ ws, store }, sessions, undefined, home);
  wsPath = ws;
}, 200_000);

afterAll(async () => {
  if (!dockerOk) return;
  execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!dockerOk)("ssh resource over a real sshd container (RS-0006)", () => {
  it("claim snapshots the claimed remote subtree over ssh", async () => {
    agent = (await ops.hello("agent")).session;
    await ops.claim("WS-0001", agent);
    const snap = join(home, ".teamengage", "snapshots", "ws", "WS-0001", "rpi", "cfg", "a.conf");
    expect(existsSync(snap)).toBe(true);
    expect(readFileSync(snap, "utf8")).toBe("remote-v1\n");
    // unclaimed subtree never snapshotted
    expect(existsSync(join(home, ".teamengage", "snapshots", "ws", "WS-0001", "rpi", "b.conf"))).toBe(false);
  });

  it("live-vs-snapshot diff and rollback round-trip over the wire", async () => {
    // remote edit inside + outside the claim
    ssh(`echo remote-v2 > ${REMOTE_DIR}/cfg/a.conf && echo touched > ${REMOTE_DIR}/b.conf`);
    const diff = await snapshotDiff(wsPath, "WS-0001", "rpi", home);
    expect(diff).toContain("a.conf");
    const r = (await ops.rollback("WS-0001")) as { restored: string[] };
    expect(r.restored).toContain("rpi");
    // claimed subtree restored…
    expect(ssh(`cat ${REMOTE_DIR}/cfg/a.conf`)).toBe("remote-v1");
    // …sibling changes survive — no whole-dir --delete
    expect(ssh(`cat ${REMOTE_DIR}/b.conf`)).toBe("touched");
    await ops.release("WS-0001", agent, "done");
  });

  it("targets with $(...), backticks and ' cannot execute on the remote", async () => {
    // a real remote dir whose name contains a single quote
    ssh(`mkdir -p ${REMOTE_DIR}/we\\'ird && echo q > ${REMOTE_DIR}/we\\'ird/f.txt`);
    // under the old "…" quoting, $(…) and `…` inside the pattern would run
    // on the remote. With single-quoting they're literal filenames.
    writeFileSync(
      join(plans, "items", "WS", "WS-0002.md"),
      `---\nid: WS-0002\ntype: task\ntitle: metachar\nstatus: ready\nversion: 1\ntargets: ["@rpi:$(touch\${IFS}pwned-sub)/**", "@rpi:\`touch\${IFS}pwned-bt\`/**", "@rpi:we'ird/**"]\n---\n\n## Summary\nx\n`,
    );
    const st = new PlansStore(wsPath, "test");
    await st.init();
    const sessions = new SessionRegistry("test");
    const o = new WorkspaceOps({ ws: wsPath, store: st }, sessions, undefined, home);
    const a = (await o.hello("meta")).session;
    // $(…)/`…` paths don't exist → recorded missing; we'ird snapshots fine
    await expect(o.claim("WS-0002", a)).resolves.toBeDefined();
    expect(existsSync(join(home, ".teamengage", "snapshots", "ws", "WS-0002", "rpi", "we'ird", "f.txt"))).toBe(true);
    // nothing was executed on the remote — no files created in the login dir
    await o.rollback("WS-0002");
    await o.release("WS-0002", a, "done");
    await new Promise((r) => setTimeout(r, 100));
    expect(ssh(`ls /home/te`)).not.toMatch(/pwned/);
    expect(ssh(`ls ${REMOTE_DIR}`)).not.toMatch(/pwned/);
  });
});
