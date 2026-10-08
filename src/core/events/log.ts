import { open, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Event } from "../model/event.js";

/**
 * Append-only JSONL event log (DESIGN §3, §6.5). One stream per machine:
 * `events/<machine>/<YYYY-MM>.jsonl` → git merges never conflict. `seq` is a
 * per-file monotonically increasing id, also used for SSE Last-Event-ID.
 */

export function eventFileName(ts: string): string {
  return `${ts.slice(0, 7)}.jsonl`;
}

export function eventFilePath(eventsDir: string, machine: string, ts: string): string {
  return join(eventsDir, machine, eventFileName(ts));
}

export interface ReadResult {
  events: Event[];
  /** Non-fatal problems (e.g. a truncated trailing line). */
  warnings: string[];
}

/** Parse a JSONL stream; a truncated/invalid trailing line is skipped. */
export function parseJsonl(text: string, source: string, warnings: string[]): Event[] {
  const events: Event[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    try {
      events.push(Event.parse(JSON.parse(line)));
    } catch {
      if (i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === "")) {
        warnings.push(`${source}: skipped truncated trailing line ${i + 1}`);
      } else {
        warnings.push(`${source}: skipped invalid line ${i + 1}`);
      }
    }
  }
  return events;
}

export class EventLog {
  private nextSeq = new Map<string, number>();

  constructor(
    private eventsDir: string,
    private machine: string,
  ) {}

  /** Append one event; assigns seq and ts (ISO), fsyncs before returning. */
  async append(ev: Omit<Event, "seq" | "machine"> & { ts?: string }): Promise<Event> {
    const ts = ev.ts ?? new Date().toISOString();
    const path = eventFilePath(this.eventsDir, this.machine, ts);
    await mkdir(join(this.eventsDir, this.machine), { recursive: true });
    let seq = this.nextSeq.get(path);
    if (seq === undefined) {
      seq = await this.scanLastSeq(path);
      this.nextSeq.set(path, seq);
    }
    seq += 1;
    this.nextSeq.set(path, seq);
    const full = { ...ev, seq, ts, machine: this.machine } as Event;
    const fh = await open(path, "a");
    try {
      await fh.write(JSON.stringify(full) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return full;
  }

  private async scanLastSeq(path: string): Promise<number> {
    if (!existsSync(path)) return 0;
    const text = await readFile(path, "utf8");
    let last = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { seq?: number };
        if (typeof e.seq === "number" && e.seq > last) last = e.seq;
      } catch {
        /* truncated tail */
      }
    }
    return last;
  }

  /** Read this machine's stream (all months, ts-ordered). */
  async read(): Promise<ReadResult> {
    const dir = join(this.eventsDir, this.machine);
    if (!existsSync(dir)) return { events: [], warnings: [] };
    const warnings: string[] = [];
    const events: Event[] = [];
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      const text = await readFile(join(dir, f), "utf8");
      events.push(...parseJsonl(text, `${this.machine}/${f}`, warnings));
    }
    events.sort((a, b) => a.ts.localeCompare(b.ts) || (a.seq ?? 0) - (b.seq ?? 0));
    return { events, warnings };
  }
}

/** Merge every machine's stream ordered by ts (ties: machine, seq). */
export async function readAllEvents(eventsDir: string): Promise<ReadResult> {
  const warnings: string[] = [];
  const events: Event[] = [];
  if (existsSync(eventsDir)) {
    for (const machine of await readdir(eventsDir)) {
      const log = new EventLog(eventsDir, machine);
      const r = await log.read();
      events.push(...r.events);
      warnings.push(...r.warnings);
    }
  }
  events.sort(
    (a, b) => a.ts.localeCompare(b.ts) || a.machine.localeCompare(b.machine) || (a.seq ?? 0) - (b.seq ?? 0),
  );
  return { events, warnings };
}
