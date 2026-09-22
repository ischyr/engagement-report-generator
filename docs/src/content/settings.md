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
| **One finding per page** | Every write-up starts at the top of a page |
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

### Tables

The same, on Word's own *separate* counter: a table you have named prints as *"Table 3 — Hosts in
scope"*, and Table 3 can sit on the same page as Figure 7 with neither number wrong. Own setting,
own word, because the two have different answers — a house whose template numbers its figures may
still want its tables numbered, and a report with three screenshots and eleven tables cares about
this one far more.

Only tables you have **named** are numbered. In the editor, put the cursor in a table and press
**Caption**; the line that appears above it is the name. A table with no caption is left exactly as
it is, which is right for the two-row comparison inside a sentence — numbering those would produce
*"Table 14"* for something no reader will ever look up.

One table names itself: the one the report builds from a step's tool output. Nobody writes that
one, so it takes the step's own words — the tool and what it was pointed at.

### One finding per page

Plenty of houses want every write-up to begin at the top of a page. It is a decision about the
firm rather than about one template, so it is a checkbox here rather than something to remember to
do to every .docx on the instance and to the next one somebody uploads.

It is done to the template, just before it is filled: the first paragraph of the findings loop —
your finding heading, normally — is given Word's **Page break before** property, and every repeat
of that paragraph inherits it. That is the same thing you would tick by hand in Word's paragraph
settings, and it is deliberately not a page break *character*: a character needs a rule about the
last one or the report ends on a blank page, where the property simply does nothing when the
paragraph is already at the top of a page.

Two consequences worth knowing:

- **Your template needs a findings loop that starts with a paragraph.** Almost all do. One whose
  loop opens straight into a table is left alone and the server log says so, rather than a break
  being dropped inside the first cell.
- **The summary table is safe.** Most templates loop over the findings twice — once for the
  contents table at the front, once for the write-ups. Loops inside a table are skipped, and of
  what remains the longest wins, so the chapter is marked and the table row is not.

### Code panes

Two settings under the pane's appearance, and both are about its contents rather than its frame.
Neither applies to the **Template** theme, which exists precisely to hand the pane to your own
`CodeBlock` style.

**Colour the code** is on by default. Requests, JSON, shell commands and queries are coloured by
what they are — the status code, the header names, the flags on a command. Nothing moves: the text
is identical either way, in the same font at the same size, so the worst case is a pane somebody
finds busy. Output nothing recognises stays one colour rather than being guessed at, which is most
tool output. Turn it off for a house style that wants one ink, or for readers who print in
greyscale and would rather have contrast than hue.

**Number the lines** is off by default, and for a reason the other presentation settings do not
have: a reader who selects a pane in Word to copy a command out of it gets the numbers too. Worth
paying when your prose says *"line 14"*; not worth paying for a three-line curl.

A pane that **skips** lines numbers itself whatever this says. That is not the setting being
overridden — it is the pane refusing to claim that lines 1–40 and line 187 ran one after another.
See [marking a line](/enumeration).

**A line too wide for the column wraps where we put the break, not where Word would.** Panes are
drawn as two columns — the numbers beside the code — and the two only line up because they carry
the same number of lines. A line Word decided to wrap gained a row on one side and not the other,
so from the first long line down every number sat beside the wrong line. Since a long line is a
base64 payload, a curl with a token in it or a sqlmap command, that was most panes. The break is
now placed deliberately, at the column, with a blank in the gutter opposite each continuation — a
genuinely empty line still carries its own number, which is what tells the two apart.

Tabs are printed as the spaces a terminal would have shown, on eight-column stops, for the same
reason: a tab in a fixed-width table cell lands on whatever stops the document defines, which is
never the ones the tool that wrote it assumed.

## Assistant

Also off until it is filled in, configured the same way, and doing rather less than the word
usually promises: a first draft of the executive summary, a house-style rewrite of one passage, a
one-line summary of a tool run, and a library match. It writes nothing and decides nothing — every
answer arrives in a dialog for somebody to accept.

The proof of concept and every screenshot are never sent, what is sent is redacted first, and a
restricted engagement is refused unless you separately say otherwise. The endpoint is configurable,
so a model on your own hardware is a preset rather than a fork.

It has [a page of its own](/assistant).

## Editing the same field at once

Off by default, and the only optional capability with nothing to configure — there is nothing to
point it at, because the connection is this app on this origin. Switched on, two people can write
in the same finding, section, note or enumeration step at the same time and see each other's cursor
and text as it is typed. Switched off, the platform behaves exactly as it did before the feature
existed: one writer at a time, the lock that says who has a finding, and the conflict merge if two
people save anyway.

Worth leaving off if your reverse proxy does not pass WebSocket upgrades to `/api/collab` — nothing
breaks either way, but every field would spend a few seconds opening a connection that cannot
succeed before falling back.

It has [a page of its own](/working-together).

## Posting to a chat channel

Off by default. Switched on, the parts of an engagement worth knowing about — a finding written, a
severity moved, a report delivered, the client marking something fixed — arrive in a Microsoft Teams
or Discord channel as they happen, as the same sentence the activity log shows. There is also a
plain-JSON option, signed with a shared secret, for a script or a SIEM.

Groups rather than individual events, because the activity log holds a row for every save: a channel
told about all of them is one somebody mutes on the first afternoon. A finding being edited is only
posted when its severity moves.

The webhook URL is the whole authorisation — anybody holding it can post to that channel as this app
— so it is kept in the vault and never shown again, not even to the administrator who pasted it.

It has [a page of its own](/webhooks).

## Backup and restore

A button for a copy of everything — every document, every screenshot, and the templates, which live
on disk rather than in the database — as one `.tar.gz`. It says how much is here and when a backup
was last taken, whether that was from this page or from the command in cron.

Restoring is three steps on purpose: choose the archive, have it checked and read what it says, then
type the database name to apply it. Both operations need two-factor authentication on your account.

It has [a section of its own](/operations) under Operations.
