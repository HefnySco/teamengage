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

/**
 * Is this session a reviewer? A set role decides. A session with no role
 * (a reviewer started by hand or by a scout, e.g. agent lens-quick-review,
 * label review) counts as a reviewer when its label is "review" or its
 * agent name has "review" in it.
 * @param {{role?:string,label?:string,agent?:string}|undefined} s
 * @returns {boolean}
 */
export function isReviewerSession(s) {
  if (!s) return false;
  if (s.role) return isReviewerRole(s.role);
  return /^review$/i.test(s.label ?? "") || /review/i.test(s.agent ?? "");
}

/**
 * Where each item sits right now — one place per item, in this order:
 * a session desk, the dispatch queue (dispatch.matched), then the human's
 * desk (inbox.questions, then inbox.reviews).
 * @param {Array<{id:string,label?:string,holding?:string[]}>} sessions
 * @param {{running?:Array<{id:string,mode?:string}>,matched?:Array<{id:string,admission?:{ok:boolean,reasons:string[]}}>}} dispatch
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
  const seats = new Map(); // session id → [{id, mode}]
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
      ids.map((id) => (placed.add(id), { id, mode: running.get(id)?.mode || "work" })),
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
 * review action, you for the human actor, else dev. Sorted oldest first.
 * @param {Array<{at:string,kind:string,data?:{id?:string,mode?:string,role?:string}}>} dispatchEvents
 * @param {Array<{ts:string,actor:string,session?:string,item?:string,action:string,from?:string,to?:string,note?:string}>} historyEvents
 * @param {Array<{id:string,role?:string}>} sessions
 * @returns {Array<{at:string,kind:string,id?:string,mode?:string,note?:string,room:string}>}
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
    });
  for (const e of historyEvents ?? []) {
    const room =
      e.actor === "human"
        ? "you"
        : e.action === "review" || isReviewerSession(sessionOf(e.session))
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
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
