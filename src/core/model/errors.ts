/** Typed error hierarchy. Every failure an agent or the human can hit has a code. */
export type TeErrorCode =
  | "CONFLICT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_TRANSITION"
  | "CLAIM_REFUSED"
  | "VALIDATION"
  | "PARSE"
  | "CONFLICT_MARKERS"
  | "GIT"
  | "USAGE"
  | "INTERNAL";

export class TeError extends Error {
  readonly code: TeErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: TeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Optimistic-concurrency version mismatch, or a race the caller should retry. */
export class ConflictError extends TeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFLICT", message, details);
  }
}

export class NotFoundError extends TeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
  }
}

/** Actor is not allowed to perform this action (e.g. agent running a human-only action). */
export class ForbiddenError extends TeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("FORBIDDEN", message, details);
  }
}

/** The (status, action) pair has no arrow in the state machine. */
export class InvalidTransitionError extends TeError {
  constructor(
    message: string,
    readonly from?: string,
    readonly action?: string,
  ) {
    super("INVALID_TRANSITION", message, { from, action });
  }
}

/** claim refused: item already held or a target overlaps another claim. */
export class ClaimRefusedError extends TeError {
  constructor(
    message: string,
    readonly holder?: string,
    readonly machine?: string,
    readonly target?: string,
  ) {
    super("CLAIM_REFUSED", message, { holder, machine, target });
  }
}

/** Schema or plan-graph validation failed. */
export class ValidationError extends TeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION", message, details);
  }
}

/** A file could not be parsed. */
export class ParseError extends TeError {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super("PARSE", message, { path });
  }
}

/** A file contains unresolved git conflict markers; never parse or rewrite it. */
export class ConflictMarkersError extends ParseError {
  constructor(path?: string) {
    super("file contains git conflict markers", path);
    this.name = "ConflictMarkersError";
    (this as { code: TeErrorCode }).code = "CONFLICT_MARKERS";
  }
}
