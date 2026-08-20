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

**Generate report** builds the document and downloads it. What happens on the way:

1. The template is opened, and its [house style](/house-style) applied if it has a base.
2. Every screenshot the engagement uses is fetched — from a cache after the first render — and
   converted to real Word drawings at your template's column width.
3. The data is built: findings, sections, scope, statistics, effort, deliveries, scope changes,
   detection, signatures.
4. The tags are resolved, including tags Word has split across runs.
5. The document is stamped with where it came from, and Word is asked to refresh its fields on
   open so the table of contents is populated.

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

Generating is not sending. When a report actually goes to a client, **Record a delivery**: the
version, the date, the channel, who it went to, and the SHA-256 of the exact file. The hash of the
document you just generated is offered so nothing has to be retyped.

Months later, "which report do they have?" is answerable, and a file somebody sends back can be
checked against the record.

The delivery record can print in the report itself as a document-control table — see the
**Delivery record** tags.

## Spreadsheets

**Findings → Spreadsheet** exports the findings as `.xlsx`, one row per finding with a summary
sheet. No template needed: a report is a document, this is data.

## HTML and PDF

If the assigned template is HTML, the report opens in the browser rather than downloading. Print it
to PDF from there — the evidence is inlined, so the page does not depend on reaching the server.

> [!note]
> The app does not produce a PDF itself. A `.docx` is opened in Word and saved as one.
