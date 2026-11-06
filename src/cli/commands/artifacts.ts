import { daemonApi } from "../client.js";

interface ImportPlan {
  applied: boolean;
  move: string[];
  attach: string[];
  already: string[];
  no_item: string[];
  errors: string[];
}

/**
 * `te artifacts import [--apply]` — scan `.artifacts/` for loose files named
 * `<prefix><digits>-<name>` and attach each to `<PREFIX>-<digits>` (caption =
 * the file name). Root-level files move to `.artifacts/<project>/`. Without
 * `--apply` only the plan is printed. Files are never deleted.
 */
export async function artifactsCmd(args: string[], home?: string): Promise<number> {
  const sub = args.find((a) => !a.startsWith("--"));
  if (sub !== "import") {
    process.stderr.write(
      "usage: te artifacts import [--apply] [--ws <name>]\n" +
        "  <prefix><digits>-<name> under .artifacts/ attaches to <PREFIX>-<digits>\n",
    );
    return 2;
  }
  const i = args.indexOf("--ws");
  const ws = i !== -1 ? `?ws=${encodeURIComponent(args[i + 1] ?? "")}` : "";
  const r = (await daemonApi(
    "POST",
    `/api/artifacts/import${ws}`,
    { apply: args.includes("--apply") },
    home,
  )) as ImportPlan;
  const section = (title: string, lines: string[]) =>
    lines.length ? [`${title} (${lines.length}):`, ...lines.map((l) => `  ${l}`)] : [];
  const out = [
    ...section("move", r.move),
    ...section(r.applied ? "attached" : "would attach", r.attach),
    ...section("already attached", r.already),
    ...section("no matching item — left in place", r.no_item),
    ...section("errors", r.errors),
  ];
  if (!out.length) out.push("nothing to import");
  else if (!r.applied) out.push("(dry run — pass --apply to make these changes)");
  process.stdout.write(out.join("\n") + "\n");
  return r.errors.length ? 1 : 0;
}
