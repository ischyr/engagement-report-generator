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
