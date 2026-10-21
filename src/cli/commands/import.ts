import { daemonApi } from "../client.js";

/**
 * `te import <folder> [--project p] [--type t] [--dry-run|--apply]` — import
 * a Markdown task folder via the daemon (IM-0001). Dry-run is the default:
 * prints the preview + ambiguity report; `--apply` writes the items.
 * `--type` forces a type (e.g. `idea` for a hand-written source document);
 * without it the filename prefix decides (TASK/PHASE/PLAN/IDEA/…).
 */
export async function importCmd(args: string[], home?: string): Promise<number> {
  const pos = args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      args[i - 1] !== "--project" &&
      args[i - 1] !== "--type" &&
      args[i - 1] !== "--ws",
  );
  const folder = pos[0];
  const opt = (n: string) => {
    const i = args.indexOf(n);
    return i === -1 ? undefined : args[i + 1];
  };
  if (!folder) {
    process.stderr.write("usage: te import <folder> [--project <name>] [--type <t>] [--dry-run|--apply]\n");
    return 2;
  }
  const apply = args.includes("--apply");
  const ws = opt("--ws");
  const r = (await daemonApi(
    "POST",
    `/api/import${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`,
    { folder, project: opt("--project"), type: opt("--type"), apply },
    home,
  )) as {
    apply: boolean;
    preview?: string;
    count?: number;
    created?: string[];
    skipped?: string[];
    ambiguities: Array<{ kind: string; message: string; file: string }>;
  };

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return r.ambiguities.length ? 1 : 0;
  }
  if (!r.apply) {
    process.stdout.write(`dry run — ${r.count} item(s) would be created:\n${r.preview}\n`);
  } else {
    process.stdout.write(
      `imported ${r.created?.length ?? 0} item(s)${r.skipped?.length ? `, skipped ${r.skipped.length} already-imported` : ""}\n`,
    );
  }
  if (r.ambiguities.length) {
    process.stdout.write("\nambiguities (human decisions needed):\n");
    for (const a of r.ambiguities) {
      process.stdout.write(`  ${a.kind}: ${a.file} — ${a.message}\n`);
    }
    return 1;
  }
  return 0;
}
