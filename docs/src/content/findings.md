# Findings

A finding is the unit of work and the unit of the report. Everything here ends up in the document.

## The fields

| Field | Notes |
| --- | --- |
| **Title** | What is wrong, in the client's words. It is what the report prints as the heading |
| **Type and category** | How the report groups things. Both come from the taxonomy under Clients & Data |
| **CVSS** | The vector. The score and the severity follow from it |
| **Severity override** | A severity the team stands behind when it differs from the score. A reason is required |
| **Priority and complexity** | Optional. How urgent, and how hard to fix |
| **Description, observation, remediation** | Rich text — headings, lists, tables, code, screenshots |
| **Proof of concept** | The steps. Also rich text |
| **Affected scope** | Where it is |
| **References** | One per line |
| **Status** | Not fixed, retesting, or fixed |

## Affected assets, from the scope

One issue on nine of forty hosts used to be a paragraph typed by hand, from a list in another tab,
at the end of a long day — which is how a report ends up naming an address that does not exist.

The scope is structured, so the field can be filled from it. In **Affected scope** or the
description, type `/` and choose **Hosts from scope**: it lists every host in the engagement's
scope, grouped, with the ports the import found, and you tick the ones this finding is about. It
writes a bulleted list and leads with the count — *9 of the 40 hosts in scope* — which is the
sentence a reader needs in order to know whether they are looking at one mistake or the estate's
default configuration, and the one nobody writes by hand because counting the scope is tedious and
goes stale.

Hosts that have both a name and an address get both. That is not tidiness: the per-host view matches
findings to assets by looking for either address in this field, so assets picked here appear on those
hosts' pages without anybody arranging it. A host marked excluded or not yet tested is still offered,
labelled as such — occasionally that is exactly the right answer — and hosts with no services recorded
say so rather than pretending to have no open ports.

## Severity, and disagreeing with it

![The scoring section of a finding. CVSS v3.1 reads 8.7 High beside a second figure of 7.7 with threat applied, with a switch to v4.0 next to them, and each metric of the vector is a row of buttons under the question it answers, such as "How remote can the attacker be?" ](/shots/finding.jpg "The vector, with the question each metric is really asking. The score and the severity in the report both come from here.")

The severity comes from the CVSS vector. When the vector is wrong for your client — a compensating
control, a network that is not reachable the way the vector assumes — override it.

The app asks why, and refuses to store the override without a reason, because an unexplained
departure from a published score is exactly what a client disputes. The reason prints beside the
score, and the list shows both:

```text
Low  10.0   scored Critical
```

## Numbering

Each finding carries an `identifier`, which is what the report prints as `VULN-03`. It is allocated
when the finding is written, so a reordered report can print 01, 04, 07 in that order.

**Renumber** — on the bulk bar — puts them back in the order shown. It is refused once the
engagement has been delivered, because the client has written their remediation tickets against
those numbers, and while anything restorable is in the trash, because a restore brings a finding
back carrying its own.

## Whose it is

A finding records who wrote it and who touched it last. Neither answers *whose is it now*, which is
the question a two-person engagement asks every morning — so splitting the writing up happened in
chat, and the same finding got written twice while another got written by nobody.

The small control on each row hands one to somebody. It only offers people who are on the
engagement: somebody who cannot open it cannot write it, and the app refuses the assignment rather
than leaving a finding owned by a name that can never act on it. **Assign**, on the bulk bar, does
the same for a whole selection — "you take these nine, I will do the rest" — and sends one
notification for the batch rather than one per finding.

Once anything has been assigned, **Just mine** appears beside the ordering line and shortens the
list to your own. Whatever is open stays visible even when the filter would drop it.

Everything that is yours, across every engagement, is on the **Inbox** page under *Findings that
are yours to write*, worst first. It empties in three ways: somebody hands the finding on, the
engagement is approved, or it is archived. There is deliberately no "done" — a finding is not
finished, it is delivered with the report.

A finding **moved to another engagement** arrives belonging to nobody, because being assigned means
being a member of the engagement it is on. A **duplicated** engagement starts unassigned for the
same reason: last year's split is not this year's.

## Tags

Free labels on one finding: **needs retest**, **client disputes**, **chained with 4**, **pci
6.5.1**. Engagements have had these for a while; findings now have their own, because the questions
asked at the end of a test are not the ones the other fields answer. *Which of these am I still
waiting on. Which did the client push back on. Which three are really the same bug.* None of those
is a severity, a status or a category.

Type one and press enter. They are lower-cased on the way in, so "PCI" and "pci" cannot both exist,
and the box offers what is already in use on other findings across the instance — so the same idea
is not spelled three ways on three tests. Twenty per finding, which is far more than anybody wants.

Every tag in use in an engagement appears as a pill above the list, beside **Just mine**. Click one
to see only those; click it again to stop. Whatever finding is open stays in the list either way — a
filter that closes the thing you are reading is a filter nobody trusts twice.

**Tag** on the bulk bar adds one to everything ticked, and **Remove** takes it off. Both *add and
remove* rather than setting, which is the whole point of doing it to nine at once: they have
something in addition in common, and setting their tags would throw away whatever else each of them
was already labelled with.

> [!important]
> **Tags are never printed in the report, and never reach the client.** They are a note the team
> writes to itself. A severity override has a reason field precisely because the client is owed an
> explanation; a tag is the opposite kind of thing, and "client disputes" arriving in the client's
> own document would be a bad afternoon. They are stripped from the data the document is built
> from, they are not in the client's share link, and they are not in the tracker export.
>
> If you want a weakness class that *does* print — a CWE, an OWASP category — that wants a field of
> its own rather than a convention on this one.

## Pasting evidence into a write-up

Two kinds of paste are recognised and turned into something readable, because the alternative in
both cases is a *screenshot* of text — an image that cannot be searched or copied, and is unreadable
in a printed report at anything under full size.

**An HTTP request and its response.** Pasted from a proxy or from `curl -i`, it becomes two labelled
code blocks instead of a paragraph with the headers reflowed into it. The text is kept exactly as it
was pasted, because an exchange somebody has tidied is not evidence.

**A table.** Paste a grid and get a real table:

- **From a spreadsheet** — Excel, Google Sheets, a database client, `cut -f`. Anything that puts
  tab-separated values on the clipboard. The first row becomes the header, which is what makes it
  repeat across a page break in Word.
- **A markdown table**, with its `|---|---|` rule, as many tools print.

Deliberately **not** comma-separated values, and not space-aligned command output. A paragraph of
English contains commas, and `ls -l` lines its columns up with spaces — so the cost of being wrong
is asymmetric: a real table pasted as prose is an annoyance you fix, while a sentence turned into a
one-row table is a mangling you have to undo by hand in a finding you were halfway through. Those
stay as text, where a code block already renders them correctly.

A grid that is ragged — rows of different widths — is left alone too, rather than padded. Guessing
at the missing cells would put words in the wrong columns, which reads as data rather than as a
mistake.

> [!tip]
> If a conversion was not what you wanted, ⌘Z / Ctrl+Z puts it back, and pasting with
> ⇧⌘V / Ctrl+Shift+V inserts plain text without any of this.

## Doing one thing to many

Tick the checkbox on each row — shift-click takes a run, which after a sort by score is usually
exactly the set you want — and a bar appears at the bottom of the page.

It can set the **severity** (with one reason for all of them), the **status**, the **category**,
the **type**, the **priority** and the **complexity**; **add or remove a tag**; **assign** them to
somebody on the engagement; **move or copy** them to another engagement; **delete** them; and
**renumber** the whole list.

Only those fields — never prose. Bulk-editing a description would need a version per finding and
would be worse than doing it one at a time. Because nothing in the bar touches text, a colleague
retyping one of those descriptions cannot lose a word to somebody re-scoping the batch.

> [!note]
> Anything somebody else has **locked** is skipped and named — "6 changed, 2 skipped, held by Ana"
> — rather than failing the whole batch. One person reading a write-up must not block a change to
> the other thirty-nine.

## Merging two of the same thing

Two people write the same issue more often than anybody admits: *IDOR on document download* and
*missing authorisation on /documents*. **Merge** folds one into the other.

It concatenates rather than choosing. Each rich field becomes the survivor's text followed by the
other's, evidence and all; references are unioned; the severity is the **higher** of the two.
Nothing is summarised and nothing is dropped — the result reads like two people wrote it, which is
true, and is much easier to edit down than a lost paragraph is to recover.

The other finding goes to the same trash a delete uses, so a merge is reversible for as long as a
deletion is.

## Moving one somewhere else

**Move** files a finding on the engagement it belongs to; **copy** leaves the original alone. Either
way it gets a new number on the engagement it lands on, and its review comments stay behind — they
were a conversation about the other report.

Evidence travels with a move, and with a copy to the *same* client. A copy to a **different** client
leaves the screenshots behind: the alternative is one client's evidence in another's report.

## Deleting one

A deleted finding goes to the trash and can be restored whole. It is often an hour of writing with
screenshots attached, and the only thing between it and oblivion used to be a confirmation dialog.

## Retests

A finding carries a status — **not fixed**, **retesting**, **fixed** — and a *history* of them:
who moved it, when, and that it was marked fixed once before and came back. That is the record a
retest argument turns on, and it used to be reconstructed from memory.

The bulk bar sets the status across a selection, which is how a fix window ends: eleven findings
marked retested in one go, each one appending to its own history.

## What has been seen before

If the same issue was reported to this client before, the finding says so — which engagement, which
reference, when. Nothing infers it: it comes from the other engagements for that company.

## Comments

Comments on a finding are internal and never appear in the report, so reviewers can be blunt. They
can be attached to a specific field, mention a colleague — who gets a notification — and be marked
resolved.

## Walking the list

`j` and `k` move down and up the findings list — the arrow keys do the same — `Enter` or `o` opens
the one under the cursor, `e` opens it to be written, and `Escape` puts the cursor away. Reviewing
forty findings was forty round trips to the mouse.

The cursor is a highlight rather than a focus ring, because each row carries its own controls and
moving real focus onto the row would take it off whichever of those you had just used. It scrolls
itself into view. Anything typed into a field, a search box or a rich-text editor stays in the
field: `j` is a letter for most of the time anybody spends in this app.

## Saving

`⌘S` on a Mac, `Ctrl+S` everywhere else — from anywhere on the screen, including from inside the
write-up, where a report gets written for hours at a time.

It saves whatever is currently unsaved, which is the same set of things the app already warns you
about when you navigate away: a finding, a note, an enumeration step, the scope, the engagement
details, a narrative section. If two of them are unsaved, both are saved — "save my work" has no
ambiguity worth resolving with a rule.

On a screen with nothing unsaved the keystroke is left to the browser rather than swallowed, so it
does what it has always done rather than appearing to do nothing.

## Writing the same thing twice

As you type a title, the app checks whether this engagement already contains that finding and says
so under the field — with a link to the one it found. The rule for "the same" is the one the
library and the recurrence check already use: punctuation, capitalisation and anything in brackets
are ignored, so *Stored XSS (export view)* and *Stored XSS (admin search)* count as the same
weakness.

It is a hint under the field rather than a question on save, because the point is to stop the
second write-up being *started*. Merging two finished ones afterwards is still there if you want
it, but it is the more expensive way round.

## Importing from a spreadsheet

**Findings → From a sheet.** An `.xlsx` or a CSV whose first row is the headers. The findings
export writes exactly the shape it reads, so a sheet exported from here comes back unchanged — and
the common alternative names are understood too, so a scanner's export or a colleague's own
template usually lands without editing the headers first.

Nothing is created when you choose the file. Every row is judged and shown back:

| Verdict | What it means |
| --- | --- |
| **New** | It will be created as written. Ticked. |
| **Already here** | This engagement, or an earlier row in the same sheet, already has that title. Offered, but unticked — you decide. |
| **Cannot import** | Something required is missing. The reason is on the row, and it cannot be ticked. |

A severity that disagrees with its CVSS vector is a warning rather than an error: the vector wins,
because that is what the report recalculates from, and the row says so. A vector that is not one is
refused rather than stored, and the finding arrives unrated.

Imported findings are drafts. The scoring, the evidence and the write-up still need a person.

## Filing one from a script

A sheet is the right shape when somebody exported one. When the thing producing findings is a
scanner or a scheduled job, there is [the API](/api): `POST /api/v1/engagements/:id/findings` with
a token scoped to `findings:write` and to that engagement. The finding number is allocated by the
server there too, and the activity log records which token filed it rather than implying a person
did.

Findings that arrive this way are drafts in exactly the same sense as imported ones.
