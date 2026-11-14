/**
 * Per-repo context files (GL-0355): `<task folder>/repos/<repo>.context.md`
 * holds what the repo is, its structure, build/test commands and rules —
 * at most 80 lines. Any session replaces one `## <section>` at a time
 * through `repo_context`; `brief` shows the file to whoever works that
 * repo; `te validate` reports a file that outgrows the limit.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../model/errors.js";

/** Hard cap `te validate` reports on — the file must stay a context card, not a manual. */
export const CONTEXT_MAX_LINES = 80;

export function contextFileFor(root: string, repo: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(repo)) {
    throw new ValidationError(`repo_context: bad repo name '${repo}'`);
  }
  return join(root, "repos", `${repo}.context.md`);
}

/** The file's text, or undefined when no context exists for the repo. */
export async function readRepoContext(root: string, repo: string): Promise<string | undefined> {
  try {
    return await readFile(contextFileFor(root, repo), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Replace the body of `## <section>` — created when missing, whole file
 * created when absent. The section name is one line, no `#`.
 */
export async function writeRepoContext(
  root: string,
  repo: string,
  section: string,
  text: string,
): Promise<void> {
  const name = section.trim();
  if (!name || name.includes("#") || name.includes("\n")) {
    throw new ValidationError(`repo_context: bad section name '${section}'`);
  }
  const file = contextFileFor(root, repo);
  let doc: string;
  try {
    doc = await readFile(file, "utf8");
  } catch {
    doc = `# ${repo} — context\n`;
  }
  const lines = doc.split("\n");
  const head = new RegExp(`^##\\s+${escapeRe(name)}\\s*$`, "i");
  const at = lines.findIndex((l) => head.test(l));
  const body = `\n${text.trim()}\n`.split("\n");
  if (at >= 0) {
    // body runs to the next ## heading or EOF
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    lines.splice(at, end - at, `## ${name}`, "", ...body.slice(1));
  } else {
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push("", `## ${name}`, "", ...body.slice(1));
  }
  await mkdir(join(root, "repos"), { recursive: true });
  await writeFile(file, lines.join("\n").replace(/\n+$/, "\n"), "utf8");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
