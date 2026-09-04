# Settings

Administrators only, and every change is written to a settings log with who made it and what it
was before — the settings govern every engagement, and until that log existed the review quorum
could be lowered with no trace.

## Your firm

What a contract calls you: legal name, registered address, company number, VAT, the signatory and
their title, and the governing law clause.

This is not the same as branding. An NDA needs a registered entity at an address; the app's own
name in the corner is decoration.

> [!warning]
> Until the legal name is filled in, every generated NDA and permission to attack has a blank where
> your company should be. The Sales dashboard warns about it before somebody generates one, rather
> than after.

## Branding

The name and tagline in the corner, and a logo. Cosmetic, and it is what makes a shared instance
feel like the firm's own.

## Report formatting

Presentation applied to every generated document, unless a client overrides it:

| Setting | |
| --- | --- |
| **Date format** | The pattern the `date` filter uses by default |
| **Caption style** | Which of your template's styles captions use |
| **Finding prefix** | `VULN`, `FIND`, whatever your reports say |
| **Code block theme** | How code panes are drawn |
| **Severity colours** | The five, as hex |
| **Image borders** | On or off, and the colour |
| **Refresh fields on open** | Whether Word repopulates the table of contents when the client opens it |

That last one is the answer to *"the last report had a table of contents and this one does not"* —
which is why it is one of the settings recorded with every render.

## The rate card

Day rate, currency, floor, discount cap, tax and payment terms. See
[Pricing and invoicing](/pricing).

## Review workflow

Whether reports need reviewing before they can be approved, how many reviewers, and whether an edit
after approval clears the approvals it already had.

The last one is a real choice. Clearing them means a signature always refers to the text that was
signed; not clearing them means fewer round trips. The default clears.

## Time off

The holiday allowance and whether somebody's own request needs approving. Time off is what
utilisation is measured against, so it belongs here rather than in a calendar somewhere.

## Retention

How long a deleted engagement stays in the trash before it can be purged, with a shorter window for
restricted work — the material you least want sitting in a trash nobody looks at.

The window is clamped: a setting that let restricted work outlive everything else would invert the
point.

## Per-client overrides

A client can override the severity labels, the date format, the finding prefix and the caption
style. Anything they do not set falls back to these.

## Email

Off until it is filled in, and worth filling in: it is what turns a notification nobody has seen
into one that reaches somebody, and it is how a report gets sent from the engagement with the
delivery recorded for you. Provider presets for Gmail and Microsoft 365, a test send that reports
the mail server's own refusal, and a password that never comes back to the browser.

It has [a page of its own](/email).

### Figures

Captions are numbered — *"Figure 7 — The request"* — and a sentence in the prose can point at one.
Both are Word fields, so the client's own edits renumber correctly. Switch it off, or change the
word, if your template does its own numbering. [More on the evidence page](/evidence).

## Assistant

Also off until it is filled in, configured the same way, and doing rather less than the word
usually promises: a first draft of the executive summary, a house-style rewrite of one passage, a
one-line summary of a tool run, and a library match. It writes nothing and decides nothing — every
answer arrives in a dialog for somebody to accept.

The proof of concept and every screenshot are never sent, what is sent is redacted first, and a
restricted engagement is refused unless you separately say otherwise. The endpoint is configurable,
so a model on your own hardware is a preset rather than a fork.

It has [a page of its own](/assistant).
