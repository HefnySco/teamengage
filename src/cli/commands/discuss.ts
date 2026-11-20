import { statSync } from "node:fs";
import { resolve } from "node:path";
import { daemonApi } from "../client.js";

interface CaptureResult {
  id: string;
  file: string;
  transcript: string;
  format: string;
  redacted?: number;
  secret_hits?: string[];
  warning?: string;
}

/**
 * `te discuss save <file> --title <t> [--project p] [--summary s] [--redact|--sensitive]`
 * — save an exported chat as a discussion (TE-0157). The daemon converts a
 * Claude Code JSONL transcript to Markdown turns, scans it for secrets and
 * writes DISC-NN-<slug>.md + .transcript.md.
 */
export async function discussCmd(args: string[], home?: string): Promise<number> {
  const sub = args.find((a) => !a.startsWith("--"));
  if (sub !== "save") {
    process.stderr.write(
      "usage: te discuss save <file> --title <t> [--project p] [--summary s] [--redact|--sensitive] [--ws name]\n",
    );
    return 2;
  }
  const rest = args.slice(args.indexOf("save") + 1);
  const file = rest.find((a) => !a.startsWith("--"));
  const opt = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  const title = opt("title");
  if (!file || !title) {
    process.stderr.write(
      "usage: te discuss save <file> --title <t> [--project p] [--summary s] [--redact|--sensitive] [--ws name]\n",
    );
    return 2;
  }
  const abs = resolve(file);
  try {
    if (!statSync(abs).isFile()) throw new Error("not a file");
  } catch {
    process.stderr.write(`te discuss: no such file: ${file}\n`);
    return 1;
  }
  const ws = opt("ws");
  const r = (await daemonApi(
    "POST",
    `/api/discussions${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`,
    {
      title,
      project: opt("project"),
      summary: opt("summary"),
      // the daemon is local: send the path, not the bytes (no body limit)
      transcript_path: abs,
      redact: rest.includes("--redact"),
      sensitive: rest.includes("--sensitive"),
    },
    home,
  )) as CaptureResult;
  process.stdout.write(
    `captured ${r.id} → ${r.file}\n` +
      `transcript → ${r.transcript}${r.format === "jsonl" ? " (JSONL → Markdown)" : ""}\n` +
      (r.redacted ? `redacted ${r.redacted} secret-looking string(s)\n` : "") +
      (r.secret_hits?.length ? `secret hits kept (!sensitive): ${r.secret_hits.join(", ")}\n` : "") +
      (r.warning ? `warning: ${r.warning}\n` : ""),
  );
  return 0;
}
