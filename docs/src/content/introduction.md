# What Engy Report is

Engy Report turns the work of a penetration test into the document a client pays for — using
**your own `.docx` file as the layout**, not a theme somebody else designed.

You upload the report template your firm already uses. It keeps its cover page, its fonts, its
letterhead, its heading styles and its page numbers. Engy fills in the tags you put in it: the
findings, the scope, the counts, the screenshots, the dates. What comes out is a document that
looks like your firm's, because it is your firm's.

## What it covers

The whole life of an engagement, from the enquiry to the file that leaves the building.

- **Selling it.** Proposals with two audiences — the people who sell and the people who deliver —
  an effort estimate that both sides can see, generated NDAs and permissions to attack, a
  sign-off step, and a record of why each one was won or lost.
- **Doing it.** Findings with CVSS, evidence, checklists, scope, credentials, notes and a handover
  log, with several people working on the same engagement without overwriting each other.
- **Reporting it.** Your templates, a lint that catches a misspelled tag before a client does, a
  test render, a preflight that refuses to let an untitled finding out, and a record of exactly
  what produced every file.
- **Afterwards.** A delivery record with the hash of the file that went out, so "which report do
  they actually have" has an answer months later.

## The idea it is built on

Most reporting tools ask you to adopt their document. This one adopts yours. Everything follows
from that:

- The template is a real `.docx`, edited in Word, by whoever normally edits it.
- Tags are plain text — `{{ name }}`, `{{#findings}}…{{/findings}}` — so a template survives being
  opened, saved and mailed around.
- Rich text becomes real Word formatting: headings that use *your* Heading 2, tables that fit *your*
  page width, screenshots at the size your column actually is.
- Nothing about the layout lives in the app. If the report is wrong, the template is where you fix
  it, and the fix applies to every report from then on.

> [!note]
> There is a second output too. A template can be HTML instead of `.docx`, which the app renders in
> the browser for printing to PDF. The same tags, the same data, the same filters.

## Who each part is for

| Role | What they see |
| --- | --- |
| **Consultant** | Engagements, findings, evidence, checklists, the report |
| **Manager** | The same, plus signing paperwork off and approving a price |
| **Sales** | The pipeline, clients, proposals and invoicing — and nothing else. No engagements, no findings, no clients' reports |
| **Administrator** | All of it, plus users, settings and the rate card |
| **Read only** | Everything they are on, and no way to change it |

A sales account is walled off at the API, not just in the menu: a URL typed by hand gets the same
answer as a link that was never shown.

## What it does not do

Worth knowing before you start.

- **It does not scan anything.** It imports Nmap output and takes findings from your library, but
  the testing is yours.
- **It does not produce a PDF by itself.** A `.docx` is opened in Word and saved as one; an HTML
  template can be printed from the browser.
- **It does not know about money until you tell it.** Prices exist only once a rate card is filled
  in — see [Pricing and invoicing](/pricing).
- **It has no multi-tenancy.** One instance is one firm.

And the smaller edges, worth knowing before they surprise you:

- One locale per report. A library entry can hold several; a report renders the engagement's.
- Evidence is capped at 32 MB per image, with no limit on how many.
- Remote image URLs in rich text are not fetched when the report is generated — paste or upload the
  image instead. If one slips through, a visible marker is left in the document rather than a gap.
- Manual finding order is per engagement, and switching CVSS ordering back on discards it.
- The interface is dark-only and English-only. Contrast is checked against WCAG AA by
  `npm run test:contrast`, which `npm run smoke` runs for you.

## Where to go next

- [Installing and running it](/installation) — Node, MongoDB, the first account.
- [Your first report](/first-report) — engagement to document in about ten minutes.
- [The template language](/template-language) — every tag and filter, and the traps.
