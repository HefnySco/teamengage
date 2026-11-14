import { isStale } from "../model/claim.js";
import { parseItemRef, parseTargetRef } from "../address/refs.js";
import { targetsOverlap, type Roots } from "../claims/claims.js";
import { depSatisfied, type Index } from "../index/index.js";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_MAX_LINES } from "../files/repo-context.js";

/** Plan-graph health check (DESIGN CR-0009). Feeds the human inbox + `te validate`. */

export type Severity = "error" | "warning" | "info";

export type FindingKind =
  | "dangling_ref"
  | "cycle"
  | "done_with_open_deps"
  | "started_on_open_dep"
  | "duplicate_id"
  | "invalid_frontmatter"
  | "conflict_markers"
  | "claim_on_missing"
  | "claim_on_done"
  | "overlapping_claims"
  | "stale_claim"
  | "dead_claim"
  | "unsynced_claim"
  | "bad_target"
  | "playbook"
  | "machine"
  | "env"
  | "check"
  | "ops_probe"
  | "context_file"
  | "review_models"
  | "web_bundle"
  // overlay mode (task-file tracking)
  | "untracked_task_file"
  | "missing_source"
  | "duplicate_tag"
  | "unknown_tag";

export interface Finding {
  severity: Severity;
  kind: FindingKind;
  item?: string;
  path?: string;
  message: string;
}

export interface ValidateOpts {
  now?: number;
  staleAfterMs?: number;
  /** resource name → root, for absolute-path overlap checks */
  roots?: Roots;
  /** GL-0355: repos/ dir holding <repo>.context.md files (≤80 lines each) */
  contextDir?: string;
  /** GL-0361: workspace review_models — warns on an unset deep/quick */
  reviewModels?: { deep?: string; quick?: string; deep_from_tier?: string };
  /** GL-0368: web/ dir holding app.js, teamengage.css and dist/app.js.
   *  Defaults to the tool's own web/ dir; null disables the check. */
  webDir?: string | null;
}

/** The tool's own web/ dir — src/core/validate → repo root → web (same in dist/). */
export function defaultWebDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web");
}

/** GL-0368: true when a web source file is newer than dist/app.js (or it is missing). */
export function webBundleStale(webDir: string): boolean {
  try {
    const srcApp = join(webDir, "app.js");
    if (!existsSync(srcApp)) return false;
    const distApp = join(webDir, "dist", "app.js");
    const distM = existsSync(distApp) ? statSync(distApp).mtimeMs : 0;
    if (statSync(srcApp).mtimeMs > distM) return true;
    const srcCss = join(webDir, "teamengage.css");
    return existsSync(srcCss) && statSync(srcCss).mtimeMs > distM;
  } catch {
    return false;
  }
}

export function validate(index: Index, opts: ValidateOpts = {}): Finding[] {
  const findings: Finding[] = [];
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleAfterMs ?? 86_400_000;
  const f = (x: Finding) => findings.push(x);

  for (const [path, message] of index.invalidFiles) {
    f({
      severity: "error",
      kind: message.includes("conflict markers") ? "conflict_markers" : "invalid_frontmatter",
      path,
      message,
    });
  }

  for (const id of index.duplicates) {
    f({ severity: "error", kind: "duplicate_id", item: id, message: `duplicate item id ${id}` });
  }

  for (const cycle of index.cycles) {
    f({
      severity: "error",
      kind: "cycle",
      item: cycle[0],
      message: `dependency cycle: ${cycle.join(" → ")}`,
    });
  }

  for (const it of index.items.values()) {
    const id = it.meta.id;
    for (const ref of [...it.meta.depends_on, ...(it.meta.parent ? [it.meta.parent] : []), ...it.meta.relates]) {
      let parsed;
      try {
        parsed = parseItemRef(ref);
      } catch {
        f({ severity: "error", kind: "dangling_ref", item: id, path: it.path, message: `bad reference '${ref}'` });
        continue;
      }
      if (parsed.workspace) continue; // cross-workspace refs checked with links loaded
      if (!index.items.has(parsed.id)) {
        f({
          severity: "warning",
          kind: "dangling_ref",
          item: id,
          path: it.path,
          message: `${id} references missing item ${parsed.id}`,
        });
      }
    }
    // started (or submitted) while a dependency is no longer in review/done —
    // e.g. the dependency was rejected after this one began on top of it
    if (["in_progress", "waiting", "in_review"].includes(it.meta.status)) {
      const back = it.meta.depends_on.filter((d) => {
        try {
          const p = parseItemRef(d);
          const dep = p.workspace ? undefined : index.items.get(p.id);
          return dep && !depSatisfied(dep.meta.status, index.reviewUnblocks, dep.meta.unblocks_on);
        } catch {
          return false;
        }
      });
      if (back.length > 0) {
        f({
          severity: "warning",
          kind: "started_on_open_dep",
          item: id,
          path: it.path,
          message: `${id} is ${it.meta.status} but its dependency ${back.join(", ")} is not done or in review (rejected?) — check the work built on it`,
        });
      }
    }
    if (it.meta.status === "done") {
      const open = it.meta.depends_on.filter((d) => {
        try {
          const p = parseItemRef(d);
          const dep = p.workspace ? undefined : index.items.get(p.id);
          return dep && dep.meta.status !== "done" && dep.meta.status !== "dropped";
        } catch {
          return false;
        }
      });
      if (open.length > 0) {
        f({
          severity: "warning",
          kind: "done_with_open_deps",
          item: id,
          path: it.path,
          message: `${id} is done but depends on unfinished: ${open.join(", ")}`,
        });
      }
    }
  }

  for (const claim of index.claims.values()) {
    const it = index.items.get(claim.item);
    if (!it) {
      f({ severity: "error", kind: "claim_on_missing", item: claim.item, message: `claim on missing item ${claim.item} (${claim.holder})` });
    } else if (it.meta.status === "done" || it.meta.status === "dropped") {
      f({ severity: "warning", kind: "claim_on_done", item: claim.item, message: `claim on ${it.meta.status} item ${claim.item}` });
    }
    if (claim.conflicted) {
      f({ severity: "error", kind: "overlapping_claims", item: claim.item, message: `claim conflicted after sync (${claim.holder} on ${claim.machine})` });
    } else if (isStale(claim, staleMs, now)) {
      f({ severity: "warning", kind: "stale_claim", item: claim.item, message: `claim by ${claim.holder} on ${claim.machine} is stale` });
    }
    if (claim.unsynced) {
      f({ severity: "info", kind: "unsynced_claim", item: claim.item, message: `claim ${claim.item} not yet pushed to other machines` });
    }
  }

  // targets that escape their resource root are dangerous — a rollback on
  // ssh would run rm -rf outside the declared path
  for (const it of index.items.values()) {
    for (const t of it.meta.targets ?? []) {
      try {
        parseTargetRef(t);
      } catch {
        f({ severity: "error", kind: "bad_target", item: it.meta.id, path: it.path, message: `${it.meta.id} target '${t}' is invalid or escapes the resource root` });
        continue;
      }
    }
  }

  const claims = [...index.claims.values()].filter((c) => !c.conflicted);
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const o = targetsOverlap(claims[i].targets, claims[j].targets, opts.roots);
      if (o.overlap) {
        f({
          severity: "error",
          kind: "overlapping_claims",
          item: claims[i].item,
          message: `targets of ${claims[i].item} and ${claims[j].item} overlap at ${o.via?.[0]}`,
        });
      }
    }
  }

  // GL-0355: repos/<repo>.context.md — one context card per repo, ≤80 lines
  if (opts.contextDir) {
    try {
      for (const name of readdirSync(opts.contextDir).filter((n) => n.endsWith(".context.md"))) {
        const p = join(opts.contextDir, name);
        const n = readFileSync(p, "utf8").split("\n").length;
        if (n > CONTEXT_MAX_LINES) {
          f({
            severity: "warning",
            kind: "context_file",
            path: p,
            message: `${name} has ${n} lines — a repo context card stays under ${CONTEXT_MAX_LINES}`,
          });
        }
      }
    } catch {
      /* no repos dir — nothing to check */
    }
  }

  // GL-0361: a configured review gate whose model is not set leaves work
  // unreviewable — warn so the human names the model.
  const rm = opts.reviewModels;
  if (rm && !rm.deep) {
    f({
      severity: "warning",
      kind: "review_models",
      message: `review_models: deep is not set — items at or above deep_from_tier (${rm.deep_from_tier ?? "heavy"}) cannot be reviewed`,
    });
  }
  if (rm && !rm.quick) {
    f({
      severity: "warning",
      kind: "review_models",
      message: `review_models: quick is not set — items below deep_from_tier (${rm.deep_from_tier ?? "heavy"}) accept only the deep model`,
    });
  }

  // GL-0368: warn when source web files are newer than the compiled bundle —
  // the daemon serves web/dist, so a stale bundle hides merged UI changes
  const webDir = opts.webDir === undefined ? defaultWebDir() : opts.webDir;
  if (webDir && webBundleStale(webDir)) {
    f({
      severity: "warning",
      kind: "web_bundle",
      path: join(webDir, "dist", "app.js"),
      message: "web/dist bundle is stale — run npm run build:web (or te restart) to update",
    });
  }

  return findings;
}
