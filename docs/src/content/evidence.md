# Evidence and screenshots

Screenshots are most of what a client actually looks at, and the part of a report most likely to
leak something.

## Getting one in

Paste from the clipboard, drag a file, or use the button. It goes into the rich text where the
cursor is.

Every image is stored once. Uploading the same screenshot into three findings stores one object and
points all three at it — the app hashes the bytes and recognises them. Replacing it later replaces
it everywhere.

> [!note]
> The *content* decides the type, not the name or the header the browser sent. A shell script
> announced as `image/png` is refused rather than stored and served back as an image.

## The evidence bin

Not every screenshot has a finding to go in yet. **Evidence** on the engagement is where captures
live until they do — take them while you are testing, write them up later. From there an image can
be dropped into a finding without leaving the page.

## Annotating and redacting

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
