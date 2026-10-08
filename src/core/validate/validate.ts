import { isStale } from "../model/claim.js";
import { parseItemRef, parseTargetRef } from "../address/refs.js";
import { targetsOverlap, type Roots } from "../claims/claims.js";
import type { Index } from "../index/index.js";

/** Plan-graph health check (DESIGN CR-0009). Feeds the human inbox + `te validate`. */

export type Severity = "error" | "warning" | "info";

export type FindingKind =
  | "dangling_ref"
  | "cycle"
  | "done_with_open_deps"
  | "duplicate_id"
  | "invalid_frontmatter"
  | "conflict_markers"
  | "claim_on_missing"
  | "claim_on_done"
  | "overlapping_claims"
  | "stale_claim"
  | "unsynced_claim"
  | "bad_target";

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

  return findings;
}
