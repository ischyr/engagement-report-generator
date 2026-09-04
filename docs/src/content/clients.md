# Clients, targets and retainers

## The client book

**Sales → Clients** holds the companies you sell to and the people at them. Contacts are grouped by
company, because a client with fourteen contacts is otherwise a list nobody can read.

A company carries:

- **Name and registered address** — what an NDA and a permission to attack print as the second
  party. A client with no address is flagged before somebody generates a contract with a blank in
  it.
- **Billing** — their day rate, their VAT number, where invoices go, their payment terms, and
  whether they need a purchase order. See [Pricing and invoicing](/pricing).
- **Report settings** — their own severity labels, date format, finding prefix or caption style,
  for a client whose house style differs from your default.

A client cannot be deleted while anything still points at it. The refusal names what.

## The relationship, in order

Every client has a timeline: proposals raised, what was won and why, engagements, reports actually
sent, contacts added. It is assembled from the records themselves rather than kept as a second
copy, so it cannot fall out of step with the pages it summarises.

It is what to read in the thirty seconds before a call, instead of asking a client something they
already told you.

## Where the work comes from

Every proposal can record the channel it arrived through — a referral, an existing client, inbound,
outbound, a partner, an event, a tender — and who or what specifically.

The **Where the work comes from** card counts them, with a win rate *of the decisions* so open
proposals do not drag it down. A 70% win rate on referrals against 8% on cold approaches is the
difference between a marketing budget and a guess, and unlike almost everything else on these pages
it cannot be reconstructed afterwards: six months on, nobody remembers who introduced whom.

"Not recorded" is shown rather than hidden. A tally missing a quarter of its rows with no sign of it
is worse than one that admits the gap.

## Quarterly targets

A manager sets a target per salesperson per quarter, counted in **wins**.

> [!note]
> Wins rather than money, and it is worth saying why: with no rate card, a target in currency would
> be a figure nobody could compute progress against. Once a rate card exists, the money won is shown
> beside the count, and the target can carry a value too.

A win counts under the quarter the client **accepted** in, read from the status history — not the
quarter the paperwork caught up in, which is what a modification date would have given.

Each bar carries a marker showing where the quarter itself has got to. Four of eight is either
exactly on track or in trouble depending entirely on the date, and a bar without that marker cannot
tell the two apart.

## Retainers

Several engagements sold as one agreement — four quarterly tests, two half-yearly retests.

It is two fields on the ordinary proposal form rather than a separate flow, because that is what it
is: the same offer with a schedule attached. Both halves are needed. One engagement every three
months is a one-off with a stray number attached; four engagements with no interval is a wish.

The offer can print it as a sentence rather than two integers:

```text
{{#isRetainer}}{{ retainer.summary }}{{/isRetainer}}
→ 4 engagements, one every 3 months
```

Converting a retainer creates the **first** engagement and sets it to nudge when the next is due.
Four half-built engagements with nobody booked onto them is a surprise; a reminder on the date,
with a button that builds the next one, is the same agreement without the app making commitments on
the team's behalf.

## The programme

A client with more than one engagement gets a **The programme** button on their page. The client
page answers "what have we done for them"; this answers the question a renewal turns on — is it
getting better.

Three things, all derived rather than stored:

- **Findings engagement by engagement**, oldest on the left, stacked by severity. No score is shown:
  the weighting behind "better" exists to order the bars, and a client asked to accept that their
  security is 34 will ask what 34 means.
- **What changed between the last two**: gone, still there, and new.
- **How long things take**, as the median gap between the engagement that reported an issue and the
  one where it stopped appearing.

Two honest limits, stated on the page as well as here. Issues are matched between engagements by
title — the same rule the recurrence check uses — because engagements carry no record of which one
follows which. And an issue that is *gone* is absent, not proven fixed: it may have been out of
scope that time. Both get sharper the day engagements are linked to each other.
