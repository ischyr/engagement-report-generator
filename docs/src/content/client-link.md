# The client's own link

The app used to end at the moment the report was sent. What happened next — the client fixing
things, and telling somebody they had — happened in email, and came back as a spreadsheet attached
to a message three months later, if it came back at all.

A client link is the other end of that: a private page showing the engagement's findings, where the
client can mark what they have dealt with. When the retest comes round, its starting list is
already there.

**Delivery → The client's own link → Make a link.**

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

One thing: a finding is fixed, or it is not. That is the claim a client is in a position to make,
and it is the one the retest needs. A finding your team has already moved to *retesting* cannot be
changed from the link — two people are looking at the same row and one of them knows more about it.

## What happens when they mark something

Three things, immediately.

**Everybody on the engagement is told.** A notification lands in the inbox of the creator and every
collaborator, and goes out as email to whoever has that switched on. It opens the finding itself
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

A link can also be made **read-only**, for somebody who should see the position and not change it —
their auditor, a stakeholder.

## The link itself

- 32 random bytes, kept only as a hash. **It is shown once**, when you make it, and cannot be shown
  again — the app genuinely does not have it. Lose it and you make another.
- It expires. A week, a month, three or six — whatever you choose when you make it.
- It can be withdrawn at any time, and stops working immediately.
- It is scoped to one engagement, it cannot read anything else, and it is not a login: the rest of
  the app still refuses it.
- The list shows how often each link has been opened and when it was last used. Not by whom, and
  not from where — the address a client reads their report from is their information, not yours.

> [!TIP]
> Send it the way you send the report. It is a bearer credential: whoever holds the URL can open
> the page, so treat forwarding it the way you would treat forwarding the report.
