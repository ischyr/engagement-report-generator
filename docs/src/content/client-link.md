# The client's own link

The app used to end at the moment the report was sent. What happened next — the client fixing
things, and telling somebody they had — happened in email, and came back as a spreadsheet attached
to a message three months later, if it came back at all.

A client link is the other end of that: a private page showing the engagement's findings, where the
client can mark what they have dealt with. When the retest comes round, its starting list is
already there.

**Delivery → The client's own link → Make a link.**

There are two kinds, and the first thing the form asks is which one you want.

## A progress link, during the test

The question a client asks on day three is *how is it going*, and the answer used to be an email.
A **progress link** answers it without one: how much of the scope has been reached, how many
findings exist by severity, and which assets still need something from them.

It carries **no finding text whatsoever** — not a title, not a description, not a status. That is
the whole reason it can exist during a test at all. A count is a fact about progress; a draft
finding is somebody's half-written argument, and a client reading one over an author's shoulder is
how a report gets argued about before it is written.

It shows two lists of assets, because both are things the client can act on: the ones not reached
yet, and the ones excluded — each with the note your team wrote for them on the Scope tab. That
field exists for exactly this audience, which is why it is the one that goes out.

Nothing on a progress link can be changed from outside. It is read-only by construction rather
than by a setting, and the page says plainly that it is provisional and that the report is the
record.

## What the client sees

Per finding: the identifier, the title, the severity and score, what was found, and what to do about
it. Nothing else.

In particular, and by design:

| Never sent | Why |
| --- | --- |
| The proof of concept | Payloads, tokens, session cookies and the steps to do it again. They have this in their report, which is a document they control — a link that can be forwarded is not the same thing. |
| Evidence | Images are stripped from the text that does go out. A screenshot is where a password ends up by accident. |
| Anything internal | Notes, credentials, the enumeration, reviewer comments, checks, questions, and who on the team wrote what. |

The text is sanitised on its way out, so nothing in a write-up can run in a client's browser.

## What they can change

A finding is fixed, or it is not. That is the claim a client is in a position to make, and it is the
one the retest needs. A finding your team has already moved to *retesting* cannot be changed from
the link: two people are looking at the same row and one of them knows more about it.

Under each finding there is also a box for **what they did about it**. It saves itself as they type,
it is plain text, and it is the difference between a retest that starts with a question and one that
starts with the work. "Moved the endpoint behind the session check, deployed Tuesday" is the whole
point of the round trip.

### And a screenshot, if you allow it

Off by default. When you issue the link, **let them attach a screenshot** turns it on for that one
client. It is the only place in the app where somebody without an account can send a file, so it is
narrow on purpose:

- images only, checked by their content rather than by what the browser called them
- five megabytes each, six per link, ten attempts an hour
- never on a restricted engagement, whatever the link says
- never on a read-only link, and never on a progress link

What they send lands in the engagement's **evidence bin**, marked as the client's own rather than as
something the team captured, and nothing puts it into a report by itself. A tester chooses to insert
it, exactly as with any other capture.

> [!note]
> A claim is not a verified fix, and neither is a screenshot. Everything the client writes or
> attaches is kept apart from what you found and none of it can reach the document: no template tag
> reaches a client's claim. The retest is still the retest.

## What happens when they mark something

Three things, immediately.

**Everybody on the engagement is told.** A notification lands in the inbox of the creator and every
collaborator, and says whether they explained what they did or attached something, so it is obvious
whether there is anything to read. It goes out as email to whoever has that switched on, and it
opens the finding itself
rather than a list of forty. The log is where you look when you already know to look; a client
acting on a report is news.

**It is on the activity log**, worded so it never reads as though somebody with an account made it:
*"The client (Dana at Northwind) marked VULN-03 as fixed"*. The entry has no actor, because nobody
with an account did it.

**The finding is marked as a claim, not a verification.** `remediationStatus` has three values, and
"the client tells us this is fixed" and "we retested it and it is" would otherwise be the same one —
so a report generated in between would state the second on the strength of the first. The finding
carries who said it, when, and through which link, and the findings list shows a **client says
fixed** badge until somebody on the team moves the status themselves. At that point it is their
call, the claim is cleared, and the badge goes.

So the honest reading of a client link is: it tells you where to look next, and it never decides
anything on your behalf.

## Questions, both ways

The link has always taken what the client *did* — a status, and a sentence about what they changed.
It now takes what they want to **ask**: a box under each finding, for the question they would
otherwise have sent as an email to whoever's address they could find.

The question lands in that engagement's **Questions** tab, marked with the label of the link it
came through, against the finding it is about. Everyone on the engagement is told, the same way
they are told when a client marks something fixed. Whatever you write back appears under the
question on the client's page, so the loop closes where it started rather than in somebody's inbox.

It is behind the same **allow updates** switch as the status box. A question is a smaller write than
a status change and it was tempting to give it a permission of its own, but a firm handing somebody
a read-only link has said what it means; one switch is less to explain and less to get wrong.

An arriving question is **open** and does not print, like any open question — "they asked and nobody
has replied" is a thing to chase rather than a caveat to publish, until somebody settles it.

> [!note]
> The client sees their own questions and your answers, and nothing else from that tab. The
> questions your team asks *about* a client live in the same list, and a planted one is asserted
> against on every run of `npm run test:client-question` and `npm run test:collab` — from the
> client's side of the wall, with the filter deliberately broken to prove the check bites.

## Where the work happens: the Retest tab

The claims land somewhere. Once anything has been claimed, retested or fixed, the engagement grows
a **Retest** tab, and it is four lists:

- **Waiting on you** — every finding still carrying a client claim. A claim survives only until
  somebody here moves the status, so a claim that is still there *is* an unchecked one; the list
  needs no cleverness to build.
- **Being retested** — somebody here is checking these now.
- **Still open** — not fixed, and nobody has said otherwise.
- **Verified fixed** — checked by somebody here, not merely reported as fixed.

Each row says who claimed what and when, or who last moved it. Three buttons record what you found:
**verified fixed**, **not fixed**, or **retesting** while you work. Each writes the move into the
finding's history with your name on it and clears the client's claim — from that point the report
says what you found rather than what you were told.

The badge on the tab counts what is *waiting*, not what is in the cycle: forty verified-fixed
findings are finished work, and a badge saying "40" on an engagement with nothing left to do would
be noise.

> [!note]
> There is deliberately no "verify everything" button. Accepting forty claims in one click is
> exactly the thing the claim/verification split exists to prevent.

## And across every engagement: the Verification page

The Retest tab is one engagement. **Verification** in the sidebar is all of them at once, and it
exists because of how this work actually arrives: a client sits down on a Friday, marks six findings
fixed and asks two questions, and from your side nothing visible happens at all. The claims are in
six Retest tabs and the questions in a Questions tab, each three clicks in, each findable only by
somebody who already suspected they were there.

Two lists, oldest first — the reverse of every other list in the app, because this one is a queue
and the row at the top is the one somebody is about to be asked about:

- **Claims waiting to be verified.** What they said, in their words, with the screenshots they
  attached counted. **Verified fixed** and **not fixed** write through the same route the Retest tab
  uses, so the history and the cleared claim are identical however you got there.
- **Questions waiting for an answer.** Only the client's own — a question your team asked *about* a
  client stays where it was, in the Questions tab, because it is a different conversation.

Filter it to **Mine** for engagements you are on. The page can never show more than the engagements
list would: it is scoped by the same rule, so an engagement you cannot open is one you cannot see
here either, whatever is waiting on it.

Approved engagements stay in the queue. A link refuses new claims and questions once a report is
closed, so anything still sitting there arrived before the close — which makes it exactly the thing
that would otherwise be lost. Those rows say **Approved** and offer no buttons, because the write
behind them is genuinely refused until an admin reopens the report.

A link can also be made **read-only**, for somebody who should see the position and not change it —
their auditor, a stakeholder.

## Sending it

You no longer have to. When you make a link, tick the people it is for — they come from the
contacts on that client, under **Clients & data** — and the app writes to them. The wording follows
the kind: a progress link says nothing is needed from them, a findings link asks what they have
fixed, and both state the expiry, because a client who finds a dead link assumes the report was
withdrawn while one who was told it lasts a month simply asks for another.

The link is still shown to you, whatever happens to the mail, and the card says what the send did —
who it reached, who it could not, and why. An instance with no mail server configured behaves
exactly as before: you get the URL and send it yourself.

There is no *resend*, and there will not be. Only a hash of the token is kept, so the app cannot
show it twice — which is the same reason you cannot recover a lost one. Make another and withdraw
the old.

### Chasing them

On a findings link you can ask the app to remind them about what is still open — weekly,
fortnightly or monthly. It stops on its own: when everything has been marked fixed, when the link
expires or is withdrawn, when the report is signed off, or after five, whichever comes first. The
reminder says how many are outstanding and nothing about what they are, and the last one says it is
the last.

It only works on a link the app sent, because otherwise it has no address. And it is off unless you
turn it on — it is the only thing here that writes to somebody outside your firm without you
deciding to at that moment.

## What a client can ask for

Two things, beyond the questions about a particular finding:

- **Something that is not about one finding** — a change freeze, a host being decommissioned, who
  to talk to about the retest. It lands in the Questions tab with everything else they have said.
- **Reopening a report you have signed off.** Once a report is approved nothing on the link can be
  changed, and the page used to say "tell your contact". It now offers to ask them for you. It does
  not reopen anything: that stays your decision, and the request arrives as a question with a
  notification. Asking twice leaves one request rather than a queue.

The second works even on a read-only link. A reader who may not change the report can still ask a
person for something — and one who cannot even ask telephones somebody instead.

## A link for the client, not the engagement

From a client's own page there is a third kind: one link showing everything you have done for them.
Names, dates, counts by severity, and what is still open across all of it — the question a client
asks at renewal and that previously needed a meeting.

It is the widest thing this app will show to somebody without an account, so it is the most
restricted:

- **Work you have not reported carries no numbers.** An engagement that is not signed off is a name
  and a date. Counting findings on a report the client has not been given would tell them a result
  before you have finished deciding what it is.
- **Restricted engagements do not appear at all**, by name, reference, or in any total.
- **No finding titles or write-ups, anywhere.** Counts by severity, and that is all.
- **Nothing deleted**, and nothing belonging to another client.
- **Nothing can be written through it.** Claims, questions, evidence and reopening all belong to an
  engagement, and this link names none — every one of them is refused.

You can only make one for a client you can already see yourself.

## The link itself

All three kinds work the same way here: the token is 32 random bytes, only its hash is stored, it
expires, and it can be withdrawn. The engagement's activity log says which kind was made, for whom
and for how long — except for a client link, which belongs to no engagement and so has no entry in
one. The link itself is its record.


- 32 random bytes, kept only as a hash. **It is shown once**, when you make it, and cannot be shown
  again — the app genuinely does not have it. Lose it and you make another.
- It expires. A week, a month, three or six — whatever you choose when you make it.
- It can be withdrawn at any time, and stops working immediately.
- It is scoped to one engagement — or, for a client link, to one client's reported work — it can
  read nothing else, and it is not a login: the rest of the app still refuses it.
- The list shows who the app sent it to and when, if it sent it, and whether it is chasing them.
- The list shows how often each link has been opened and when it was last used. Not by whom, and
  not from where — the address a client reads their report from is their information, not yours.

> [!TIP]
> Send it the way you send the report. It is a bearer credential: whoever holds the URL can open
> the page, so treat forwarding it the way you would treat forwarding the report.
