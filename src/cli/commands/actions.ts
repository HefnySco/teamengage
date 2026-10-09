import { daemonApi } from "../client.js";

/**
 * Human action commands (CL-0002): approve, answer, accept, reject, drop,
 * claim, release, renumber — 1:1 with the DM-0005 endpoints.
 */

const opt = (args: string[], n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const positional = (args: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) i++;
    else out.push(args[i]);
  }
  return out;
};
const wsQ = (args: string[]) => {
  const w = opt(args, "--ws");
  return w ? `?ws=${encodeURIComponent(w)}` : "";
};

async function act(
  action: string,
  args: string[],
  body?: Record<string, unknown>,
  home?: string,
): Promise<number> {
  const [id] = positional(args);
  if (!id) {
    process.stderr.write(`usage: te ${action} <ID> [options]\n`);
    return 2;
  }
  const r = (await daemonApi(
    "POST",
    `/api/items/${encodeURIComponent(id.toUpperCase())}/${action}${wsQ(args)}`,
    body ?? {},
    home,
  )) as { meta?: { status?: string } };
  process.stdout.write(`${id.toUpperCase()} → ${r.meta?.status ?? action}\n`);
  return 0;
}

export const approveCmd = (args: string[], home?: string) => act("approve", args, {}, home);
export const acceptCmd = (args: string[], home?: string) => act("accept", args, {}, home);
export const humanClaimCmd = (args: string[], home?: string) => act("claim", args, {}, home);

export async function answerCmd(args: string[], home?: string): Promise<number> {
  const pos = positional(args);
  const [id, ...rest] = pos;
  const text = opt(args, "--option") ?? rest.join(" ");
  if (!id || !text) {
    process.stderr.write("usage: te answer <ID> <text>\n");
    return 2;
  }
  return act("answer", [id, ...args.filter((a) => a.startsWith("--"))], { text }, home);
}

export async function rejectCmd(args: string[], home?: string): Promise<number> {
  const pos = positional(args);
  const [id, ...rest] = pos;
  if (!id) {
    process.stderr.write("usage: te reject <ID> [reason]\n");
    return 2;
  }
  return act("reject", [id, ...args.filter((a) => a.startsWith("--"))], { reason: rest.join(" ") }, home);
}

export async function dropCmd(args: string[], home?: string): Promise<number> {
  const pos = positional(args);
  const [id, ...rest] = pos;
  if (!id) {
    process.stderr.write("usage: te drop <ID> [reason]\n");
    return 2;
  }
  return act("drop", [id, ...args.filter((a) => a.startsWith("--"))], { reason: rest.join(" ") }, home);
}

export const undropCmd = (args: string[], home?: string) => act("undrop", args, {}, home);

/** `te hold <ID> [reason]` — park a draft/ready item; agents can't see or claim it. */
export async function holdCmd(args: string[], home?: string): Promise<number> {
  const [id, ...rest] = positional(args);
  if (!id) {
    process.stderr.write("usage: te hold <ID> [reason]\n");
    return 2;
  }
  return act("hold", [id, ...args.filter((a) => a.startsWith("--"))], { reason: rest.join(" ") }, home);
}

/** `te archive <ID> [reason]` — hide an item (status kept); `te unarchive <ID>`. */
export async function archiveCmd(args: string[], home?: string): Promise<number> {
  const [id, ...rest] = positional(args);
  if (!id) {
    process.stderr.write("usage: te archive <ID> [reason]\n");
    return 2;
  }
  return act("archive", [id, ...args.filter((a) => a.startsWith("--"))], { reason: rest.join(" ") }, home);
}
export const unarchiveCmd = (args: string[], home?: string) => act("unarchive", args, {}, home);

/** `te delete <ID> [reason] --yes` — remove from tracking; the task file stays, untagged. */
export async function deleteCmd(args: string[], home?: string): Promise<number> {
  const [id, ...rest] = positional(args);
  if (!id || !args.includes("--yes")) {
    process.stderr.write(
      "usage: te delete <ID> [reason] --yes\n" +
        "removes the item from TeamEngage; its task file stays as plain Markdown (te: line removed, path ignored)\n",
    );
    return 2;
  }
  return act("delete", [id, ...args.filter((a) => a.startsWith("--") && a !== "--yes")], { reason: rest.join(" ") }, home);
}

/** `te unhold <ID>` — release a hold → ready. */
export const unholdCmd = (args: string[], home?: string) => act("unhold", args, {}, home);

/** `te draft <ID> [reason]` — send a ready or held item back to draft. */
export async function draftCmd(args: string[], home?: string): Promise<number> {
  const [id, ...rest] = positional(args);
  if (!id) {
    process.stderr.write("usage: te draft <ID> [reason]\n");
    return 2;
  }
  return act("draft", [id, ...args.filter((a) => a.startsWith("--"))], { reason: rest.join(" ") }, home);
}

/** `te done <ID> [note]` — mark done from any status (no review, no merge). */
export async function doneCmd(args: string[], home?: string): Promise<number> {
  const pos = positional(args);
  const [id, ...rest] = pos;
  if (!id) {
    process.stderr.write("usage: te done <ID> [note]\n");
    return 2;
  }
  return act("complete", [id, ...args.filter((a) => a.startsWith("--"))], { note: rest.join(" ") }, home);
}

export async function releaseCmd(args: string[], home?: string): Promise<number> {
  const pos = positional(args);
  const [id, ...rest] = pos;
  if (!id) {
    process.stderr.write("usage: te release <ID> [note]\n");
    return 2;
  }
  return act("release", [id, ...args.filter((a) => a.startsWith("--"))], { note: rest.join(" ") }, home);
}

export async function rollbackCmd(args: string[], home?: string): Promise<number> {
  const [id] = positional(args);
  if (!id) {
    process.stderr.write("usage: te rollback <ID> [--yes]\n");
    return 2;
  }
  if (!args.includes("--yes") && process.stdin.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const a = await rl.question(`restore snapshots over live targets for ${id.toUpperCase()}? [y/N] `);
    rl.close();
    if (!/^y/i.test(a.trim())) return 1;
  }
  const r = (await act("rollback", [id, ...args.filter((a) => a.startsWith("--"))], { force: args.includes("--force") }, home)) as number;
  return r;
}

export async function renumberCmd(args: string[], home?: string): Promise<number> {
  const [oldId, newId] = positional(args);
  if (!oldId || !newId) {
    process.stderr.write("usage: te renumber <OLD> <NEW>\n");
    return 2;
  }
  await daemonApi("POST", `/api/renumber${wsQ(args)}`, { old: oldId, new: newId }, home);
  process.stdout.write(`${oldId} → ${newId}\n`);
  return 0;
}
