# The template language

Everything you type into a `.docx` to make it a template. The same syntax works in an HTML
template.

## The four shapes

```text
{{ name }}                         a value
{{#findings}} … {{/findings}}      a loop, or a condition
{{^findings}} … {{/findings}}      the inverse: shown when there are none
{{@rich.description}}              rich text, as real Word formatting
```

A leading dot is optional and means the same thing: `{{ .title }}` and `{{ title }}` are identical.
Spacing inside the braces never matters — `{{#findings}}`, `{{ #findings }}` and `{{ # findings }}`
are one tag, and an opening tag written one way still pairs with a closing tag written another.

## Values and rich text

Most fields have both forms:

```text
{{ description }}         the words, as plain text
{{@rich.description}}     headings, lists, tables, code, screenshots
```

The rich form is what makes a report look like a report. It uses **your template's own styles** —
Heading 2, Quote, your caption style — and falls back to direct formatting for any style your
template does not define, rather than silently losing the heading.

> [!warning]
> A raw tag like `{{@rich.description}}` must be **the only thing in its paragraph**. Word replaces
> the whole paragraph with the formatted content, so anything sharing that line disappears with it.

## Loops

```text
{{#findings}}
{{ $number }}. {{ title }} — {{ severity }}
{{/findings}}
```

Inside a loop, the fields belong to the item. Outside it, `{{ title }}` is the engagement's.

Put the opening tag in the first cell of a table row and the closing tag in the last, and Word
repeats **that row** once per item — which is how a findings table is built.

Every loop also gives you:

| Tag | Is |
| --- | --- |
| `{{ $number }}` | 1-based position |
| `{{ $index }}` | 0-based |
| `{{ $total }}` | how many there are |
| `{{#$first}}` / `{{#$last}}` | conditions for the ends |
| `{{@$pageBreakExceptLast}}` | a page break between items and not after the last |

That last one matters more than it sounds: a plain page break inside a loop gives you a blank final
page, every time.

## Conditions

A section over a value shows its contents when the value is there:

```text
{{#kickoff.held}}The kickoff took place on {{ kickoff.heldOn }}.{{/kickoff.held}}
{{^findings}}No issues were identified during this assessment.{{/findings}}
```

> [!note]
> A section over a **scalar** is a condition and does not change scope. Inside
> `{{#isPriced}}…{{/isPriced}}` you are still at the top level, so write `{{ price.netText }}`, not
> `{{ netText }}`.

## Filters

Filters use a pipe and can be chained:

```text
{{ tester | initials }}                          Iulian Schifirnet → I.S.
{{ date_start | date:'dd MMMM yyyy' }}           12 August 2026
{{ date_start | fromTo:date_end }}               12 – 16 August 2026
{{ findings | count:'severity':'High' }}         3
{{ findings | select:'title' | join:', ' }}
{{ reference | default:'N/A' }}
```

### The ones worth knowing

| Filter | What it does |
| --- | --- |
| `date` | Formats a date. `yyyy yy MMMM MMM MM M dd d EEEE EEE HH mm ss` |
| `fromTo` | A range said the way people say it — the shared parts printed once |
| `default` | A fallback when a field is empty |
| `where`, `sortBy`, `groupBy` | Narrow, order and group a list |
| `count`, `sum`, `length` | Totals, with or without a condition |
| `select`, `unique`, `map`, `join` | Pull one field out of a list and shape it |
| `lines` | Splits a value into lines you can loop over |
| `initials`, `upper`, `title`, `truncate`, `pad`, `fixed` | Text tidying |
| `toJSON` | What the tag actually holds — for working out why something prints nothing |

`groupBy` gives each group a `key`, a `label`, a `count` and its members, and severity groups come
back in **severity order** rather than alphabetically:

```text
{{#findings | groupBy:'severity'}}
{{ label }} ({{ count }})
{{#value}}{{ identifier }} {{ title }}{{/value}}
{{/findings | groupBy:'severity'}}
```

### Filters that produce Word markup

`link`, `mailto`, `bookmark`, `bookmarkLink`, `ref` and `pageRef` emit real WordprocessingML —
hyperlinks, bookmarks, cross-references Word keeps up to date. They go in a **raw** tag and need
`| p` at the end, because a raw tag replaces its whole paragraph:

```text
{{@ name | link:url | p }}
{{@ title | bookmark:reportId | p:'Heading2' }}
{{@ 'see the TLS finding' | bookmarkLink:'VULN-02' | p }}
```

Everything a filter emits is escaped, so a client called *Smith & Sons* cannot break the document.

## Charts

Two tags draw the severity breakdown as a picture, so a template does not have to be built out of
Word's own charting parts:

```text
{{@rich.severityChart}}   a ring, one arc per severity, sized by share
{{@rich.severityBar}}     the same numbers as one line of coloured segments
```

Both are raw tags, so each must be alone in its paragraph.

The colours are the ones set under **Settings → CVSS**, so the picture agrees with the severity
table beside it. Each prints its own legend underneath, and the legend is **real text** in the
template's own font — selectable, searchable and correct at any zoom, because the drawing itself
contains no lettering at all. It is drawn at twice its printed size, which is what keeps the curve
of the ring a curve on a 300dpi printer.

An engagement with no findings prints nothing rather than an empty ring, so guard the heading above
it if that should go too:

```text
{{#stats.total}}
Findings at a Glance
{{@rich.severityChart}}
{{/stats.total}}
```

Both shipped starters print the ring under *Findings at a Glance*. Delete the placeholder if you
would rather have the table on its own.

## What is available

The full vocabulary is in the app under **Templates → Tag reference**, grouped and searchable, and
it is generated from the same definition the renderer uses — so it cannot drift from what actually
works.

The groups, for orientation:

- **Engagement**, **Document control**, **Company**, **Client contact**, **People**
- **Findings** and **Grouped findings**, **Conditions**, **Statistics**
- **Sections**, **Scope**, **Test checks**, **Custom fields**
- **Signatures**, **Scope changes**, **Delivery record**, **Effort**
- **Phishing campaign**, **Detection**
- For proposals: **The proposal**, **Us**, **Them**, **Effort and dates**, **The kickoff**,
  **Retainer**, **The price**, **Billing**

## The one trap worth knowing about

Word splits a run wherever its spell checker sees fit, and a tag is a likely place. Open a template,
save it, and `{{ stats.total }}` may be `{{ stats.total` in one run and ` }}` in the next, with
proofing markup in between.

The app puts those back together before rendering — a tag split across runs still resolves, and
keeps its formatting. You do not have to do anything about it. It is mentioned here because it is
the reason a template that "looks right" can behave oddly in other tools, and because it is checked
by the test suite on every change.
