# Templates

A template is your `.docx`. The app does not have a house style of its own to impose — the
document's look lives entirely in the file you upload.

## Uploading one

**Templates → Upload .docx.** On the way in it is read and reported on:

- **Detected tags** — every placeholder found in it.
- **Unknown tags** — anything that is not a tag this app can fill. Almost always a misspelling, and
  the moment to catch it: an unknown tag renders empty rather than failing, so the alternative is
  finding a gap in a client's document.
- **Lint** — the same analysis the test render does, stored with the template so the list can show
  at a glance which templates are healthy.

Replacing the file later keeps the same template, the same id, and everything pointing at it.

## Report or paperwork

A template has a **purpose**:

- **report** — attached to engagements.
- **proposal** — an NDA, a permission to attack, an offer, a statement of work, a pre-engagement
  questionnaire. These are attached to proposals and have their own vocabulary of tags.

A proposal template also has a **document type**, which is what stops two NDAs ending up on one
proposal: regenerating replaces the previous file of that type rather than adding a second.

## Making one

Three ways to start.

**Tag your existing report.** Open it in Word and type the tags where the content should go. That
is the whole method — see [The template language](/template-language).

**Start from the shipped one:**

```bash
npm run make:template            # a penetration test report
npm run make:redteam-template    # a red team operation report
npm run make:proposal-templates  # NDA, permission to attack, offer
```

The two report starters are the same paper — same cover, same headings, same palette — with
different chapters:

| | |
| --- | --- |
| `DEFAULT_PENTEST_REPORT.docx` | Organised around findings: summary, scope, methodology, findings in detail |
| `DEFAULT_RED_TEAM_REPORT.docx` | Adds the two chapters a findings list cannot give — **Enumeration** (how the ground was mapped) and **Detection and Response** (whether anybody noticed) — plus social engineering, scope changes during the operation, a coverage table and a distribution record |

Every chapter that only applies sometimes is behind a guard, so the red team starter also works on
an operation with no phishing, no detection log and no enumeration: nothing prints an empty heading.
That means you can keep one template rather than maintaining two.

> [!TIP]
> Both are ordinary Word documents. Restyle them, merge them, take the Enumeration chapter out of one
> and put it in your own — the only rules are to keep the placeholders you want filled in and to
> leave the built-in Heading, List Paragraph, Quote and Caption styles in place.

**Have the app tag one for you.** `npm run tag:template -- <file.docx>` walks a document and
inserts the obvious tags — the title, the client, the dates, a findings loop — leaving the layout
alone. It is a starting point, not a finished template.

## Test render

The button that makes templates workable. It renders your template against a full sample
engagement — findings of every severity, screenshots, tables, a long scope — and tells you:

- which tags resolved and to what,
- which resolved to **nothing**, and why: misspelled, outside its loop, or a field the sample has
  no value for,
- a suggestion for anything one edit away from a real tag,
- the document itself, to download and open.

> [!tip]
> A tag inside a loop is only valid inside that loop. `{{ title }}` at the top level is the
> engagement's name; inside `{{#findings}}` it is the finding's. The test render knows the
> difference and says which scope it read a tag in.

## The playground

**Templates → Playground** is the same idea without the file: type markup, see what it produces
against sample data, and copy the tag you worked out into your document. Useful for getting a
filter chain right without a save-upload-render cycle each time.

## HTML templates

A template can be HTML instead of a `.docx`. It uses the same tags and the same filters, renders in
the browser, and is meant to be printed to PDF.

HTML templates can also **include** each other:

```text
{{> House header }}
```

The named template is inserted before the tags are resolved, so the tags *inside* a partial work
too. A partial that includes itself is reported rather than followed; a name that resolves to
nothing is left visible in the output, because a silently missing letterhead is how a report goes
out wrong and nobody notices.

## Keeping several templates alike

A firm has one letterhead and five documents that share it. Rather than five copies that drift,
a `.docx` template can take parts from another — see [One house style](/house-style).

## What the app never does

It does not edit your template, and it does not write anything back into it. Everything — the
house style, the provenance stamp, the images — is applied to the *render*. The file you uploaded
is the file that stays uploaded.
