# Working together

## Filters are links

Every list — engagements, the library, clients, templates, the team, the archive — keeps its
search, its status filter and its tags in the address bar. So a filtered view is a thing you can
reload, bookmark, and paste into a message: `/engagements?state=REVIEW&attention=1` is "the ones
in review that need somebody", and it arrives that way for whoever opens it.

Anything left at its default is not written, so the address stays empty until you actually narrow
something, and then says exactly what you narrowed.

The same goes for the column headings on Users, Templates and the library: clicking one sorts by
it, clicking again reverses it, and `?sort=seen&dir=desc` travels with the link. Blanks stay at
the bottom in both directions — "last signed in, newest first" is asking who was here recently,
not listing everyone who never has.

On an engagement, the severity counts above the tabs are buttons. **Critical 17** opens the
findings list showing those seventeen — and they are counted the way the list shows them, so a
finding scored Critical and reported Medium is under Medium in both places.

## The keyboard

Press **?** anywhere for the list. Briefly:

| | |
|---|---|
| `Ctrl`/`⌘` + `K` | search everything — engagements, findings, notes, clients |
| `Ctrl`/`⌘` + `S` | save whatever is open and unsaved, wherever you are |
| `j` `k` or `↑` `↓` | walk the findings list |
| `Enter` or `o` | open the one under the cursor |
| `e` | open it to write |
| `Shift` + click | tick every finding between this one and the last |
| `Esc` | close a dialog, or put the list cursor away |

The sheet does not open while you are typing, so a question mark in a note stays a question mark.

## Undoing a deletion

Deleting something small no longer asks first. It happens, and a toast offers it back for the next
ten minutes — a note, a question, a section, a test check, a credential, a kit item, a detection
event, a scope change, a handover, an enumeration step, a row of hours, a scratchpad note. What
comes back is the record itself, under its own id and in its old position, so anything that
referenced it still does.

Some things still ask, and deliberately: removing a delivery record, revoking a session or an API
token, purging the trash, deleting a template or a client. Those are decisions rather than
mis-clicks, and for several of them "put it back" would not mean what it says.

Two people on one engagement is the normal case, not the exception. Everything here exists so that
neither of them loses work, and so that neither has to ask the other what they are doing.

## Who is here

The people signed in appear in the sidebar with what they are looking at — not just "online", but
*this engagement*, or *this finding*. It is a heartbeat and a poll, deliberately: no sockets to
keep alive, nothing to reconnect after a laptop lid closes.

**Follow** somebody and your page goes where theirs goes. Useful in a handover call, where the
alternative is reading URLs out loud.

## Editing the same field at once

Finding write-ups, narrative sections, notes and enumeration write-ups are **shared documents**. Two people can be in the same
paragraph, each sees the other's caret with their name on it, and the text converges — there is no
turn-taking and nothing to overwrite.

> [!important]
> **It is off until an administrator switches it on**, in Settings → *Editing the same field at
> once*. One switch, nothing to configure. Off is not a reduced version of the app: it is the app
> exactly as the rest of this page describes it — one writer at a time, the soft lock, the hard
> lock, the conflict merge. Everything from here to the end of this section applies once it is on.

The switch exists for the two cases where the feature is unwanted rather than unavailable: a
reverse proxy that does not pass WebSocket upgrades, where every field would open a connection
that can only fail; and a firm that would simply rather people took turns. It takes effect at once
and for everybody — a browser already open picks it up on the next field it opens, and there is
nothing to restart.

It runs over a WebSocket on the same origin as the app, at `/api/collab`. Nothing is stored there:
the shared document lives in memory while somebody is editing, the text stays in the database as
HTML exactly as before, and everything else — the report, figure numbering, search, preflight —
goes on reading it from there. A room is dropped shortly after the last person leaves and is built
again from the stored text next time it is opened.

One connection per field, per tab — not per time the field appears on screen. Opening a finding
mounts its six shared fields, and the page then re-renders as the finding itself arrives, which
would otherwise mean twelve connections for one person looking at one finding. A field that goes
away keeps its connection for a few seconds in case it comes straight back, which is what makes
switching tabs and moving between findings free rather than a fresh handshake each time.

Who may join is the same question as who may edit. The socket is authenticated with the cookie the
browser already sends, checked against the account and the session, so signing out closes it; the
engagement is loaded through the same visibility rule every page uses; and a read-only account is
refused, because a shared document has no read-only seat.

> [!note]
> **If a WebSocket cannot be established, the app works normally.** There is no HTTP polling
> fallback, on purpose. A shared document that catches up every few seconds is not collaboration,
> it is a slower way to overwrite somebody — and it would be a second transport with its own
> failure modes for a feature only worth having when it is instant. After a few seconds of trying,
> the field quietly becomes an ordinary editor or an ordinary box: one writer, the soft lock below,
> the conflict merge, and saving exactly as it has always worked. Nothing retries in the background
> and nothing is lost. That is the same behaviour an instance with no WebSocket support has had all
> along, which is why it needs no explaining to anybody using it.
>
> Only the first field waits. Every room goes to the same address, so one field failing to connect
> is every field failing to connect, and the rest are told immediately rather than each spending
> its own few seconds looking hopeful — a finding settles into single-writer mode once, not six
> times over. That is forgotten again after half a minute, so a proxy that was being restarted gets
> another chance without anybody reloading the page.

If you are running behind a reverse proxy, it needs to pass WebSocket upgrades to `/api/collab` —
in nginx, `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`.
Without it, everybody simply gets the single-writer editor.

### Which fields

| Shared | Where |
| --- | --- |
| Title, Description, Affected assets, Proof of concept, Impact, Remediation | a finding |
| The text | a narrative section, a note |
| Title, One-line summary, Tool, Target, When, Command, Write-up | an enumeration step |

Two mechanisms sit behind that. A rich-text field has a document, and the shared copy binds to it,
so you get a caret with a name on it where the other person is typing. A single-line box has no
document, so it shares a plain string instead: the names of anybody else in the box appear beside
its label, and their edits arrive as you type without moving your cursor to the end of the line.

Two things are deliberately **not** shared. **Tool output** is a record of what a tool printed, and
people do not co-write a record; it keeps the ordinary single-writer behaviour. And the **CVSS
vector** is not prose at all, it has its own control.

> [!note]
> Saving is unchanged: whoever presses save writes the text, and because everybody's copy has
> already converged, that is the same text. If two people save the same finding within a moment of
> each other the second still gets the ordinary conflict dialog, where the two versions will be
> identical.

## Soft locks

![A banner across the top of a finding reading "Anyone can edit this finding. Lock it while you rewrite something, so nobody saves over you", with an optional text box for what you are doing and a Lock for editing button.](/shots/lock.jpg "Nothing is locked by default. The lock is something you take for a few minutes, and it says who has it and why.")

Open a finding somebody else is in and the page says so, with their name. Nothing is blocked — most
of the time two people looking at the same write-up is fine, and a warning is enough.

## Hard locks

When it is not fine, **lock** the finding. While you hold it:

- everybody else can read it, comment on it and see who has it,
- nobody else can save it, delete it, merge it, or move it,
- the list shows the lock, so "taken" is visible before somebody reads the whole write-up.

Add a note — *rewriting the impact* — and it shows beside your name.

A lock **lapses** when its holder goes quiet. Both halves have to be stale: the lock was taken an
hour ago *and* the holder has not been seen for an hour. A lock taken seconds ago by somebody whose
browser is closed is still a lock; one from this morning by somebody who went home is not.

A lead or an administrator can force a lock off. A consultant cannot — otherwise it is not a lock.

## When two people save the same thing

Every write carries the version it was based on. If the record moved underneath you, the save is
**refused** rather than applied, and you are shown a three-way merge: what you wrote, what is
there now, and what you both started from, field by field. You choose per field and save again.

That is the important part: your text is never silently replaced, and neither is theirs.

## Seeing changes without reloading

Pages poll a small fingerprint of the engagement — the counts and what changed — and refetch only
when it moves. A colleague signing a document off, or adding a finding, shows up within seconds
without a reload.

It never interrupts you. If you have unsaved work in an editor, the page tells you there is
something new and waits for you to finish rather than pulling the ground out.

## The handover log

**Handover** is three questions: what was done, what is next, what is blocked. It is what the
person picking the engagement up tomorrow reads, and what a lead reads on Monday.

Notes and evidence sit beside it for the same reason: they are the three things a tester produces
*during* a test rather than for it.

## The activity log

Every change to an engagement, newest first, with who made it and which fields moved. It is also
what the calendar above it is built from — when the engagement was actually worked on, and the
week it went quiet.

The feed shows five at a time, then five more; a filter narrows it to findings, sections, the team
and so on, and clicking a day on the calendar shows that day.

## Assigning work

Test checks have an owner, so a methodology can be split between two people without a conversation
about who is doing what. Findings have one too, so the writing can be split the same way. A
notification goes to whoever is assigned — one for a batch, not one per item, because splitting an
engagement is a single decision and a bell that rings twenty times stops being read.

Only people on the engagement can be given either. Somebody who cannot open it cannot do the work,
and an assignment pointing at them would sit in a queue they never see.

"What have I got left to write up" is answered on the **Inbox** page, which lists every finding
that is yours across every engagement, worst first, above the checks and the comments — writing a
finding is hours, and a comment is minutes.

**Verification** is the same page read from the other side: not what needs you, but what a *client*
has been waiting on — a finding they marked fixed that nobody has retested, a question they asked
through their link that nobody has answered. See [The client link](/client-link).

## Right now

**Right now** in the sidebar is presence, aggregated: who is in which engagement at this moment and
which part of it they have open, who is not here and when they were last seen, and — the part that
changes what somebody does next — which open engagements nobody has been near.

The Team page is a different question. That one is roles and skills, and changes monthly. This
refreshes every half minute and is worth opening when you are running more than one engagement at
a time.

An engagement somebody is in right now is never listed as quiet, whatever its timestamp says. The
rest are ordered longest-untouched first, and anything past ten days is marked, because that is the
point at which "we are getting to it" stops being true.
