# One house style

A firm has one letterhead and five documents that use it: the report, the NDA, the permission to
attack, the offer, the statement of work. Kept as five separate files, they drift — somebody
updates the logo in the report template and the NDA carries last year's for eighteen months.

A `.docx` template can take parts from another instead.

## Setting it up

Upload the template that owns the look — call it *House base*. It needs nothing but the styling: a
header, a footer, the heading styles, the page setup. Its body is never used.

Then edit any other template and choose **Take its look from**, plus which parts to take:

| Part | What comes across |
| --- | --- |
| **Page setup, headers and footers** | The letterhead and the footer, with the paper size and margins they were drawn for |
| **Heading and text styles** | Headings, quotes, captions, table styles |
| **List numbering** | How bullets and numbered lists are drawn |
| **Theme colours and fonts** | The palette and typeface pair the styles refer to |

## What it does, and when

Inheritance is applied **at render time**, not at upload. Nothing is copied into the child file.

That is the whole point: fix the logo in the base and every document that points at it is fixed,
including the ones generated tomorrow. A child template keeps its own `word/document.xml` — the
part that holds the words and the tags.

> A base owns how a document looks. A child owns what it says.

## The careful parts

**A section break inside your document is left alone.** Only the body-level page setup is adopted.
If your report has a landscape appendix, it stays landscape — straightening that out silently would
be worse than not offering the feature.

**Headers and footers are copied under their own names**, because the child may already have a
`header2.xml` that another section still points at. Their own relationships and any images they
name travel with them, so a letterhead arrives with its logo rather than a hole.

**A base that has nothing to give produces a warning, not a failure.** If the base has no theme
part, the theme is skipped and the render says so. A report is not worth refusing over a
decoration.

## Loops are refused

A template cannot inherit from itself, and A → B → A is rejected when you try to save it rather
than discovered when a render recurses. Chains deeper than a base and its children are refused too:
five documents deep means nobody can say what a template looks like without opening five others.

## Knowing it happened

Every render records which base it took and which parts it used, and the **How each document was
generated** card shows it:

```text
TEMPLATE_ONE  a650cf99c1   house style: ENGY house base   8 findings   1.4 MB
```

That matters more than it looks. Pointing a child at a base changes every document it produces
while the child's own bytes stay identical — so without this, two renders that look completely
different would both be reported as "the same as the one before".

## HTML templates

HTML templates share markup with partials instead — `{{> House header }}` — which is the same idea
in a form that suits markup. See [Templates](/templates). Trying to give an HTML template a `.docx`
base is refused rather than half-applied.
