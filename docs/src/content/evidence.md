# Evidence and screenshots

Screenshots are most of what a client actually looks at, and the part of a report most likely to
leak something.

## Getting one in

Paste from the clipboard, drag files in, or use the button. It goes into the rich text where the
cursor is — or, when you drag, where you let go.

**As many at a time as you like.** Select forty screenshots and drop the lot: they upload one after
another, in the order you selected them, each landing as its own numbered figure, with a progress
line saying which one it is on. The order matters and is kept, because the report numbers figures by
the order they appear in it.

One that fails does not stop the rest — you get the other thirty-nine and a message naming what did
not go in. Anything in the selection that is not a picture is counted and ignored rather than
refused, so dropping a folder with a `notes.txt` in it works.

Every image is stored once. Uploading the same screenshot into three findings stores one object and
points all three at it — the app hashes the bytes and recognises them. Replacing it later replaces
it everywhere.

> [!note]
> The *content* decides the type, not the name or the header the browser sent. A shell script
> announced as `image/png` is refused rather than stored and served back as an image.

## Recordings

Some findings are not a screenshot. A race condition, a click-through that only works in one order,
an interface that misbehaves while it animates — the evidence for those is thirty seconds of video,
and it used to end up in a chat message.

Drop an **MP4 or a WebM** in, the same way as a screenshot, and it goes into the engagement's
evidence like anything else. Those two formats and no others: the browser has to decode the file to
take a frame out of it and to play it back, and those are the two every browser does both for. A
QuickTime `.mov` off a Mac's screen recorder is refused with a message saying to export it — a
recording that plays on the machine it was captured on and nowhere else is not evidence.

**A still frame goes into the writing, not the recording.** A Word document cannot hold a video, so
the app takes a frame out of the recording as it uploads — a tenth of the way in, past the blank
opening frame a screen capture almost always starts with — and that picture is what sits in the
prose. It is an ordinary image: it is numbered as a figure, it can be captioned, prose can point at
it, and it prints. The caption says *(still from a screen recording)* so a reader knows the static
picture is not all there was, and the HTML report says the same.

Clicking the still in the app plays the recording, which can be scrubbed like any other video.
**Open** hands you the file itself.

Recordings are limited to 64 MB each — a couple of minutes of capture, which is also about the
longest recording anybody watches. Trim it to the part that matters.

> [!note]
> Marking up a recording is not offered. The annotator flattens boxes into the image it is given,
> so on a recording it would produce a redacted still in front of an unredacted video — which is
> worse than no redaction, because it looks like one. Redact before you record, or take a
> screenshot and redact that.

## The evidence bin

A recording shows up in the bin as one thing, not two — its still frame is hidden, marked with a
*recording* badge, and inserted as the still with the video behind it.

Not every screenshot has a finding to go in yet. **Evidence** on the engagement is where captures
live until they do — take them while you are testing, write them up later. From there an image can
be dropped into a finding without leaving the page.

## Annotating and redacting

![The annotator open on a screenshot, with Box, Arrow, Step, Label, Blur and Redact in its toolbar, an Undo beside them, and a line underneath explaining that redaction is drawn into the bitmap before the file is written.](/shots/evidence.jpg "Boxes and arrows point at something. Redaction removes it, and saves a new image rather than changing the one you captured.")

Six tools, and the difference between two of them matters:

- **Box** and **arrow** point at things.
- **Step** drops a numbered marker — ①②③ — which is what makes a three-screenshot proof of concept
  readable without a paragraph explaining what order to look at things in. They number themselves
  in the order you place them, and renumber if you undo one.
- **Label** puts a few words on the image itself, on a filled plate so they are legible wherever
  they land.
- **Redact** fills with black. The pixels are gone before the file is written.
- **Blur** averages the region into blocks.

> [!warning]
> **Blur is not redaction.** It is irreversible — block averaging destroys the information rather
> than spreading it, unlike a gaussian blur, which published tools can undo. But it keeps the
> *shape*, which is the point: use it for something that should stay recognisable as *a* customer
> name without being readable as *this* one. For a password, a token or a real address, redact.

The original is never touched. Saving produces a new image, because stored screenshots are
deduplicated by hash and shared across engagements — editing the bytes in place would alter another
client's report from inside this one.

## Replacing one everywhere

If a screenshot turns out to contain something it should not, you do not want to hunt for every
finding that used it. **Replace** swaps the image and repoints every place it appears — findings,
sections, notes — in one action, and says how many it changed.

## How they end up in the report

At render time the images are fetched, measured, and inserted as real Word drawings, scaled to the
text column of *your* template — an A4 page with 2.5 cm margins is a 9070-twip column, not the
Letter default. A caption uses your template's caption style if it has one.

Optional borders and their colour are under **Settings → Report formatting**.

### How wide it prints

Select a screenshot and the bar above the editor offers **Auto**, **Full**, **½** and **⅓**.

*Auto* is the default and is what every screenshot has always done: the size it was captured at,
shrunk if that does not fit the column. It is right about half the time, and wrong in two ways. A
320-pixel error dialog prints as a 320-pixel stamp adrift on the page; a wide terminal capture is
squeezed into the column and is unreadable at any size. The others are for those: *Full* is the
width of the text column, and it is the only thing that will make a picture **larger** than it was
captured — which costs resolution, so it is asked for rather than assumed.

### Two of them side by side

Insert a two-column table and put a screenshot in each cell. A picture is measured against the
column it is in, and inside a table that column is the cell — so each comes out the size of its
half, with the shape kept.

That is new. Until now everything nested in a cell was laid out against the width of the whole
page, so a screenshot pasted into half a table was drawn at full width and spilled out of the cell
it was in. Code panes and nested tables were measured the same wrong way and are fixed with it.

## Who can read it

Evidence is readable only by people on an engagement that contains it — creator, collaborator or
reviewer, with membership that has not run out, and two-factor authentication where the engagement
is marked restricted. That applies to the bytes themselves, to the evidence bin, and to captioning
or deleting a capture.

> [!warning]
> **If you are upgrading, run `npm run backfill:media-owners` once.**
>
> Screenshots are deduplicated by content, so the same picture uploaded to two engagements has
> always been one stored object — recorded against whichever engagement uploaded it *first*.
> Without the backfill, the second engagement's team would be refused a picture that is in their
> own report. The script reads the owners from the engagements themselves and only ever adds; it
> is safe to run more than once.

One object can belong to several engagements, and membership of any one of them is enough. That is
sound rather than a compromise: if two engagements both contain the same bytes, somebody on either
already has them, and reading them through the other reveals nothing new.

Pictures with no engagement on them — a logo, a signature, a generated chart — stay readable to any
signed-in account. They are not client evidence, and refusing them would break the branding on
every page to close nothing.

Uploading a file that already exists elsewhere no longer tells you so. The *"already here"* answer
is given only when the bytes are already in **your** engagement, because across engagements it was
a way to ask whether the instance held a given file somewhere you cannot see.

## Storage and tidying up

Images live in GridFS, in the same MongoDB. Two things keep it from growing forever:

- Deleting an engagement eventually purges its evidence with it.
- `npm run media:gc` collects images nothing references any more, with a grace period so a fresh
  upload that has not been placed yet is left alone.

Nothing runs that automatically — see [Operations and maintenance](/operations).

## Reading evidence back

A rendered report embeds the images, so the `.docx` is self-contained. The HTML report inlines them
as data URIs for the same reason: a report printed to PDF must not depend on being able to reach
your server.

## What happens to a screenshot on the way in

Captures are scaled in your browser before they are uploaded, and the app keeps what it is given.

A 4K screenshot is about eight megapixels. In a report it lands in a text column a little over six
inches wide, where sixteen hundred pixels across is already more than any printer resolves — so
seven of those eight megapixels are bytes nobody will ever see, in a file somebody has to email.
Anything longer than 1600 pixels on its longest edge is scaled to fit; anything already smaller is
left exactly as it was.

**Screenshots stay PNG.** Both encodings are tried and PNG wins unless it is much the larger, which
in practice only happens for photographs. That matters more than the saving: JPEG puts ringing
around every glyph, and a screenshot of a terminal is mostly glyphs.

Nothing is re-encoded when it would lose something — animated GIFs and SVGs are passed straight
through — and if anything at all goes wrong the original is uploaded untouched. The evidence bin
says what it did: *"3 were scaled to what the page can print, saving 14.2 MB"*.

> [!TIP]
> Captures made before this existed are still stored at their original size. Preflight names the
> worst of them, and re-uploading one scales it.

## Captions

Optional. Every picture is numbered whether you write one or not, so a caption is there to say
something a number cannot — *"Figure 7 — The request"* rather than *"Figure 7"*.

Write one by selecting the image in the editor: the caption field appears beside the toolbar, and
what you type goes under that picture in the document.

Captions are drawn in your template's **Caption** paragraph style — italic, grey and centred in both
templates that ship with the app, and yours to change: restyle Caption in the .docx and every
caption in every report follows. A template that defines no Caption style gets italic grey anyway,
written directly, so it still reads as a caption rather than as body text.

The picture and its caption are laid out as one block: both centred, and held together so a page
break cannot leave a screenshot at the foot of one page and *Figure 12* at the head of the next.

Captions belong to the document rather than to the file. The same screenshot can be the request in
one finding and the evidence in another and needs different words each time, so the caption is
written into the finding's own text and the stored image is left alone.

> [!note]
> There used to be a **Figures** panel under each finding, for captioning and reordering pictures
> from outside the editor. It has been removed. Captioning belongs where the picture is, and
> automatic numbering removed the reason the panel existed: there is no longer a list of uncaptioned
> screenshots to keep on top of.

## Numbered figures, and pointing at one

**Every screenshot is numbered**, whether or not anybody captioned it and wherever it sits. Paste
fifty into an engagement and the report gives you *Figure 1* to *Figure 50*, in the order a reader
meets them, with no typing at all. Where you did write a caption it reads *"Figure 7 — The request"*; where you
did not it reads *"Figure 12"* and nothing else.

The order is decided by your template, so the number is worked out when the document is generated
rather than stored on the finding — moving a finding renumbers everything correctly, and it is one
sequence across the whole report. **Screenshots in enumeration write-ups are in it too**: a picture
pasted into a step is evidence exactly like one pasted into a finding, and numbering them separately
would give a reader two figure 3s.

The prose can then point at one. Type `/` in any of a finding's fields and choose **Refer to a
figure**: you get that finding's captioned screenshots, and picking one drops a reference where the
cursor is. Write *"the response is shown in ⟨Figure⟩"* and the document says "Figure 7".

Three things worth knowing.

**Every picture, wherever it is.** Alone in a paragraph, after a label, inside a sentence, in a
list item, in a table cell — all of them are numbered, because on a penetration test all of them
are evidence. A picture that shares a paragraph with words gets its caption at the end of that
paragraph rather than in the middle of the sentence.

**The chip shows the caption, not a number.** It cannot show the number, because the number depends
on where this finding lands in the finished report and only the template knows that. It shows which
screenshot you pointed at, which is what you need while writing.

**In Word they are real fields.** The caption carries a `SEQ` field and the reference a `REF`, both
bookmarked — so when the client edits the document you sent them and deletes a figure, Word
renumbers the rest and fixes every reference to them. Plain text would have said "Figure 7" forever,
including after figure 3 was removed.

If you delete a screenshot and leave behind a sentence that referred to it — or move it into the
middle of a paragraph, where it stops being a figure — **preflight says so** before you generate:
which finding, which words will break, and which of the two happened. Generate anyway and the sentence
prints *"(figure removed)"*: visible on purpose, because quietly deleting the words would leave a
sentence that reads as though nothing is missing.

Under **Settings → Report** you can switch numbering off, and change what a figure is called —
"Screenshot", "Fig.", or the word your house style uses.

### A list of them at the front

A forty-page report with eleven screenshots numbers them, and until now offered no way to look one
up. A reader told *"as shown in Figure 7"* had to page through the document; a reader who remembered
a screenshot but not which finding it was in had no way back to it at all.

Put `{{@rich.listOfFigures}}` in your template, with your own heading above it, and the front matter
gets one line per figure in the order the finished document meets them — each one a link to the
caption it names. `{{@rich.listOfTables}}` is the same for [named tables](/settings).

Both are real `TOC` fields, like the table of contents: the client's own edits rebuild them, and
Word adds the page numbers on the refresh the document asks for when it opens. They also carry a
readable copy of the list *inside* the field, which is what anything that does not evaluate fields
sees — LibreOffice in some configurations, a PDF printed by a converter. A field alone would show
those readers *"Right-click to update field"* on the second page of the report; a static list alone
would go stale the first time anybody edited it.

A report with no figures prints nothing rather than an empty heading, so a template can carry the
tag unconditionally and a proposal with no evidence in it is unaffected.
