# Working together

Two people on one engagement is the normal case, not the exception. Everything here exists so that
neither of them loses work, and so that neither has to ask the other what they are doing.

## Who is here

The people signed in appear in the sidebar with what they are looking at — not just "online", but
*this engagement*, or *this finding*. It is a heartbeat and a poll, deliberately: no sockets to
keep alive, nothing to reconnect after a laptop lid closes.

**Follow** somebody and your page goes where theirs goes. Useful in a handover call, where the
alternative is reading URLs out loud.

## Soft locks

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
about who is doing what. A notification goes to whoever is assigned.

> [!note]
> Findings themselves have an author but not an assignee. "What have I got left to write up" is
> therefore not yet a question the app answers.

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
