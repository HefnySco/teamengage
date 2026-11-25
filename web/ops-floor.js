// Ops-floor placement model — pure logic, no DOM, no preact.
// Decides where each item sits and which room each event line belongs to.
// Mirrors the daemon shapes:
//   sessions   ← GET /api/sessions  (src/daemon/api/api.ts; holding lists
//                in_progress claims only, GL-0329)
//   dispatch   ← GET /api/dispatch  (Dispatcher.status(): running, matched,
//                events — src/daemon/dispatch/dispatch.ts)
//   inbox      ← GET /api/inbox     (questions, reviews)
//   history    ← Event stream       (src/core/model/event.ts: ts, actor,
//                session, item, action, from, to, note)

const isReviewerRole = (role) => /review/i.test(role ?? "");
// "ops" counts as a word only — devops, options and props stay coders
const isOpsWord = (w) => /(^|[^a-z])ops([^a-z]|$)/i.test(w ?? "");
const isPlannerWord = (w) => /plan/i.test(w ?? "");

/**
 * What kind of session this is: 'coder' | 'reviewer' | 'planner' | 'ops'.
 * A set role decides. A session with no role resolves by its label, then
 * its agent name — a hand-started reviewer is label "review" or has
 * "review" in its agent name; the same idea gives "plan"/"planner" a
 * planner and an "ops" word an ops session. Anything else is a coder.
 * @param {{role?:string,label?:string,agent?:string}|undefined} s
 * @returns {'coder'|'reviewer'|'planner'|'ops'}
 */
export function sessionKind(s) {
  if (!s) return "coder";
  if (s.role) {
    if (isReviewerRole(s.role)) return "reviewer";
    if (isPlannerWord(s.role)) return "planner";
    if (isOpsWord(s.role)) return "ops";
    return "coder";
  }
  if (/^review$/i.test(s.label ?? "") || /review/i.test(s.agent ?? ""))
    return "reviewer";
  if (/^plan(ner)?$/i.test(s.label ?? "") || isPlannerWord(s.agent))
    return "planner";
  if (/^ops$/i.test(s.label ?? "") || isOpsWord(s.agent)) return "ops";
  return "coder";
}

/**
 * Is this session a reviewer? A set role decides. A session with no role
 * (a reviewer started by hand or by a scout, e.g. agent lens-quick-review,
 * label review) counts as a reviewer when its label is "review" or its
 * agent name has "review" in it.
 * @param {{role?:string,label?:string,agent?:string}|undefined} s
 * @returns {boolean}
 */
export function isReviewerSession(s) {
  return sessionKind(s) === "reviewer";
}

/**
 * Where each item sits right now — one place per item, in this order:
 * a session desk, the dispatch queue (dispatch.matched), then the human's
 * desk (inbox.questions, then inbox.reviews).
 * @param {Array<{id:string,label?:string,holding?:string[]}>} sessions
 * @param {{running?:Array<{id:string,mode?:string,started_at?:string,has_log?:boolean,last_line?:string}>,matched?:Array<{id:string,admission?:{ok:boolean,reasons:string[]}}>}} dispatch
 * @param {{questions?:Array<{id:string,question?:{text?:string,context?:string,options?:string[]}}>,reviews?:string[],accept_waiting?:Array<{id:string,deps:string[]}>}} inbox
 * @returns {{seats:Map<string,Array<object>>,queue:Array<object>,you:Array<object>,placed:Set<string>}}
 */
export function derive(sessions, dispatch, inbox) {
  const running = new Map((dispatch?.running ?? []).map((r) => [r.id, r]));
  const questions = inbox?.questions ?? [];
  const reviews = inbox?.reviews ?? [];
  const questionIds = new Set(questions.map((q) => q.id));
  // an in_review item whose deps are not done refuses accept — the ids ride
  // on the desk card so its popover can hold the accept button off (TE-0231)
  const acceptWaiting = new Map(
    (inbox?.accept_waiting ?? []).map((x) => [x.id, x.deps ?? []]),
  );
  const placed = new Set();
  const seats = new Map(); // session id → [{id, mode, started_at?, has_log?, last_line?}]
  for (const s of sessions ?? []) {
    // a waiting item (open question) is on the human's desk, never on a seat
    const ids = (s.holding ?? []).filter((id) => !questionIds.has(id));
    // a reviewer (or any dispatched child) holds no in_progress claim —
    // its item is the running entry named by its label
    if (
      s.label &&
      running.has(s.label) &&
      !ids.includes(s.label) &&
      !questionIds.has(s.label)
    )
      ids.push(s.label);
    seats.set(
      s.id,
      ids.map((id) => {
        placed.add(id);
        const r = running.get(id);
        // TE-0229: the card carries the run facts a seat shows — the
        // elapsed badge reads started_at, the log peek has_log/last_line
        return {
          id,
          mode: r?.mode || "work",
          ...(r?.started_at !== undefined ? { started_at: r.started_at } : {}),
          ...(r?.has_log !== undefined ? { has_log: r.has_log } : {}),
          ...(r?.last_line ? { last_line: r.last_line } : {}),
        };
      }),
    );
  }
  const queue = (dispatch?.matched ?? [])
    .filter((x) => !placed.has(x.id))
    // the entry passes through whole — admission { ok, reasons } stays on it
    // so the card and the chip can show why dispatch refused it (TE-0224)
    .map((x) => (placed.add(x.id), x));
  const you = [
    ...questions
      .filter((q) => !placed.has(q.id))
      .map((q) => (placed.add(q.id), {
        id: q.id,
        mode: "ask",
        label: "question",
        title: q.question?.text,
        // the whole question — the card's popover renders text, context and
        // the AnswerBox options straight off it (TE-0231)
        question: q.question,
      })),
    ...reviews
      .filter((id) => !placed.has(id))
      .map((id) => (placed.add(id), {
        id,
        mode: "accept",
        label: "accept",
        title: "in review — waits for your accept",
        deps: acceptWaiting.get(id) ?? [],
      })),
  ];
  return { seats, queue, you, placed };
}

/**
 * One feed for the floor logs: dispatch_* events merged with history
 * events, each line tagged with a room — rev for a reviewer role or a
 * review action, you for the human actor, else dev — and, when a session
 * resolves, with the session's resolved kind on `role` (a planner or ops
 * line sits in room dev but keeps its kind). Sorted oldest first.
 * @param {Array<{at:string,kind:string,data?:{id?:string,mode?:string,role?:string}}>} dispatchEvents
 * @param {Array<{ts:string,actor:string,session?:string,item?:string,action:string,from?:string,to?:string,note?:string}>} historyEvents
 * @param {Array<{id:string,role?:string,label?:string,agent?:string}>} sessions
 * @returns {Array<{at:string,kind:string,id?:string,mode?:string,note?:string,room:string,role?:string}>}
 */
export function feed(dispatchEvents, historyEvents, sessions) {
  const sessionOf = (session) => (sessions ?? []).find((s) => s.id === session);
  const out = [];
  for (const e of dispatchEvents ?? [])
    out.push({
      at: e.at,
      kind: e.kind,
      id: e.data?.id,
      mode: e.data?.mode,
      room: isReviewerRole(e.data?.role) ? "rev" : "dev",
      ...(e.data?.role ? { role: sessionKind({ role: e.data.role }) } : {}),
    });
  for (const e of historyEvents ?? []) {
    // a human's line has no session kind — room "you" is its whole tag
    const role =
      e.actor === "human" ? undefined : sessionKind(sessionOf(e.session));
    const room =
      e.actor === "human"
        ? "you"
        : e.action === "review" || role === "reviewer"
          ? "rev"
          : "dev";
    out.push({
      at: e.ts,
      kind: e.action,
      id: e.item,
      note: e.note
        ? e.note.split(":")[0]
        : e.to && e.from !== e.to
          ? `→ ${e.to}`
          : "",
      room,
      ...(role ? { role } : {}),
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
