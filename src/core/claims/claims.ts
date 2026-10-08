import YAML from "yaml";
import { Claim } from "../model/claim.js";
import { ParseError } from "../model/errors.js";
import { parseTargetRef, type ParsedTarget } from "../address/refs.js";

/**
 * Claims model (DESIGN §6.2, §6.3, §6.5): claim files, target overlap,
 * staleness, double-claim resolution.
 */

export function parseClaimFile(text: string, path?: string): Claim {
  try {
    return Claim.parse(YAML.parse(text));
  } catch (e) {
    throw new ParseError(`invalid claim file: ${(e as Error).message}`, path);
  }
}

export function claimToYaml(claim: Claim): string {
  return YAML.stringify(claim);
}

/** True when `pattern` is undefined (whole resource) or a bare absolute path. */
function staticBase(t: ParsedTarget): string {
  if (t.pattern === undefined) return "";
  const m = /[*?[\]{}]/.exec(t.pattern);
  if (!m) return t.pattern; // exact path — base is the path itself
  const raw = t.pattern.slice(0, m.index);
  // keep whole path segments only
  return raw.endsWith("/") ? raw : raw.slice(0, raw.lastIndexOf("/") + 1);
}

/** Segment-aware prefix check: does path `p` start with base `b`? */
function underPrefix(p: string, b: string): boolean {
  if (b === "") return true;
  return p === b.replace(/\/$/, "") || p.startsWith(b.endsWith("/") ? b : `${b}/`);
}

function targetsOverlapOne(a: ParsedTarget, b: ParsedTarget): boolean {
  if (a.resource !== b.resource) return false;
  if (a.pattern === undefined || b.pattern === undefined) return true; // whole resource
  const baseA = staticBase(a);
  const baseB = staticBase(b);
  // conservative: overlap when either static base contains the other
  return underPrefix(baseA, baseB) || underPrefix(baseB, baseA);
}

export interface OverlapResult {
  overlap: boolean;
  /** The pair that collided: [mine, theirs]. */
  via?: [string, string];
}

/**
 * Do two target lists collide? Conservative: false positives acceptable,
 * false negatives are bugs (DESIGN CR-0008).
 */
export function targetsOverlap(mine: string[], theirs: string[]): OverlapResult {
  for (const m of mine) {
    for (const t of theirs) {
      try {
        if (targetsOverlapOne(parseTargetRef(m), parseTargetRef(t))) {
          return { overlap: true, via: [m, t] };
        }
      } catch {
        return { overlap: true, via: [m, t] }; // unparseable → assume overlap
      }
    }
  }
  return { overlap: false };
}

/**
 * Double-claim resolution (DESIGN §6.5): earliest claimed_at wins; ties break
 * on machine name then holder. Deterministic regardless of input order.
 */
export function resolveDoubleClaim(claims: Claim[]): { winner: Claim; losers: Claim[] } {
  const sorted = [...claims].sort(
    (a, b) =>
      a.claimed_at.localeCompare(b.claimed_at) ||
      a.machine.localeCompare(b.machine) ||
      a.holder.localeCompare(b.holder),
  );
  return { winner: sorted[0], losers: sorted.slice(1) };
}
