# Engagements

An engagement is one piece of work for one client: the findings, the scope, the evidence, the
report and everything recorded along the way.

## Starting one

**Engagements → New.** Three things decide what you get:

- **The client.** Their name and registered address end up on the paperwork.
- **The type.** A blueprint rather than a label — it brings the sections that kind of report
  normally has, the checklist your methodology uses, and whether this is a standard test or a
  phishing campaign.
- **The window.** Start and end dates. They print, and they are what the schedule and the
  utilisation figures are measured against.

An engagement can also arrive from the other end, as a proposal a client accepted. Converting one
carries the reference, the client, the contacts and the days that were sold — see
[Proposals](/proposals).

## The tabs

| Tab | What lives there |
| --- | --- |
| **Overview** | Name, dates, team, type, template, custom fields |
| **Findings** | The findings themselves — see [Findings](/findings) |
| **Sections** | The narrative: executive summary, methodology, conclusion |
| **Scope** | Hosts, services and what was in or out |
| **Notes** | Working notes that are not findings yet |
| **Credentials** | The encrypted vault for accounts the client gave you |
| **Evidence** | Screenshots captured with no finding to put them in yet |
| **Handover** | What was done, what is next, what is blocked |
| **Time** | Hours logged, a day at a time |
| **Delivery** | What was sent, to whom, with what hash — and how each file was generated |
| **Signatures** | The sign-off page |
| **Checks** | The methodology, ticked off |
| **Detection** | Whether their side noticed |
| **Documents** | What the client sent you |
| **Activity** | Every change, newest first |

An engagement that has entered the remediation cycle gains a **Retest** tab — as soon as anything
has been claimed by the client, marked as being retested, or recorded as fixed. It stays hidden
while an engagement is still being written, when every finding is open and there is nothing to
retest.

A phishing engagement gains a **Sending list** tab and loses nothing — and so does a red team, because
phishing is the ordinary way in and an operation that starts with a pretext email has a mailing list,
timings and a click rate exactly like a campaign does. The red team report template has always had a
chapter for it, guarded so it stays hidden when there is none.

A tab tied to a kind of engagement also stays once it holds something, whatever the type says
afterwards: a mailing list that vanished because somebody changed a dropdown would look exactly like
data loss.

### Writing the campaign up

**Draft a finding** on that tab writes the campaign up for you: how many the message reached, how
many opened, clicked, submitted credentials and reported it, the timings, a table of the same, and
a breakdown by department when there is more than one. Every number comes from the same summary the
tab is drawn from, so the finding and the figures on screen cannot disagree — which is where a
report that says 38% beside a table saying 31% used to come from.

What it does *not* write is the remediation, and the vector is left unscored. Awareness training and
a reporting button are advice rather than data, and a CVSS vector for a phishing result would be a
number nobody decided; preflight asks for the score, and the library or the assistant can help with
the prose. Drafting twice opens the finding that already exists rather than making a second one.

## Who is on it

An engagement has a **creator**, **collaborators** and **reviewers**. Anybody on it can open it;
only the creator or an admin changes the team. Adding somebody puts it in their list and lets them
be booked onto it.

## States

| State | What it means |
| --- | --- |
| **EDIT** | Being worked on |
| **REVIEW** | With reviewers, waiting for sign-off |
| **APPROVED** | Signed off and frozen |

Approving is what the review workflow gates on — see [Settings](/settings) for the quorum, and
whether an edit clears existing approvals.

## Restricted engagements

Classification is `standard` or `restricted`. A restricted engagement is visible only to the people
on it: it does not appear in lists, in search, or on anybody else's dashboard, and an administrator
who is not on it is refused like everybody else.

> [!note]
> Promoting a finding from a restricted engagement into the shared library is refused. The library
> is readable by everybody with an account, and a write-up carries the client's detail with it.

## Stopping work

**Stop work** puts the engagement on hold and says why. It stays visible with a banner, the
bookings stay, and nothing is lost — it is the honest state for "the client went quiet", which
otherwise gets recorded as an engagement that simply stopped moving.

## Deleting one

**Archive** puts it in the trash. It stays there for a retention window — set under
**Settings → Restore default settings**, and shorter for restricted work — and can be restored
whole. After that a purge removes it and its evidence for good.

While an engagement is in the trash it still holds its findings' numbers, which is why renumbering
is refused until the trash is empty. See [Generating and delivering](/generating).

## Recurring work

An engagement can say it repeats — every three months, every year. It **nudges** rather than
creating: on the date, whoever owns it is told the next one is due, with a button that builds it
from this one. Four half-built engagements with nobody booked onto them is a surprise; a reminder
is not.

Selling several as one agreement is a retainer — see [Clients, targets and retainers](/clients).

## Undo

Deleting a row inside an engagement offers it back. The toast that says what went says *Undo*
beside it, and the offer stands for a few minutes after the toast has gone.

It covers the things that used to be gone for good: an enumeration step — with the whole branch
under it, its command, its output and its write-up — a note, a section, a test check, a credential,
a handover, a kit item, a phishing recipient, a detection event and a scope change. What comes back
is the record itself under the id it had, in the position it was in, so anything that pointed at it
still does.

This is not the trash, which is for whole engagements, holds them for weeks and has a page. An undo
is a correction to something you just did; a record you have to go and find is filing, not an undo.
The window is short on purpose, and the entries go with the engagement if it is ever purged.

## The operation, in one order

Four things on an engagement record dated events: the enumeration tree knows when a step was run,
the detection log knows when an action happened and whether anybody saw it, a phishing campaign
knows when the first person clicked, and the scope changes know when each was agreed. Each of them
is its own tab and its own table in the report, and nothing ever put them in the order they
actually happened in — which is the only order a red team readout can be told from.

The card at the top of the **Detection** tab is that merge, and the red team report prints it as a
chapter called *The Operation*, before the detail chapters that evidence it.

Two sentences come out of it that no single log can produce: how long the operation ran before the
client noticed anything, and the longest stretch in which they noticed nothing. Those are usually
the two lines a readout is remembered for.

A step is placed by when its output last changed, which is the only time the app actually knows.
A step that has been written down but never run has no such time, so it is **left out and counted**
— both the page and the report say how many. Placing it by when somebody typed it up, often days
later, would put a false event in the one table whose entire value is the sequence.

A phishing campaign appears as four moments rather than as a list of people: the pretext going out,
the first click, the first set of credentials, and the first person who reported it to the security
team — each with how many people it applied to. The per-person detail stays on its own tab.

The card opens on the **latest ten** events, with the earlier ones behind **Show more**, which adds
ten at a time. The order on screen is always the order things happened — the window sits at the
recent end of it, because an operation that ran for three weeks otherwise opens on week one. The
report prints the whole thing regardless of what the page is showing.

## Renaming something everywhere

The client renames the staging host on day four, and it is in six findings, two write-ups and a
section. **Rename across this engagement**, on the Overview tab, does that in one go: type what it
says now and what it should say, and it shows you every place it appears — each one named by its
finding and field, with the sentence around it and the change shown in place — before anything is
written.

It reaches finding titles and prose, sections, notes, and enumeration write-ups. It deliberately
does not reach tool output, the commands beside it, or the scope list. The output is what the tool
printed: rewriting a hostname inside it does not correct a record, it falsifies one, and a report
whose appendix has been quietly edited to agree with its prose is worse than one whose prose is out
of date. The scope has its own editor, its own statuses and its own history, and a host is renamed
there deliberately, once. Nor does it touch anything inside a piece of markup, so link text changes
and link targets do not, and a screenshot cannot be repointed by a search for a word in its filename.

There is no undo for it, which is why the preview exists. Deleting a row is reversible because the
row can be held somewhere; a substitution across forty fields is not that shape — the undo would be
a second substitution, which is a different thing entirely once the replacement text already
appeared somewhere. So the list is the safety, and it is worth reading.

A finding somebody else is editing right now is left exactly as it was, and named afterwards so you
can go and ask them. Everything else is written together. If the engagement changed while the list
was open — somebody saved a finding, an import landed — the rename is refused rather than applied to
a list nobody looked at, and you are asked to look again.

## What an engagement sends to the browser

Opening an engagement used to fetch the whole document: every finding's description, impact,
remediation and proof of concept, every note's body, and the entire enumeration tree — on every
page load and again after most saves, in order to draw a tab bar. On a forty-finding engagement
that is about 450 KB; on a real one it is megabytes.

It now sends the same engagement without the prose. A finding arrives with its title, rating,
status, assets and timestamps, plus three things that stand in for the four bodies it left behind:
a `snippet` for the list row, `hasDescription` and its siblings so a draft can still be told from a
finished write-up, and `searchText` — the same prose, flattened and capped at about a screenful —
so searching inside the engagement still works. The enumeration tree is not sent at all, because
the tab that draws it fetches its own.

The write-up is fetched when a finding is opened, and the editors wait for it rather than mounting
empty: an editor reports a change whenever its value moves under it, so mounting empty and filling
it in a moment later would mark the finding edited the instant it was opened. A save in that window
is refused for the same reason.

Anything that genuinely wants all of it asks with `?full=1`.
