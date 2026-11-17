# Incidents and self-repair

Status: design proposal, not built. Owner: Pete. Date: 2026-11-17.
Work items: `docs/PLAN.md`, "Phase 5: incidents and self-repair" (T260 on).

## The ask

Pete, 2026-11-17, after T254: "have Fable design a system that could
auto-diagnose and fix issues like this as soon as they happen. When an error
occurs, an event should reach an agent that can search logs and Mindbody and
diagnose and (if possible) fix all automatically".

## What happened, and what it cost

At 1:23 PM a teacher sold Ed Walugembe (100036799) a 1 Month Unlimited and a
Mat Rental, $201.99 on card. Sale 428877 was whole: both lines, one payment.
The app said otherwise. `purchasedMatches` refused a Product line whose
entry read `IsService: true`, which live Mindbody reports for every retail
product, so T103's rail answered "The payment went through and nothing was
sold", and then the app did three things on that false verdict:

1. told the teacher, in red, that a student's $201.99 was gone;
2. wrote that sentence on the student's Mindbody Notes, signed (T62);
3. held the client against any further charge (T253) and locked Finalize.

Everything after that was done by hand. Pete photographed the screen and
asked a Claude session what happened. That session needed about five reads:
the sale by id, the item entries, `purchasedMatches`, the T103 review that
added the veto, and the fake that reported `false` where live reports
`true`. Then a code fix (T254), a sweep of 29 other sales for the same false
sentence, and two repairs left for humans: delete the Notes line in
Mindbody, tap Understood at the counter.

Nothing in that chain needed a person's judgment until the merge. The
evidence was all in one Mindbody read, the app already knew it had just made
a serious claim, and the two repairs were the app undoing its own writes.
What it needed was for the event to reach something that could read, at the
moment it happened, instead of when Pete next looked at his phone.

CLAUDE.md already says which way this failure cuts: "a FALSE refusal tells a
teacher at the counter that the money is gone and nothing was sold, which is
worse than the bug this rail catches." This design is the machinery for
catching the app's own verdicts being wrong, fast, and taking back what it
did on them.

## The shape of the answer

Four pieces, in the order an incident travels:

1. **The record.** At the moment a route decides a serious outcome, it
   raises an incident: one console line, always and first, and one row in an
   `incidents` table. The row carries the evidence the route already had in
   its hands (the ticket, the sale read, the verdict, what the app then
   wrote), so a restart cannot lose it the way the call log is lost.
2. **The outbox.** A dispatcher in the same process pushes the incident's
   ID, and nothing else, to an endpoint that starts a fresh Claude Code
   cloud session. Fire and forget: the counter's answer never waits on it.
   At the same instant a plain alert goes to Pete directly, so he hears even
   if every agent is down.
3. **The investigator.** A session with the repo, git, GitHub, and one
   narrow door into this app (`/api/agent/*`). It reads; it cannot write to
   Mindbody, and it holds no Mindbody credential, no Railway token and no
   database URL. It follows a playbook, posts a diagnosis with its evidence
   and a confidence, and may ask the app for a repair by NAME.
4. **The repair executor.** The app itself. For each named repair the server
   proves the case again with its own fixed code on a fresh Mindbody read,
   takes every id and every word from its own incident row and none from the
   agent, and runs the write through the audited function that already
   exists. The counter iPad learns by asking the server, as it already does
   for holds.

The rule that makes the rest safe, and the one to keep when everything else
here changes:

**The agent adds zero write paths to Mindbody, and must keep adding none.**
It is the customer display's rule (CLAUDE.md, "The display adds zero write
paths"), for the same reason. A student holds the display; text a student
can type reaches the agent. Neither may be a thing that writes. The agent
proposes a repair by its kind and an incident id. The server decides.

## 1. Detection

### What counts

An incident is the app deciding something that is either a claim about
money, or a write that did not land, where being wrong hurts a student or
stops the counter. It is NOT every refusal. A declined card, a promotion
code Mindbody refuses, a pass greyed out, a sign-in that expired, a dry-run
suppression and a 409 `held` are the app working, and at a few hundred sales
a week they would bury the one event that matters.

Ranked by harm. Severity 1 is "money moved wrongly, or we said it did":

| Kind | Sev | Raised where | Why it ranks here |
|---|---|---|---|
| `sold-nothing` (T103) | 1 | `soldNothingAnswer`, `/api/checkout` | The app says money is gone. True or false, somebody is owed something now |
| `partial` (T95, T90) | 1 | the partial answers in `/api/checkout` | Money moved for part of a ticket; the rest is unsold and the screen invites ringing it up |
| `ambiguous` | 1 | `settleCharge` (every money route settles through it) | Nobody knows whether a charge landed. Includes a 5xx, an unreadable 200, a throw after the claim |
| `stale-pending` | 1 | `chargehold.ts`, where a pending hold turns ambiguous (3 minutes, or a restart mid-charge) | The same question with less evidence: the request that knew is dead |
| `walkin-notice` | 1 | `settleCharge`, the walk-in branch | As above for the house client |
| `contract-unknown` | 1 | `/api/purchase-contract`, live purchase | A membership that may or may not exist |
| `total-mismatch` (T75) | 2 | the rehearsal assertion | Nothing charged, but the teacher is stopped and our price disagrees with Mindbody's |
| `giftcard-mismatch` (T102) | 2 | the `Value` / `AmountPaid` assertion | Same, for a gift card |
| `followon-failed` | 2 | after a sale that STOOD: T219 enrolment, the T45/T62 note, the approval record, `/api/visit-payment` answering 502 | The sale is right and something promised with it did not happen |
| `client-write-failed` | 2 | `updateClientAudited` outcome `error`, and `[client-write] UNAUDITED` | A student's record may be half written |
| `foreign-site` (T210) | 2 | `isForeignSiteRefusal` | Every write on this iPad is about to fail |
| `route-threw` | 2 | a wrapper on the write routes | A 500 the code did not choose |
| `basket-unverified` | 3 | the two `[basket] unverified` branches | Not harm. Drift, counted, never delivered one by one (below) |
| `service-fallback` (T49) | 3 | the "Done as the studio account" path | A permission group is wrong |
| `store-quiet` | 3 | `db.ts` once-per-kind failure logs | The app is on fallbacks |

Severity 3 deserves its paragraph because T254 hid there for two months. A
ticket of retail products alone matched nothing, fell into T103's "wrong
sale" carve-out, logged `[basket] unverified` and stood. Every one of those
lines was the bug announcing itself where nobody reads. Severity 3 events
are counted, not investigated one at a time, and a daily digest asks one
question of them: is any kind's rate climbing, or stuck at 100% for a ticket
shape? "Every product-only sale since 2026-09-14 is unverified" is a
sentence an agent would have written in September.

### Where it is raised

Server-side, at the line where the route decides, by the code that holds the
evidence. Not by scraping the log stream afterwards: the console tags
(`[sold-nothing]`, `[basket]`, `[charge-hold]`) are written for a human
reading them and carry a fraction of what the route knew.

One function, `raiseIncident` in a new `src/lib/incident.ts`, on T116's
pattern: the console line (`[incident] {json}`) is printed always and first,
the row is added when `DATABASE_URL` is set, and nothing it does can change
the answer the counter gets. It never throws, never awaits a network call on
the request's path, and is bounded the way `boundedDb` bounds every other
store write.

And one backstop, also T116's (`[client-write] UNAUDITED`): `settleCharge`
is the chokepoint every money route already passes through with a kind, so a
hold that settles as anything but definite, for a ticket no route raised an
incident for, raises a bare one itself, logged `[incident] UNRAISED`. A new
money route that forgets to raise still cannot leave a silent hold.

### What the record holds

| Field | Notes |
|---|---|
| `id`, `at`, `site`, `target` | uuid; the studio's site id, as `charge_holds` has |
| `kind`, `severity`, `route` | from the table above |
| `mode` | dry run (and whose), write guard, sandbox. Decides delivery (below) |
| `git_sha`, `started_at` | the build that made the verdict (`RAILWAY_GIT_COMMIT_SHA`), and when this process started. The investigator reads the code AT THAT SHA, not at HEAD |
| `staff_id`, `client_ids` | the teacher; the payer and T90 recipients |
| `sale_id`, `cart_id`, `hold_ids`, `idem_key` | the handles |
| `ticket` | what was ordered: each line's type, id, quantity, unit price; the tender as T240's fixed WORDS only; the total we expected |
| `verdict` | the route's own structured reason: for T103 the per-line audit (`ours x1 theirs none`), for T75 both totals |
| `sentence` | exactly what the teacher was shown |
| `side_effects` | **every write the app made BECAUSE of this verdict**, each with what is needed to take it back: `{type: "note", clientId, field: "Notes" or "FormulaNote", text: <the exact entry as filed, signature included>, landed}`, `{type: "hold", id}`, `{type: "approval-spent", requestId}` |
| `trail` | the Mindbody calls of THIS request, in order: method, path, status, ms, actor staff id, request and response bodies, each capped |
| `witness` | the second opinion, section 4 |
| `fingerprint`, `case_id` | section 2 |
| `status`, `timeline` | open, investigating, diagnosed, overturned, confirmed, closed; and every action taken on it, by whom |

`side_effects` is the field that makes self-repair possible at all. The app
can only take back what it wrote down that it did, in the words it used.

The trail needs one new piece: the call log records nothing about which
request a call belonged to. `mbtrace.ts` already runs an `AsyncLocalStorage`
through `/api/checkout` to count writes; the same store collects the
request's call records, so the trail is exact, not "the last twenty calls".

**No card data, and nothing an agent could act with.** The trail goes
through the call log's own redaction (card numbers by key and by shape,
CVVs, PINs and their one-shot tokens), and then through three more strikes
that the drawer deliberately does not make:

- **the staff token** (`actorToken`, T109). Pete chose to show it in the
  drawer, to a teacher who is standing at the counter. A record that leaves
  the server for an agent is a different audience: a live token acts as that
  teacher against Mindbody for two hours from anywhere.
- **gift card barcode ids** (T109 also un-struck these for the drawer). A
  barcode is a bearer instrument.
- **free text a student or stranger can author**: `Notes`, `RedAlert`,
  `YellowAlert`, and the address and emergency fields of a client record,
  replaced by a length and a sha256. The investigator almost never needs
  them, the server reads Notes itself when it repairs them, and they are the
  widest door for prompt injection (section 5).

### Where it is stored: an `incidents` table, argued against the charter

The T29 charter: the database holds what Mindbody has no home for, and never
a copy of what it does.

Mindbody has no home for "at 1:23 PM this app decided sale 428877 held
nothing, said so to a teacher, and wrote it on a client". That is our record
of our own verdict and our own actions, the same class as `client_writes`
(T116) and `charge_holds` (T253), both of which the charter already admits
by name.

The `trail` is the part that needs arguing, because a response body from
`/sale/sales` IS Mindbody's data. Three things keep it on the right side:

1. **It is evidence, not a mirror.** It exists only for a request that ended
   in an incident, it is what Mindbody said THEN (which Mindbody itself
   cannot tell us later: a sale read today is today's sale), and no counter
   route may ever read it to serve a screen. The charter's fear is a table
   that tempts someone to answer a query from it. Nothing queries this by
   client or sale to show a teacher anything.
2. **It expires.** `trail` and `witness` are nulled after 90 days; the ids,
   kinds and timeline stay. `client_writes` keeps before and after values
   forever, so this is the stricter of the two.
3. **It is bounded.** One request's calls, each body capped (16 KB), the
   free text struck.

The alternative, raising with ids only and letting the investigator re-read
Mindbody, fails on exactly the cases that matter. An ambiguous charge is
ambiguous because of what the wire did in that second. And T254's whole
diagnosis was one field, `IsService: true`, on an entry in one response.

The charter's other rule holds unchanged: **the app runs fully without
`DATABASE_URL`.** With no database the console line is the record (Railway's
log stream keeps it), delivery runs from memory and is best effort, and no
repair is offered, because a repair without a durable record of what it
undid is exactly what T116 was written to end. A dead database degrades the
same way.

One migration: `incident_cases` and `incidents` (next free number; 20 at the
time of writing, and note that Phase 4's T224 is planned against a number
T253 has since taken).

## 2. Delivery

### The transport: push, with the server as the only sender

The agent plumbing available to Pete's account, at the level this design
depends on it: a Claude Code scheduled task can be FIRED on demand over HTTP,
with a bearer token, starting a fresh cloud session with the task's stored
prompt plus a short run-specific text appended. A task can also run on a
schedule, but the minimum interval is hourly, so a queue the agent polls
cannot meet "within a minute" and push is the only transport that can.
**Unverified from here (U):** the exact fire endpoint and its token, whether
it is callable from a Railway service, the seconds between a fire and the
session's first tool call, and any daily cap on fired runs per plan. Probe
A1 settles all four before T263 is done. Nothing below depends on more than
"an HTTPS POST with a bearer token starts a session and passes it one line".

The flow:

1. `raiseIncident` writes the row with `delivery: pending` and returns.
2. An in-process dispatcher (a timer started on first use, like the display
   hub's sweep) picks up pending rows and POSTs to the fire endpoint.
3. **The text it sends is composed by the server from enums and ids only:**
   `incident=<uuid> case=<hash> kind=sold-nothing sev=1`. No sentence, no
   name, no Mindbody text. The session then asks this app for the incident
   by id. Two reasons. Client data does not go into a third party's trigger
   body beyond need. And the fired text sits next to the agent's
   instructions, which is the last place free text from Mindbody should
   land.

**Rejected: ai-manager as the relay.** It already runs and already talks to
Mindbody, but CLAUDE.md is plain that the two share an API and not a
codebase, with "a different uptime story". An incident path that needs a
second service up is two things to be down. **Rejected: a GitHub issue as
the trigger** (the app opens an issue, a GitHub event starts the session).
It adds GitHub's delivery latency and puts a token that writes to the repo
in the counter's environment. The issue is the investigator's output, not
its input.

### The counter never waits

The request that raised the incident has already answered by the time the
dispatcher looks. The POST has a 5 second timeout and its failure is a row
state, not an error anyone sees. Retries: 15 seconds, 1 minute, 5, 15, then
hourly for 24 hours, then `delivery: abandoned`, logged. The dispatcher
lives in the one server instance, which is the same single-instance
assumption T113 and T253 already make; a restart resumes from the table.

Two things cover the agent service being down for longer:

- **Pete hears anyway.** For severity 1 the dispatcher also posts one plain
  line to Pete's alert channel (section 3) through a channel that needs no
  agent: an incoming-webhook URL. That alert is sent whether or not the fire
  worked, and says which.
- **A daily sweep.** One scheduled task, early morning, starts a session
  that asks the app for incidents still undelivered or uninvestigated and
  works them. It exists for the failure the outbox cannot see: the push path
  itself broken (a rotated token) while the app believes it is retrying.

### Deduplication and rate limits

Thirty identical errors must start one investigation. But thirty false Notes
lines on thirty students need thirty repairs. So two units:

- **An occurrence** is one incident row. It is the unit of REPAIR.
- **A case** is every occurrence with the same `fingerprint` while the case
  is open. It is the unit of INVESTIGATION and of delivery.

The fingerprint is a hash of `kind`, `route`, `git_sha`, and the verdict's
shape with every id, amount and digit run struck ("the sale does not hold
product #" for T254). A new occurrence of an open case increments the case,
is listed on it, and fires nothing. The investigator, already running or
finished, sees the list; a case re-fires only when a new occurrence arrives
after its diagnosis was posted AND the diagnosis said the cause was fixed
(the fix did not hold, which is news).

Limits, all on the server, all settable only in the environment:

| Limit | Default | When hit |
|---|---|---|
| Fires per case | 1, plus 2 re-opens | Further occurrences attach silently |
| Fires per hour, all cases | 4 | The rest wait for the next hour's budget, oldest severity 1 first |
| Fires per day | 10 | One "storm" alert to Pete, direct, no agent: "11 incidents today across 6 cases. Investigations paused until tomorrow or until you resume them." |
| Alert lines per case | 1, then an edit-in-place count at 5, 25, 100 | Pete's phone buzzes once for a burst |

A storm is itself the diagnosis ("everything is failing"), and an agent per
failure is the wrong tool for it. The cap is also the cost cap's first line.

**Only live production incidents fire.** A row raised under dry run, under a
narrowed write guard, or on the sandbox is recorded and shown in the drawer,
and fires only when `POS_INCIDENT_FIRE_ALL=true`, which is how the pipe is
rehearsed (T264, T265) without waiting for a real failure.

## 3. The investigator

### Its inputs

One line: the incident id. Everything else it fetches.

### Where it runs, and what it can reach

A fresh session per fire, so nothing carries from one student's incident to
the next, in a cloud environment of its own, separate from the one Pete's
interactive sessions use. That environment's network allow-list names this
app's host and GitHub and nothing else. **`api.mindbodyonline.com` is not on
it**, which turns "the agent must not write to Mindbody" from an instruction
into a fact about the network (probe A2 confirms a call is refused).

| It can | How |
|---|---|
| Read the incident, its case, the other occurrences | `GET /api/agent/incidents/<id>` |
| Read Mindbody | `GET /api/agent/mindbody?path=...`: the APP makes the call, GET only, on the service account, from an allow-list of paths (`/sale/sales`, `/sale/services`, `/sale/products`, `/sale/contracts`, `/client/clients` by id, `/client/clientservices`, `/client/clientvisits`, `/class/classes`, `/class/classvisits`, `/site/*`), with the same strikes as the trail, capped per incident (80 calls), tagged `actor=agent` in the call log |
| Read the live call log | `GET /api/agent/calllog`: the in-memory buffer, tokens and barcodes struck |
| Read our audit of client writes, and the holds | `GET /api/agent/client-writes`, `GET /api/agent/holds` |
| Read the code at the incident's sha, and its history | the repo, cloned; `git log`, `git blame`, `git show <sha>:path` |
| Record its diagnosis | `POST /api/agent/incidents/<id>/diagnosis` |
| Ask for a repair, by kind | `POST /api/agent/incidents/<id>/repairs` (section 4) |
| Open an issue, push a branch, open a PR | GitHub, with main protected (section 4) |
| Post to Pete | the alert channel |

A thin tsx harness in the repo (`scripts/agent/*.ts`, one file per verb) is
the only way the session calls those routes. That keeps what an unattended
session is permitted to run down to a short fixed list (`npx tsx
scripts/agent/...`, git, gh) instead of arbitrary curl.

**Why the Mindbody reads go through the app, when a session can hold prod
credentials and run tsx against Mindbody directly** (which is how T254 was
diagnosed): Mindbody has no read-only credential. The service account that
reads `/sale/sales` is the one that checks students in and sells passes, so
a session that can read Mindbody directly can write to it, and the only
thing between a confused agent and a real student's account would be its
own good behaviour. Through the app, GET-only is enforced in code the agent
cannot edit at run time. The cost is that the investigator is blind when the
app is down; but then the incident is "the app is down", which Pete's direct
alert covers and no Mindbody read diagnoses. The alternative, a second
Mindbody staff login whose permission group denies every write, is written
down as the fallback and not chosen: nobody has established that such a
group can still read sales.

**The `/api/agent/*` door** is built like the display's: its own credential
that grants exactly that prefix. `requireSession` never looks at it, the
device cookie does not open it, and the whole prefix 404s when
`POS_AGENT_TOKEN` is unset, which is the off switch. On the session's side
the token is a network secret on the cloud environment, attached to requests
for this app's host by the environment's proxy (U, probe A2), so the agent
uses a token it never sees and cannot print.

**Railway logs: not given, deliberately.** A Railway API token that can read
a service's logs can also read its variables, which are every secret this
app has. That is a credential the agent must never hold, so the design does
not depend on the log stream: the incident carries its own request's trail,
and the playbook's fallback for a dead request (a restart mid-charge) is
what a human would do, read the client's sales for that window. If log
search proves necessary in practice, the answer is a log drain into a store
with its own narrow read, not the token (P22).

### The playbook

It lives in the repo, `docs/agent/incident-playbook.md`, and the session is
told to read it from `main`. So the agent's instructions are versioned,
reviewed like code, and cannot be changed by an incident. T254 is its worked
example, step for step:

1. **Claim the case** (`POST .../claim`; 409 if another session holds it).
   Restate what the app DECIDED and what it then DID, from `verdict` and
   `side_effects`. *T254: decided sale 428877 held no product 0003; filed a
   Notes line on 100036799; raised hold H; locked the ticket.*
2. **Read the truth in Mindbody.** The sale by id when there is one;
   otherwise the day's sales, matched on `Sale.ClientId` after the read (the
   endpoint cannot filter by client), then the client's services and visits.
   *T254: `/sale/sales?saleId=428877` holds two items and one $201.99
   payment.*
3. **Compare, and put the incident in one of four boxes.**
   (A) the verdict is FALSE: the world is fine and the app was wrong.
   (B) the verdict is TRUE: money did move wrongly.
   (C) an unknown is now KNOWN: the charge landed whole, or no sale exists.
   (D) cannot tell. Say so; never round D up to A.
   *T254: A. Both ordered lines are in the sale, the payment equals the
   total to the cent.*
4. **Find the line of code that produced the verdict, at the incident's
   sha**, and answer two questions a diagnosis is worthless without: why did
   it decide this, and **why now**. *T254: `purchasedMatches` refuses a
   Product line whose entry says `IsService: true` (T103 review); live says
   true for retail products; the fake said false. Why now: product-only
   tickets fell into the "wrong sale" carve-out and stood unverified, so
   only a pass plus a product reached the refusal.*
5. **Sweep for the others.** Other occurrences of the case; Mindbody sales
   in the window that fit the shape; our `client_writes` rows of the kind
   that filed the sentence. *T254: 29 sales with a rental line and no
   SalesRepId since 2026-09-14; none carries the false sentence.*
6. **Check what the teacher did next.** A second sale for the same client
   after the incident changes everything: a false "nothing was sold"
   followed by a re-ring in Mindbody's own app is a double sale, and that is
   a refund, which is Pete's.
7. **List what did NOT happen because the route stopped.** A sold-nothing
   answer skips everything after it: T219's enrolment, the check-in of a
   "Pay and check in", the comp's note. Each is a proposal, not an action.
8. **Act, per the ladder** (section 4), and no further.
9. **Report** (below). Then stop. The session does not wait for replies.

### Its output, and where Pete sees it

Two places, each for what it is good at:

- **A GitHub issue per case** is the record: the diagnosis, the evidence
  (ids, the quoted fields, file and line at the sha), the sweep, what was
  done and what is proposed. The fix PR links to it. It is where a later
  session reads what was already established, the way `docs/TICKETS.md` is
  today, and the playbook's last step appends the finished case there.
- **One message in a private Slack channel** is the notification, because it
  reaches Pete's phone and he reads it in ten seconds. It is short, carries
  the confidence and the one thing he must do, and links the issue.

Slack over email because a thread per incident keeps the first alert, the
diagnosis and the follow-ups together and email does not; over GitHub's own
notifications because the direct alert must work with no agent and no
GitHub. This is P16: the plumbing does not care which channel it is.

The diagnosis has a fixed form, so Pete learns to read it at a glance and
so a missing section is visible:

    VERDICT    False alarm. The sale is whole.
    CONFIDENCE High. Both lines and the $201.99 payment are in sale 428877.
    WHAT       1:23 PM, Cart screen, 1 Month Unlimited + Mat Rental, card.
               The app said "nothing was sold: the sale does not hold
               product 0003".
    WHY        purchasedMatches (src/lib/sale.ts, at 4e4aceb^) refuses a
               Product line when Mindbody's entry says IsService true. Live
               Mindbody says true for retail products. The fake says false.
    WHY NOW    Product-only tickets were standing unverified; only a pass
               plus a product reaches the refusal.
    WHO ELSE   29 similar sales since 9/14 checked. None affected.
    DONE       Removed the false note from client 100036799's Notes.
               Released their hold. The counter shows the correction.
    FOR YOU    Review PR #18 (the fix). Nothing else.
    NOT DONE   The sale stood, so nothing to refund.

Confidence is one of three words with a stated basis, never a percentage: a
number invites trusting the arithmetic. **High**: the claim is read straight
off Mindbody's answer and the server's own check agrees. **Medium**: read
off Mindbody, but something a second read could change. **Low**: inferred.
Only High may accompany an automatic repair, and it is the server's check,
not the agent's word, that the repair rests on.

Client names in Slack and GitHub: client id plus first name and last
initial ("Ed W., 100036799"). Enough for Pete to know who; less than a
Notes field holds (P20).

## 4. Fixing: the ladder

Pete said "fix all automatically". The honest answer is that "all" has four
different things in it, and how far each can go alone is decided by one
question: **whose state is being changed, and can the change be taken
back?** The app's own writes, made on its own false verdict, are the app's
to take back. A student's attendance and a student's money are not.

| Rung | What | Who acts | Examples |
|---|---|---|---|
| **0. Observe** | Record, deliver, diagnose, report, open the issue | Nobody taps | Every incident |
| **1. Self-undo** | Take back the app's OWN side effects of a verdict the server has re-proven false; tell the truth on a hold | Nobody taps. Two keys (below). Pete is told after | The false Notes line; the hold raised on it; the red block; a finding written onto an ambiguous hold |
| **2. One tap** | A code fix going live; a repair to Mindbody data from a fixed list; undoing a rung 1 action | Pete (or an admin teacher, P18), one 64px tap, in this app or on the PR | Merge the PR; attach the pass that was bought to the visit; run the enrolment that was skipped; check in the student whose "Pay and check in" stopped half way; re-file a note |
| **3. Never** | Anything that moves money, and anything that changes a rail | A person, in Mindbody or Railway. The agent writes the steps | Refunds, returns, a second charge, account credit, gift cards, contracts; dry run, the write guard, the target, PINs, env, deploys |

### Rung 1: the app takes back its own false verdict

This is the rung that would have closed T254 without Pete, so it is the one
to get exactly right.

**Two keys.** A repair runs only when BOTH of these say so, and neither is
trusted to be right alone:

- **The investigator's key.** It has read the case and asks for
  `overturn-verdict` on one occurrence. The request carries an incident id
  and a repair kind. **It carries no client id, no hold id, no text and no
  amount**, because every one of those comes from the incident row the
  server wrote at the time. An agent that has been talked into something by
  a client's name cannot name a different client: there is no field to put
  one in.
- **The server's key: the witness.** A second verifier of "does this sale
  hold what was sold", written separately from `assertBasket` and
  deliberately dumber. It passes only when ALL of these are true on a read
  the server takes itself, fresh, at repair time:
  1. the sale is read by the incident's own sale id, and its `ClientId` is
     the incident's client;
  2. the sale has exactly as many purchased units as the ticket ordered, no
     more and no fewer;
  3. every ordered line pairs with a different purchased item (by `Id` or
     by `BarcodeId`, either, any `IsService`);
  4. the items' amounts sum to the sale's payments, and the payments sum to
     the amount the incident recorded as paid, **to the cent**;
  5. no OTHER sale exists for this client from five minutes before the
     incident to now (playbook step 6: a re-ring makes this a refund case);
  6. the incident is not older than 24 hours, its hold has not been
     acknowledged by a teacher, and nothing in `timeline` has already
     repaired it.

  The witness is loose where `assertBasket` is strict (it would pair pass
  403 with a product numbered 403) and that is acceptable only because of
  line 4: the money equalling the price of exactly what was ordered, in a
  sale with exactly that many items, for that client, is evidence that does
  not pass through the id matching at all. It must never be used to decide
  a sale is BAD. It can only ever say "this alarm was false" or stay silent.

  The witness also runs once at the moment of the verdict, on the sale the
  route has already read (no extra Mindbody call), and its answer is stored
  on the incident. A sold-nothing verdict that the witness disputes at birth
  is marked `disputed`, which changes nothing the teacher sees in the first
  slice and is the basis for T267.

Why two keys, when the witness is fixed code and could run alone in the
same second as the verdict: because fixed code is what was wrong on
2026-11-17. A witness with its own bug, running alone, silently erases true
alarms. An agent running alone can be argued with by text in a client
record. A wrong undo needs both to fail in the same direction on the same
incident. If a year of incidents shows the investigator never once
disagreed with a passing witness, collapsing to one key is a decision Pete
can make then, on evidence (T273).

**What `overturn-verdict` does, in order, each step its own audited write:**

1. **Retract the note.** Through `updateClientAudited`, new kind
   `incident-retract`: read the client's Notes fresh, parse into entries
   (`notesig.ts`), and remove exactly ONE entry whose text and signature
   equal, character for character, the `side_effects` text recorded when it
   was filed. If no entry matches exactly (a teacher edited it, Pete already
   deleted it), **nothing is written** and the report says so. The write
   goes out under the service account, the audit names `agent, incident
   <id>` as who it was for, and the `client_writes` row holds the before and
   after, which is what makes it reversible: putting the entry back is one
   append of a recorded string. On a site with Formula Notes on, the note is
   a dated record with no delete in the API, so the retraction is a second
   note ("Correction: the sale on 11/17 went through. Sale 428877.") and
   the report says the first one stands.

   Nothing is left in its place on Notes. A correction line about something
   that did not happen is noise on a student's record for every teacher who
   opens it for the next five years; the record of the event is the
   incident, the audit row and the issue.
2. **Overturn the hold.** A new settled state, `overturned`, distinct from
   `acknowledged`: acknowledged means a teacher looked and took
   responsibility; overturned means the reason was false. It carries the
   incident id and the sentence the counter will show. It no longer refuses
   a charge. Putting it back is one upsert of the previous state, by id.
3. **Mark the incident** `overturned`, with both keys' evidence on the
   timeline.
4. **Tell Pete**, in the diagnosis's DONE section, with "Undo" as a rung 2
   action for 24 hours.

**Scoping.** T254's cleanup narrowed `POS_WRITE_CLIENT_IDS` to the one
client and ran a script. The executor is narrower than that by construction:
it has no parameter through which a second client could be reached. Dry run
and the write guard apply to it exactly as to any write (a suppressed
retraction is reported as suppressed and the incident stays open), so a
rehearsal on the dummy client under a narrowed guard is the real code path.

**The second rung 1 action: truth on an ambiguous hold.** For an
`ambiguous` or `stale-pending` incident the investigator can usually answer
the question the teacher was left with, by reading the client's sales. The
server re-checks with two reads at least two minutes apart and at least
five minutes after the charge began (a slow checkout can still land), and
then **annotates the hold; it does not release it**:

- "Checked at 1:31 PM: this charge went through. Sale 428877 holds
  everything. Do not charge again."
- "Checked at 1:31 PM: no sale was made and nothing was charged. It is safe
  to ring this up again."

The hold stands until a teacher's Understood, as today. What changes is
that "Check it in Mindbody" has been done for them. Releasing it alone was
considered and refused: "safe to charge again" said by a machine with no
person reading it is one late-landing sale away from a double charge.

### How the counter learns

The screens already ask the server (`GET /api/charge-holds`) when they open
and when the ticket's clients change, and a tab record whose server hold is
gone already lets go. Three additions:

- **While a hold or an unknown outcome is on screen, the screen re-asks
  every 10 seconds** (visible tabs only; one cheap read of our own table, no
  Mindbody call).
- **The answer lists a hold overturned in the last 24 hours**, with its
  resolution, so a tab that reloaded, a second iPad and a Home Screen
  relaunch all see the correction and not merely an absence.
- **An overturned hold replaces the red block with a calm one**, on the Cart
  screen and in the roster's dialog, in `--accent` and not `--stop`:

      Checked: this sale went through.
      Everything was sold. Sale 428877, $201.99.
      The earlier warning was wrong and has been removed
      from the client's notes.
                                        [ Understood ]

  Understood here dismisses; it releases nothing, because nothing is held.
  Finalize and the tender controls unlock when the block changes, and the
  T249 tab record for that outcome is replaced by the correction, which is
  the one new way such a record ends other than its own Understood.

Honesty about timing: a session takes minutes to start, read and decide.
The teacher at 1:23 PM has a student in front of them and class at 1:30. In
the first slice the correction will usually arrive after they have walked
away, and what it saves is the Notes line, the hold that would have refused
the student's next purchase, and Pete's afternoon. Making the red block
itself rarer is T267: when the witness disputes the verdict at birth, show
"We are checking this sale. Do not charge again." in amber, hold the client
as now, and do NOT write on the student's Notes until the check comes back.
That is a change to what a rail says to a teacher, so it is Pete's call
(P19) and not part of the first slice.

### Rung 2: one tap

**A code fix.** The investigator may write the fix on a branch and open a
PR. It may not merge it, and the design says never, not "not yet":

- **Merge is deploy.** Railway redeploys on every push to main, and a
  restart is not free here: T253 turns every charge in flight ambiguous,
  T113's idempotency record and the call log are gone, and sessions survive
  only with both secrets set. An agent merging at 5:25 PM before a full
  5:30 class would manufacture the incidents it exists to fix.
- **There is no CI.** `package.json` has `typecheck` and `build` and no
  tests; the drives run against `scripts/training/fake-mindbody.mjs`, by
  hand. And T254 is the proof that a green run against the fake means
  little: the fake agreed with the bug.
- **The likeliest wrong fix is one that silences the alarm.** The cheapest
  way to stop a false refusal is to weaken the rail.

So main is protected (a PR and Pete's approval; the agent's GitHub identity
cannot bypass it), and what makes Pete's tap a ten-second decision instead
of a review is built up in T268:

1. GitHub Actions on every PR: `typecheck`, `build`, and a fixture suite.
2. **Each incident becomes a fixture**: the recorded live answer (from the
   trail, ids kept, names struck) plus the expected verdict, under
   `fixtures/incidents/`. The fix must turn that fixture and break no other.
   This is the lasting value of the whole phase: the fake drifts from live,
   and every incident drags a piece of it back.
3. The PR body states the rail's behaviour in both directions, as T254 did:
   what newly passes, and what is STILL refused, each with a fixture.
4. A second, separate session reviews the PR adversarially before Pete is
   told, the repo's existing habit ("each behind an adversarial review
   pass"), and its findings are on the PR.
5. A `CODEOWNERS` line for the money path (`src/lib/sale.ts`,
   `chargehold.ts`, `mindbody.ts`, the checkout routes, `incident.ts`, the
   witness, the playbook) so those can never be merged by anyone but Pete,
   whatever is decided later about lesser files.

The report then says when to merge: "Safe to merge now: no class within 20
minutes, no pending holds", read from the app.

**Data repairs in Mindbody.** A fixed list, each one an existing route's own
function, run under the token of **the person who taps**, so `requireActor`,
T49 attribution, dry run and the write guard apply exactly as if they had
done it at the counter: attach a purchased pass to a visit
(`/api/visit-payment`), check in or reverse a check-in (`/api/checkin`),
un-late-cancel, run a skipped T219 enrolment, re-file a note or a document
upload that failed. The investigator proposes with its evidence; the
proposal appears on an admin sheet in this app (and as a link in the Slack
message); the tap runs it and the result is added to the incident.

Why not automatic, when Pete asked for all of it: each of these invents
something on a student's record that no teacher saw happen. CLAUDE.md
overruled its own speed argument for attendance ("Attendance is worth
300-900ms"); a check-in performed by an agent at 1:31 PM for a student who
may have left at 1:25 is that same mistake with no teacher in the room.
They are one tap, and the tap is small.

**Undo of a rung 1 action**: the same sheet, 24 hours.

### Rung 3: never

Refunds and returns, a second charge, account credit, gift cards and
contracts: the agent prepares, a person acts in Mindbody. For a TRUE
sold-nothing the report is a worksheet: the sale id, what was paid and how,
what the student should have, and the exact steps in Mindbody's UI. "Nothing
auto-charges" and "never a refund" (T63) are unchanged by this phase.

Also never: acknowledging a hold whose alarm was TRUE (that is a teacher
saying "I have dealt with this"), the dry run and write guard, the target,
PINs, environment variables, a deploy, a rollback or a restart, promotion
codes, and anything on the customer display.

### The switch

One studio-wide setting, `incident_repairs` in `app_settings`, admin-only,
logged with the staff id: `off` (rung 0 only), `propose` (rung 1 actions are
offered as one-tap items), `auto` (rung 1 runs on two keys). It ships as
`propose`, and Pete moves it to `auto` after the rehearsal in T265. It is a
setting that LOOSENS, so it is a recorded exception in the drawer's sense,
and it fails tight: no database, a store that does not answer, or a row
naming none of the three all mean no automatic repair.

## 5. Guardrails against the agent itself

**Prompt injection through Mindbody.** A client's name, Notes and alerts are
text a stranger can set from the studio's own sign-up page. Layers, outermost
first:

1. The free text is struck from the trail and from every proxied read.
2. The fired text is server-composed from enums and ids.
3. The playbook is read from `main`, not from anything in the incident.
4. And the layer that holds when the first three fail: **there is nothing
   to win.** A fully hijacked investigator can call GET on an allow-list,
   and ask for a repair kind on an incident id. It cannot name a client, a
   text or an amount; it cannot reach Mindbody; it cannot merge. The worst
   it can do is ask for an overturn the witness then refuses, post a wrong
   diagnosis that says "Low" nowhere, or open a bad PR that waits for Pete.

**A wrong diagnosis applied automatically.** Two keys; only the app's own
side effects; exact-match retraction; every step audited with before and
after; Pete told after each one; Undo for 24 hours; and a tripwire: an Undo
by Pete, or a witness refusing a requested overturn, sets `incident_repairs`
back to `propose` by itself and says so.

**Runaway loops.** One claim per case. A session has a wall-clock cap (20
minutes) and a read cap. Incidents raised by `/api/agent/*` routes and by
the repair executor are kind `repair-failed`, which is alerted to Pete and
never fired to an agent, so a failing repair cannot summon a repairer. The
agent's own issue comments and PR events start nothing. The daily and
hourly fire caps bound everything else.

**Cost caps.** The fire caps are the hard limit: 10 investigations a day is
the most the app will ever start. Above that, a monthly figure on the
account that pays (P17). The monthly report (T272) states what was spent.

**Credentials it must never hold**, and where each stays:

| Credential | Stays in | Why |
|---|---|---|
| Mindbody API key, site login, service token | this app | There is no read-only one |
| Any teacher's staff token | this app | Struck from everything the agent reads |
| `POS_SESSION_SECRET`, `POS_PIN_PEPPER`, `DATABASE_URL` | this app | The first decrypts every teacher's token |
| A Railway token | Pete | It reads all of the above |
| The agent token itself | the cloud environment's proxy | Used, never seen |
| A GitHub identity that can merge to main | Pete | Merge is deploy |
| Stripe keys (Phase 4) | this app | And a reader hold is rung 3 |

**What a session's transcript holds.** Client ids, sale contents and first
names pass through an Anthropic-hosted session, as they already do every
time Pete asks a Claude session about a sale. No card data can, because none
is in anything the door serves. Worth saying plainly once (P20).

## 6. Phasing

The first slice is T260 to T265, and its test is today's incident: replayed
from a fixture on the dummy client, it must end with the diagnosis on Pete's
phone, the false note gone, the hold overturned and the block corrected,
with no human. T260 to T264 are worth having alone (rung 0: Pete would have
had the diagnosis at about 1:30 PM instead of asking for it), so the slice
is useful at every step.

| Item | What | Done when |
|---|---|---|
| T260 | The record | A forced sold-nothing leaves a row with the ticket, the sale read, `side_effects` and the sha, and no card digits or token |
| T261 | The witness | Sale 428877's own JSON passes; each planted fault fails |
| T262 | The agent door | GET only, allow-listed, scoped; no other credential opens it and it opens nothing else |
| T263 | Delivery | 30 identical incidents start one fire; a dead endpoint costs the counter nothing |
| T264 | The investigator | A replayed T254 yields the right diagnosis on Pete's phone, with no write |
| T265 | Self-undo | The replay is fully undone with no tap; a true alarm and an edited note are left alone |
| T266 | Truth on an ambiguous hold | Both findings appear on a held ticket; the hold still waits for Understood |
| T267 | The disputed verdict | P19 answered and built |
| T268 | Fix PRs | CI, incident fixtures, the adversarial pass, protected main |
| T269 | One-tap repairs | The admin sheet; each listed repair run under the tapper's token |
| T270 | Wider detection | The severity 2 kinds, and the browser-decided `attach-failed` |
| T271 | The drift digest | A planted "every product-only sale unverified" is called out |
| T272 | Housekeeping | Retention, the drawer's incidents tab, the monthly report |
| T273 | The graduation review | Pete decides, on a year's incidents, whether any rung moves |

Full done-whens are in `docs/PLAN.md`.

## 7. Cost, and what Pete sees

**Volume.** A few hundred sales a week. Nobody has counted how often the
severity 1 outcomes fire today, because nothing records them (T260 is what
will). Plan for two to six cases a month and treat ten in a day as a storm.

**Money.** At Claude Fable 5.2's API rates ($8 per million tokens in, $40
out, cached reads $0.20; read 2026-11-17), an investigation of forty tool
turns over a context that grows to about 150,000 tokens costs roughly $3 to
$6. A fix PR with its adversarial pass is roughly $15 to $30. The daily
sweep is cents. A normal month is therefore **about $30 to $80**, and the
fire caps make a runaway month impossible beyond a few hundred. If the
sessions draw on a subscription Pete already has, the marginal cost is plan
usage, not dollars; which account pays is P17. Mindbody's metered calls are
noise: under 80 reads per incident. The database grows by kilobytes.

**What Pete sees on an ordinary day:** nothing. There is no dashboard to
check and no banner on the counter.

**On the day of an incident:**

- within seconds, one line: "Sold-nothing at the counter, 1:23 PM, Ed W.
  (100036799), $201.99. Investigating.";
- within about ten minutes, in the same thread, the diagnosis in the form
  above, ending in FOR YOU;
- if there is a fix, a PR with a green check, a review, and "safe to merge
  now";
- if something is his to do in Mindbody, the steps.

**What a teacher sees:** in the first slice, the red block as today, and
some minutes later, if it was wrong, the correction in its place. They are
never asked to do anything for the agent, and nothing at the counter waits
on it.

## Rails this phase moves

Each is written down in CLAUDE.md today and is changed by the item that
builds it, in that item's commit:

1. **Every write needs a signed-in teacher** (T50, `requireActor`). The
   retraction is a write to a client with nobody signed in. A recorded
   exception: the service account, the `incident-retract` kind only, only
   text this app filed, only on two keys (T265).
2. **T253: acknowledgement is "the only release before the lapse".**
   `overturned` is a second (T265).
3. **T116: a save never blanks text quietly.** A retraction whose entry was
   the only text leaves Notes empty. It is not quiet (audited, reported),
   but the 409 `blank` rule needs the carve-out named (T265).
4. **T249: a tab's record "stays until that result's own Understood".** A
   server overturn also ends it (T265).
5. **The T29 charter.** `incidents.trail` holds excerpts of Mindbody's
   answers, on the three conditions in section 1, written into `db.ts`
   (T260).
6. **The settings tab's list of looser-direction exceptions** gains
   `incident_repairs` (T265).
7. **T109: the call log shows staff tokens and gift card barcodes.** In the
   drawer, still. Through the agent door, never (T262).
8. **`pos_display` "grants exactly `/api/display/*`"** gains a sibling with
   the same shape (T262).
9. **"Nothing runs on the server's own initiative"**: the dispatcher, and
   the executor acting on an agent's request. Neither charges, and
   **"nothing auto-charges" does not move.**

## Open questions for Pete

- **P16** Where do you want to hear? Recommended: one private Slack channel
  for alerts and diagnoses, GitHub issues as the record.
- **P17** Which Claude account runs the sessions, and what is the monthly
  ceiling?
- **P18** Who may tap a rung 2 repair: you alone, or anyone in
  `POS_ADMIN_STAFF_IDS`?
- **P19** T267: when the second check disputes "nothing was sold" at the
  moment it happens, may the counter show an amber "We are checking this
  sale. Do not charge again." and hold off writing on the student's Notes
  until the check returns?
- **P20** Client first name and last initial in Slack and GitHub, or ids
  only? And are you content that incident evidence (ids, sale contents,
  first names, never cards) passes through a hosted agent session, as it
  does when you ask one by hand?
- **P21** Is two keys with no tap acceptable for taking back the app's own
  false note and hold, once T265's rehearsal has passed in front of you? It
  ships as `propose` until you say so.
- **P22** Do you want the agent to be able to search Railway's logs? It
  needs a log drain, not the Railway token. Recommended: not until an
  incident proves the trail was not enough.
- **P23** Should a retraction leave anything on the student's Notes?
  Recommended: nothing.

## Unverified, and the probes that settle it

| # | Probe | Answers |
|---|---|---|
| A1 | Fire the investigator's task from the Railway service with a throwaway id | The endpoint and token shape, reachability from Railway, seconds from fire to first tool call, and any daily cap on fired runs |
| A2 | From the investigator's environment: call this app with no token in hand, and call `api.mindbodyonline.com` | That the proxy attaches the agent token, and that Mindbody is unreachable |
| A3 | An unattended fired session posts to the Slack channel, opens an issue and pushes a branch | That the connectors and the repo grant work with nobody watching |
| A4 | On dummy client 100042041 under a narrowed write guard: file a T62 note, then send `updateclient` with that one entry removed | That Mindbody accepts shortened Notes, and what a blank one reads back as |
| A5 | Read a sale that mixes a pass, a retail product and a discount, and one paid by split tender | The witness's line 4: that item amounts, payments and our paid figure agree to the cent in each shape, tax included |

A5 matters most. If item amounts and payments do not reconcile to the cent
on some ordinary shape (tax rounding on a split, say), the witness will
stay silent on it, which is the safe failure, and T261 must say which
shapes it covers before T265 leans on it.
