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

![The annotator open on a screenshot, with Box, Arrow and Redact in its toolbar, an Undo beside them, and a line underneath explaining that redaction is drawn into the bitmap before the file is written.](/shots/evidence.jpg "Boxes and arrows point at something. Redaction removes it, and saves a new image rather than changing the one you captured.")

Open an image and you get a small editor: crop, arrows, boxes, and **redaction**.

> [!warning]
> Redaction burns the pixels out of the image. It is not a black rectangle drawn on top, because a
> rectangle drawn on top can be moved, and reports do get taken apart. What is redacted is gone
> from the stored file.

## Replacing one everywhere

If a screenshot turns out to contain something it should not, you do not want to hunt for every
finding that used it. **Replace** swaps the image and repoints every place it appears — findings,
sections, notes — in one action, and says how many it changed.

## How they end up in the report

At render time the images are fetched, measured, and inserted as real Word drawings, scaled to the
text column of *your* template — an A4 page with 2.5 cm margins is a 9070-twip column, not the
Letter default. A caption uses your template's caption style if it has one.

Optional borders and their colour are under **Settings → Report formatting**.

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
