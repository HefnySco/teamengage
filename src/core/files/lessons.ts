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

/**
 * Rewrite lesson number `n` in place with a fresh date and session — the
 * merge path (TE-0182): a repeat lesson updates the existing line's date
 * instead of appending a duplicate. Returns false when there is no such line.
 */
export async function updateLesson(
  plansDir: string,
  domain: string,
  n: number,
  session: string,
  now: string,
): Promise<boolean> {
  const file = fileFor(plansDir, domain);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }
  const lines = text.split("\n");
  let seen = 0;
  const idx = lines.findIndex((l) => l.startsWith(MARK) && ++seen === n);
  if (idx < 0) return false;
  const body = lines[idx].slice(MARK.length);
  // keep the lesson text after the last " — " (the date + session prefix)
  const lessonText = body.includes(" — ") ? body.slice(body.lastIndexOf(" — ") + 3) : body;
  lines[idx] = `${MARK}${now.slice(0, 10)} ${session} — ${lessonText.trim()}`;
  await fs.writeFile(file, lines.join("\n"));
  return true;
}

/**
 * Text-only compare for lessons (TE-0182): strip the `- date session — `
 * prefix, lowercase, collapse whitespace. Two lessons whose texts
 * normalize equal are the same lesson.
 */
export function lessonKey(line: string): string {
  const body = line.trim().replace(/^[-*]\s*/, "");
  const text = body.includes(" — ") ? body.slice(body.lastIndexOf(" — ") + 3) : body;
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A pending agent lesson waiting for the human's OK (TE-0182). */
export interface PendingLesson {
  n: number;
  domain: string;
  text: string;
  by: string;
  at: string;
  /** the item the lesson was learned on — the inbox row links to it */
  source?: string;
  state: "pending" | "approved" | "rejected";
}

const PENDING_FILE = ".pending.json";

async function readAllPending(plansDir: string): Promise<PendingLesson[]> {
  try {
    const list = JSON.parse(await fs.readFile(join(plansDir, "lessons", PENDING_FILE), "utf8"));
    return Array.isArray(list) ? (list as PendingLesson[]) : [];
  } catch {
    return [];
  }
}

async function writeAllPending(plansDir: string, list: PendingLesson[]): Promise<void> {
  await fs.mkdir(join(plansDir, "lessons"), { recursive: true });
  await fs.writeFile(join(plansDir, "lessons", PENDING_FILE), `${JSON.stringify(list, null, 1)}\n`);
}

/** Pending lesson candidates, newest first — the inbox view. */
export async function pendingLessons(plansDir: string): Promise<PendingLesson[]> {
  return (await readAllPending(plansDir)).filter((p) => p.state === "pending");
}

/** Add a candidate; returns its n (1-based across all recorded entries). */
export async function recordPendingLesson(
  plansDir: string,
  p: Omit<PendingLesson, "n" | "state">,
): Promise<number> {
  const all = await readAllPending(plansDir);
  const n = all.length ? Math.max(...all.map((x) => x.n)) + 1 : 1;
  all.push({ ...p, n, state: "pending" });
  await writeAllPending(plansDir, all);
  return n;
}

/** Mark candidate `n` approved or rejected. Returns it, or null when unsettled/missing. */
export async function settlePendingLesson(
  plansDir: string,
  n: number,
  state: "approved" | "rejected",
): Promise<PendingLesson | null> {
  const all = await readAllPending(plansDir);
  const p = all.find((x) => x.n === n);
  if (!p || p.state !== "pending") return null;
  p.state = state;
  await writeAllPending(plansDir, all);
  return p;
}

/** One pending candidate by n, or undefined. */
export async function pendingLesson(plansDir: string, n: number): Promise<PendingLesson | undefined> {
  return (await readAllPending(plansDir)).find((x) => x.n === n && x.state === "pending");
}

/** Refresh one pending candidate's `at` in place (TE-0186). */
export async function touchPendingLesson(plansDir: string, n: number, at: string): Promise<void> {
  const all = await readAllPending(plansDir);
  const p = all.find((x) => x.n === n && x.state === "pending");
  if (!p) return;
  p.at = at;
  await writeAllPending(plansDir, all);
}
