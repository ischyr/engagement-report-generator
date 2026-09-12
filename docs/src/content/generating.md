# Generating and delivering

## Preflight

Before a report is built, the engagement is checked for the things that would embarrass you. Some
are **blockers** and stop the generation; the rest are warnings you can decide about.

| Level | Examples |
| --- | --- |
| **Blocker** | No template assigned · a finding with no title · an incomplete CVSS vector · a finding with no description · testing starts after it ends |
| **Warning** | Placeholder text still in a section · a finding with no remediation · a High with no proof of concept · blank scope rows · test checks not ticked off · the engagement still marked in progress |
| **Note** | No references on a finding · unresolved comments · no engagement reference |

It is deliberately opinionated. Every one of these has been the reason a report went out wrong
somewhere.

## Generating

**Generate report** puts the document in a queue and follows it. The button names the step it is
on rather than spinning, and the download starts when it is finished.

You can close the tab. The render carries on without you, and the next time you open the
engagement the button offers the finished document instead of starting a new one — for twelve
hours, after which the bytes are cleared and you would generate it again. Two people pressing
Generate at the same time queue rather than competing, and pressing it twice yourself joins the
one already running instead of starting a second.

What happens on the way:

1. The template is opened, and its [house style](/house-style) applied if it has a base.
2. Every screenshot the engagement uses is fetched — from a cache after the first render — and
   converted to real Word drawings at your template's column width.
3. The data is built: findings, sections, scope, statistics, effort, deliveries, scope changes,
   detection, signatures.
4. The tags are resolved, including tags Word has split across runs.
5. The document is stamped with where it came from, and Word is asked to refresh its fields on
   open so the table of contents is populated.
6. What was in it is recorded — every finding, section and scope group, hashed field by field — so
   this document can be compared against the next one. See below.

## What changed between two reports

Under **Delivery → How each document was generated**, each render has always said what was
different about *how* it was made: the template version, the app build, the settings in force, and
the counts. "Findings: 12 → 14" is a true and unsatisfying answer, because the question underneath
it is always *which two*.

Every render now also records the report's contents, itemised. A row with changes in it opens to
show both: the production differences as before, and under them what a reader would notice —

```text
+ Session cookie without Secure          finding
~ Stored cross-site scripting            finding   was "Reflected cross-site scripting"   title, score
~ Executive summary                      section   text
− Directory listing enabled              finding
```

Nothing here is a copy of the document: it is about ten characters per field, which is why it can
be kept on every render rather than on the ones somebody thought would matter.

**On the delivery register**, the same thing from the other end. A delivery records the digest of
the file that went out; that digest is matched back to the render that produced it, so any
delivered report can be asked what has changed since. The comparison is against the engagement **as
it stands now**, not against the newest render — editing without generating is the commonest way a
delivered report goes quietly out of date.

It is deliberately exact about not knowing. A delivery recorded without a hash, a file this
instance never generated, or a document from before contents were recorded all say so in as many
words. A register whose whole value is exactness must never answer "nothing changed" when it means
"I cannot tell".

## The handling marking

An engagement's **classification** already decides how long it survives in the trash and whether a
second factor is demanded to open it. It now also reaches the document, which is the one place a
handling marking actually does its job — a marking is for the printed copy somebody leaves on a
desk, not for the database row.

On a **restricted** engagement the shipped template prints `RESTRICTED` in the header of every page
and again in the footer, ahead of whatever else is there. A **standard** engagement is unchanged.

Your own template can do the same with three tags, all of them in **Templates → Tag reference**
under *Document control*:

| Tag | What it gives you |
| --- | --- |
| `{{ .classificationLabel }}` | "Standard" or "Restricted" |
| `{{#isRestricted}}…{{/isRestricted}}` | A block that only appears on a restricted engagement |
| `{{ .classification }}` | The raw value, for a template that maps it itself |

The footer's existing `{{ .custom.classification | default:'CONFIDENTIAL' }}` is untouched and still
comes first — so a firm that already sets its own marking per engagement keeps it, and the app only
*adds* the one it is certain about.

> [!note]
> **Preflight will say if a restricted report is unmarked.** It reads the tags your template
> actually uses — analysed once when the template was uploaded — and warns when a restricted
> engagement is about to be generated from a template that prints none of the three above.
>
> A warning, not a blocker. A firm may mark its documents by a letterhead, a cover sheet or a footer
> typed in by hand, and an app that refused to generate on the strength of a missing tag would be
> both wrong about that and unarguable. What it can honestly say is that it looked and did not find
> one.

## Sending it protected

**Protected**, beside Generate, produces the same report inside an encrypted archive. It is the same
bytes — the same render, the same template, the same figure numbers — with an AES-256 wrapper around
them, because until now the most sensitive document a client receives all year left here as a plain
attachment on a plain mail.

Type a password, or press **Suggest** and get four words from the server. Words rather than
characters on purpose: this password's whole life is being read off one screen and typed into
another, or dictated down a telephone, and `Tz9$kQ2v` is where transcription goes wrong. Four words
from the list it draws on carry more entropy than eight random characters and survive the journey.

> [!important]
> **Nobody here can recover it.** The password is not stored, not hashed and not logged — not by the
> app and not in the delivery record. Send it to the client by some route other than the one
> carrying the file, and keep your own copy if you will need to open the archive again. If it is
> lost, the report is generated afresh.
>
> That is the point rather than a limitation: a passphrase filed beside the record of the document
> it opens is not a passphrase.

The delivery record still gets everything it needs. The `sha256` in the response is the digest of
**the archive** — the artefact that actually leaves — so *Record this as sent* prefills from it and a
client can check what they received against what you sent. The activity log notes that this one left
protected, and nothing more than that.

### What the client needs to open it

7-Zip or WinRAR on Windows, Archive Utility on macOS, or `7z x` on Linux. Worth knowing:
**Windows Explorer's own zip support cannot open AES archives** — a client who double-clicks it in
Explorer gets an unhelpful error, so it is worth a line in the covering mail.

### Why a zip and not a password-protected PDF

Three reasons, all of them about the recipient rather than about us.

- An encrypted zip is the one format every recipient can already open, on every platform, with
  software they have or can install in a minute. No plugin, no key exchange, nothing to be talked
  into.
- The *legacy* ZipCrypto some tools offer is broken — a known-plaintext attack recovers a file like
  this in seconds, and a `.docx` begins with a great deal of known plaintext. This uses AES-256,
  which is the format 7-Zip calls `AES-256 Store`.
- A password handed to the PDF exporter arrives as a command-line argument, which puts it in the
  process list for every account on the server. The archive is built in memory instead.

## Where each document came from

Every generated file carries its provenance in two places.

**Inside the file**, as Word custom document properties — *File → Info → Properties → Advanced*:

| Property | |
| --- | --- |
| `EngyRenderId` | The id that identifies this exact render |
| `EngyGeneratedAt` | When |
| `EngyGeneratedBy` | Who pressed the button |
| `EngyTemplate` | Which template |
| `EngyTemplateVersion` | A fingerprint of the template file itself |
| `EngyBuild` | Which build of the app |
| `EngySubject` | Which engagement |

**In the app**, on the Delivery tab: the same identifiers plus the settings that were in force, and
what changed since the render before it.

> [!tip]
> The template *version* is a hash of the template's bytes, not a number somebody remembers to
> increment. Two renders with different values used different templates, whatever the name says —
> which is usually the real answer to "why does this one look different".

### What changed since the last one

Each row says what moved: the template, its version, the app build, the house style, the date
format, the caption style, whether Word refreshes fields on open, and the counts that went in.

"The last report had a table of contents" is the question this exists to answer.

### Checking a file

**Check a file** on the same card hashes a document in your browser and looks for it among the
renders. Either it is exactly one of them — with who generated it and when — or it is not, which
means it was edited after it was generated or came from somewhere else.

The file never leaves the machine. Identifying a document does not require uploading it.

## Recording a delivery

![The delivery register of an engagement. One row: version 1.0, sent by email to the client contact, the filename, the first characters of its SHA-256 and who recorded it. Below it a panel offering to hash a file in the browser and match it against the versions listed. ](/shots/delivery.jpg "The register, and the thing it is for: drop the document somebody is arguing about into the panel underneath and find out whether it is one of these.")

Generating is not sending. When a report actually goes to a client, **Record a delivery**: the
version, the date, the channel, who it went to, and the SHA-256 of the exact file. The hash of the
document you just generated is offered so nothing has to be retyped.

Months later, "which report do they have?" is answerable, and a file somebody sends back can be
checked against the record.

The delivery record can print in the report itself as a document-control table — see the
**Delivery record** tags.

### Booking the retest while you are here

**Book the retest** on the same form puts a day in the schedule, thirty days out by default, for
whoever ran the job. The reminder that already chases bookings will chase it.

It is on this form because this is the moment the date is obvious and somebody is already
thinking about it. Off by default: plenty of recorded deliveries are drafts and interim versions,
and a schedule that filled itself with retests nobody agreed to would be worse than an empty one.
It is hidden when you are correcting an old row, because that is not a report going out.

## A copy for each recipient

The register answers "is this the file we sent" from its hash. What it cannot answer, when four
people were sent the same bytes, is *which* of them let it out.

**Delivery → A copy each** renders one document per recipient, marked with the name of the person
it is for and hashed separately. They come back as one archive with a list of which hash belongs to
whom, and the delivery is recorded with all of it. Paste the hash of a loose document into the
register later and it names one person.

The marking prints wherever your template puts it:

```
{{#isCopy}}{{ copyLabel }}{{/isCopy}}
```

The starter template has that in the footer, so it reads *Prepared for Marijke de Vries · copy 2 of
4* on every page. A template of your own that does not use the tag still produces traceable
copies — the recipient is in the document's properties and the hash is in the register either
way — and the app tells you so when you make them, because a watermark you believe in and cannot
see is worse than none.

> [!note]
> This is a deterrent, not a control. Anybody can open a .docx and delete a line. What it stops is
> the ordinary case: a file forwarded without a thought.

## Proving it came from you

The register proves which file you sent to anybody who trusts the register. A client who has been
handed an edited copy by a third party, or a report by somebody impersonating you, cannot check a
hash they were given through the same channel as the file.

**Settings → Signing the deliverable → Generate a signing key** fixes that. From then on every
report is signed with a key that never leaves the server, and each render's Delivery tab offers a
small archive holding the signature, the public key and a page of instructions written for somebody
who has never heard of this app. The document itself is untouched: the signature is a separate file,
and a client who ignores it sees no difference.

They check it with one command:

```bash
openssl pkeyutl -verify -pubin -inkey engy-signing-key.pub.pem \
  -rawin -in "report.docx" -sigfile "report.docx.sig"
```

Read the key's fingerprint to each client once, by a route that is not email — a phone call, or a
letterhead. After that every document they are ever sent from here proves itself, and nobody
without the private half can produce a signature their copy of the key accepts.

The private half is encrypted with your `VAULT_KEY` and is never shown, not even to an
administrator. Replacing the key leaves old signatures valid but publishes a different public half,
so the app says how many documents that affects before it lets you.

## Spreadsheets

**Findings → Spreadsheet** exports the findings as `.xlsx`, one row per finding with a summary
sheet. No template needed: a report is a document, this is data.

## Tickets in the client's own tracker

A remediation team that lives in Jira does not want a tracker of ours either — they want tickets in
theirs, and somebody was making those by hand from the spreadsheet.

**Findings → Tickets** exports a CSV in the shape one of three importers wants:

| Tracker | How it lands |
| --- | --- |
| **Jira** | Import as issues and map the columns Jira offers. Anything it does not ask about is ignored, so the extra context is free. Priority becomes Highest to Lowest, the affected assets go in Environment, and each issue is labelled `security`, its category, and its report id |
| **ServiceNow** | Load through an import set and map the columns onto your instance's own fields. The headers are descriptive on purpose — a guess at a particular instance's `u_` field names would be worse than an obvious name |
| **Azure DevOps** | Import as work items. The columns are fields of the `Bug` type in the Agile, Scrum and CMMI processes, which is why the detail goes in Repro Steps rather than Description — a Bug does not have one |

Every ticket's summary carries the report id (`VULN-03: Weak TLS on api.acme.example`) and its body
ends by naming the engagement and the finding. That traceability is the point: a ticket nobody can
follow back to the paragraph it came from is how a remediation argument gets lost six months later.

The severity, the vector and the affected assets are stated in the body as well as mapped onto the
tracker's own fields, because every one of those fields flattens something. Azure DevOps has four
severities and we have five, so an informational finding arrives as "4 - Low" with the word
*None* still in its first line.

> [!note]
> These files are for an importer, not for Excel — the `.xlsx` above is the one for reading. There
> is no byte-order mark, and any value that would otherwise be read as a formula is escaped, since
> a finding's write-up is text somebody typed during a penetration test.

## Looking at it: Render

**Render**, beside Generate, shows the report on screen without downloading anything. It renders
exactly what Generate renders and converts those bytes, so what you are looking at is the document
that would be sent — not an approximation of it. Change a sentence, press Render again, see the
page it lands on.

The panel has the browser's own PDF viewer in it, so paging, zoom, search and print already work.
**Download** takes the PDF; Generate still takes the `.docx`.

The button only appears where the instance can actually make a PDF, which needs a converter.

## The converter

The app produces `.docx` and converts nothing by itself — nothing is bundled and nothing is
installed. Under **Administration → Settings → Rendering a PDF**, point it at one of two programs:

| Converter | Where it fits |
| --- | --- |
| **LibreOffice** | Cross-platform, and the one for a container — add LibreOffice to the image. The command is `soffice` unless it lives somewhere unusual. |
| **Microsoft Word** | Windows only, and Word must be installed for the account the server runs as. It is the program the templates are written for, so its idea of the layout is the authoritative one. |

**Convert a test document** proves it by converting one of the shipped templates — the shape a real
report has, with fields, a contents page and an image — and reports the converter's own words when
it fails. A version check would prove a binary exists and nothing about whether it can produce a
PDF as the account the server runs as, which is where this actually goes wrong.

Leave it on *None* and everything behaves as it always has: Generate downloads a `.docx`, and you
open it in Word to save a PDF.

> [!note]
> A conversion takes seconds, not milliseconds — Word is slower to start than LibreOffice, and a
> hundred-page report with forty screenshots is not fast in either. The timeout is a setting.

## HTML templates

If the assigned template is HTML, the report opens in the browser rather than downloading. Print it
to PDF from there — the evidence is inlined, so the page does not depend on reaching the server, and
no converter is involved.

## How heavy the report will be

Preflight weighs the screenshots an engagement will print, because that is what a .docx weighs to
within the text around it — and because the thing that stops a finished report reaching a client is
usually not its content. Outlook refuses attachments over 20 MB and Gmail over 25.

Past 15 MB it says so as a note; past 20 it says so as a warning, and names the largest capture.
Neither is a blocker — the document is correct, only fat, and that is the author's call. Captures
far wider than the page can print are listed separately, since re-uploading one scales it.

## After it has gone

Sending the report is not the end of the work, and the app no longer behaves as though it is. A
[client link](/client-link) gives the people who have to fix things a private page showing what is
outstanding, and lets them mark what they have done — so the retest starts from a list somebody did
not have to assemble by hand.
