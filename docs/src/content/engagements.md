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

A phishing engagement gains a **Sending list** tab and loses nothing.

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
