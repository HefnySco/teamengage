/**
 * Secret scan for discussion transcripts (TE-0157). A transcript lands in
 * the plans git repo, so `capture` refuses a text that holds something that
 * looks like a credential — unless the caller asks to redact it or marks it
 * sensitive. Line-based: each hit names its line and masks the match.
 */

export interface SecretHit {
  /** 1-based line number */
  line: number;
  /** which pattern matched (api_key, token, private_key, …) */
  kind: string;
  /** the match, masked — first few chars, then … */
  preview: string;
}

/**
 * One detector: `re` is a global line regex; `group` names the capture that
 * holds the secret itself (default: the whole match). For
 * `key=value`-shaped patterns the key half is group 1 so redaction keeps it.
 */
interface Detector {
  kind: string;
  re: RegExp;
  group?: number;
}

const DETECTORS: Detector[] = [
  { kind: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { kind: "openai_key", re: /\bsk-(?!ant-)(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "bearer", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})\b/g, group: 1 },
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    kind: "credential",
    re: /\b(api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|private[_-]?key)\b(\s*[:=]\s*|\s+is\s+)["'`]?([A-Za-z0-9._~+/=-]{8,})/gi,
    group: 3,
  },
];

/** Values that are placeholders, not real secrets. */
const SAFE_VALUE = /^(true|false|null|none|undefined|changeme|example|xxx+|\*+|<.*>|\$\{.*\}|\$[A-Z_]+)$/i;

function mask(s: string): string {
  return s.length <= 8 ? s.slice(0, 2) + "…" : s.slice(0, 8) + "…";
}

/** Scan every line; a hit's `preview` is masked — the secret itself never leaves this module in messages. */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const d of DETECTORS) {
      d.re.lastIndex = 0;
      for (const m of line.matchAll(d.re)) {
        const secret = d.group ? (m[d.group] ?? "") : m[0];
        if (!secret || SAFE_VALUE.test(secret)) continue;
        hits.push({ line: i + 1, kind: d.kind, preview: mask(secret) });
      }
    }
  }
  return hits;
}

/** Replace every detected secret with `[REDACTED]`; key names stay so the line still reads. */
export function redactSecrets(text: string): { text: string; hits: SecretHit[] } {
  const hits: SecretHit[] = [];
  const out = text.split(/\r?\n/).map((line, i) => {
    let l = line;
    for (const d of DETECTORS) {
      d.re.lastIndex = 0;
      l = l.replace(d.re, (...args) => {
        const g = d.group ?? 0;
        const secret = args[g] as string;
        if (!secret || SAFE_VALUE.test(secret)) return args[0];
        hits.push({ line: i + 1, kind: d.kind, preview: mask(secret) });
        if (g === 0) return "[REDACTED]";
        return (args[0] as string).replace(secret, "[REDACTED]");
      });
    }
    return l;
  });
  return { text: out.join("\n"), hits };
}
