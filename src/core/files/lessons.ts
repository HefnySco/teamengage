import { promises as fs } from "node:fs";
import { join } from "node:path";
import { normalizeDomain } from "../domains/domains.js";

/**
 * Shared lessons per domain (GL-0322). One markdown list per domain at
 * `<plansDir>/lessons/<domain>.md`; the daemon appends `- <date> <session>
 * — <text>` lines. Agents write them (lesson), `brief` reads the newest
 * few, and the human deletes single lines on the domains page. Plain
 * files — no index, no events, nothing to sync but the plans git itself.
 */

const MARK = "- ";

function fileFor(plansDir: string, domain: string): string {
  return join(plansDir, "lessons", `${normalizeDomain(domain)}.md`);
}

/** The lesson lines of one domain, oldest first. Missing file → []. */
export async function readLessons(plansDir: string, domain: string): Promise<string[]> {
  try {
    const text = await fs.readFile(fileFor(plansDir, domain), "utf8");
    return text
      .split("\n")
      .filter((l) => l.startsWith(MARK))
      .map((l) => l.slice(MARK.length).trim());
  } catch {
    return [];
  }
}

/** Append one `- <date> <session> — <text>` line; creates file + dir as needed. */
export async function appendLesson(
  plansDir: string,
  domain: string,
  session: string,
  text: string,
  now: string,
): Promise<void> {
  const file = fileFor(plansDir, domain);
  await fs.mkdir(join(plansDir, "lessons"), { recursive: true });
  const line = `${MARK}${now.slice(0, 10)} ${session} — ${text.trim().replace(/\s*\n\s*/g, " ")}`;
  let head = "";
  try {
    await fs.access(file);
  } catch {
    head = `# lessons — #${normalizeDomain(domain)}\n\n`;
  }
  await fs.appendFile(file, `${head}${line}\n`);
}

/**
 * Remove lesson number `n` (1-based among the `- ` lines). Returns the
 * removed line, or null when there is no such lesson.
 */
export async function removeLesson(
  plansDir: string,
  domain: string,
  n: number,
): Promise<string | null> {
  const file = fileFor(plansDir, domain);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  let seen = 0;
  const idx = lines.findIndex((l) => l.startsWith(MARK) && ++seen === n);
  if (idx < 0) return null;
  const removed = lines[idx].slice(MARK.length).trim();
  lines.splice(idx, 1);
  await fs.writeFile(file, lines.join("\n"));
  return removed;
}
