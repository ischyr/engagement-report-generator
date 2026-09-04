# Enumeration

On a red team, the findings are only half of what the client is buying. The other half is the route:
how the perimeter was mapped, what was reachable, which of it turned out to be a dead end. The
**Enumeration** tab is where that goes, and unlike [Notes](/checklists-and-scope), it reaches the
report.

> [!NOTE]
> The tab only appears on a red team engagement. Set **Engagement type** to *Red Team Engagement* on
> the Overview tab and it shows up straight after Findings.

## Turning it on

The engagement type carries the shape of the work, so choosing the type is all it takes:

1. Open the engagement → **Overview**.
2. Set **Engagement type** to *Red Team Engagement*.
3. **Enumeration** appears in the tab bar, right after Findings.

Any engagement type can do this. If your firm runs red team work under a name of its own —
*Adversary Simulation*, *Full-Scope Assessment* — set that type's shape of work to red team once in
**Clients & Data → Engagement types**, and every engagement of that type gets the tab.

> [!TIP]
> A tab with steps in it never disappears. If somebody changes the engagement type after the fact,
> the Enumeration tab stays visible — a page of work that vanished because of a dropdown would look
> exactly like data loss.

## It is a tree, not a list

Enumeration is not a flat sequence. *Subdomain Enumeration* is a **section**, and the six tools you
pointed at the problem are **steps** underneath it:

```
Subdomain Enumeration
    PhoneBook.cz
    crt.sh
    ProjectDiscovery — subfinder
    subfaster
    bbot
    amass — N/A
    Sorted subdomains
    HTTPx — server validation
Email Enumeration
Autonomous System Number (ASN)
Cloud Enumeration
```

That shape is the point. A flat list loses the one thing a reader needs — that those eight rows were
all answering the same question — and the report prints the tree exactly as you arrange it.

- **New section** makes a top-level row.
- The **+** on any row adds a step underneath it.
- **Drag a row** onto another: near its top or bottom edge to drop beside it, in the middle to nest
  inside it. A whole branch moves with its children.
- The **⇥ ⇤** buttons nest and un-nest without a mouse; **▲ ▼** move within the current level.
- Click the twisty to fold a section away. The count beside a folded section says how much is inside.

A row with children and nothing of its own — no tool, no output, no write-up — is treated as a
heading. Templates can print it differently; see `isGroup` below.

### The workbench

The tab is a card beside a card, which is fine for a dozen rows. A real operation's enumeration is
four or five sections with tool runs under them, sometimes three levels deep — thirty rows, sixty —
and at that size the tab is the wrong shape: the structure does not fit and the editor beside it is
squeezed into half a column.

So past six rows a **Workbench** button appears, and there is a page of its own at
`/engagements/<id>/enumeration`:

- full height, the two panes scrolling independently,
- a **splitter** you can drag — or nudge with the arrow keys — and it remembers where you left it,
- **Hide tree** for when you are writing rather than navigating,
- **Fold** and **Unfold** for the whole tree at once, with a count on every folded section,
- **arrow keys**: up and down move through the tree, right opens a section, left closes it or jumps
  to the parent.

It is the same component as the tab, so nothing behaves differently — the drag, the actions, the
conflict handling and the filter are all the ones you already know.

> [!TIP]
> Rows are one line each, in both layouts. Everything that used to be on a second and third line is
> either a chip on the right of the row — tool, output lines, findings, a dot for the outcome — or in
> the editor beside it. Thirty rows of three lines is not a tree you can read.

### Variables

Every command in an enumeration names the same three or four things — the domain, the wordlist, the
output directory. Typed into each one, changing the target means editing thirty commands, which
nobody does; so the commands in the report slowly stop matching what was run.

Define them once instead, from the **$** button above the tree:

| | |
| --- | --- |
| `TARGET` | `acme.example` |
| `WORDLIST` | `/usr/share/wordlists/raft-medium-directories.txt` |
| `OUTDIR` | `/ops/acme` |

Then write `subfinder -d $TARGET -all -silent`. The **stored** command keeps the variable; the
editor shows what it resolves to underneath, and that resolved line is what the report prints and
what the copy button hands over. One edit updates every command at once.

Names are capitals, digits and underscores. Use `${TARGET}` when a letter follows the name.

> [!NOTE]
> A name that is not defined is left exactly as written — `-w $WORDLIST` stays `-w $WORDLIST`, and
> the editor says which are unset. A command that quietly lost a word would look finished and not
> be. Shell variables like `$HOME` are left alone and not reported.

The presets are written against `$TARGET`, and applying one on an engagement that knows its client's
domain defines the variable for you.

### Taking it away as a spreadsheet

**Spreadsheet** above the tree gives you the enumeration as a workbook, next to the CSV. Three
sheets:

| | |
| --- | --- |
| **Summary** | how many steps, which tools, outcomes and phases, and how many rows were held back |
| **Steps** | one row per step — number, tool, target, the resolved command, outcome, line counts, age, write-up |
| **Marked lines** | one row per marked line, with the line's own text and the note |

It is the appendix that goes *with* the report: the same rows the document prints, held-back ones
omitted, so the two cannot disagree. A client's reviewer can sort it by tool, filter it to what came
back with something, and paste hosts into their own queue — none of which they can do to a .docx, so
they were retyping it.

The third sheet is the one a document cannot really carry. A hundred marked lines across sixty steps
is a list, and a list belongs in a column.

> [!NOTE]
> Not the same as the **CSV** button beside it. The CSV is everything this engagement holds, internal
> rows included, for feeding into another tool. The spreadsheet is what the client sees.

### Marking the line that mattered

Four hundred lines of `httpx` contain perhaps three that mattered, and a report that prints all four
hundred has not told the reader which. Pasting the interesting line into the write-up loses its place
in the output; printing the sweep and hoping somebody spots it is the thing the write-up exists to
prevent.

Click a **line number** in the output pane. The line is marked, and a note goes in beside it:

> `187  https://staging.acme.example [200] [nginx]` — *unauthenticated admin panel*

Marked lines are listed above the pane and print in the report as a list under the output, each with
the line's own text. That last part is what makes them work: the note reaches the reader **even when
the pane above it was capped**, so marking is worth doing on exactly the sweeps that are too long to
print.

> [!NOTE]
> Enumeration gets re-run, and the second sweep is never in the same order. A note remembers both the
> line number and the text of that line, so when the output changes it *follows its line* — and when
> the host is gone from the sweep entirely it is flagged as such rather than quietly re-pointed at
> whatever is now on line 187. A note that silently moved would put a sentence somebody wrote about
> one host underneath another one, in a document that goes to a client.
>
> A note whose line has gone is kept and marked, not deleted. During a retest *"this is no longer
> there"* is frequently the most interesting thing on the page. It does not print.

### When it was last actually run

Every step says how old its output is — *"Output pasted today"*, *"Output pasted 3 weeks ago"* — and
anything over a week is marked, on the step and on the tree row beside it. **Not run in a week** in
the filter bar brings just those up.

This is a different question from the one the header answers. *"Edited 2 minutes ago"* moves when
somebody fixes a typo in a title; `ranAt` is free text you typed. The age here is the moment output
was last pasted, which is the only one of the three that can tell you whether the evidence in a
report is current.

A step that has never been run has no age at all rather than an age of zero. During a retest those
are the two most different states on the page, and a filter that treated them alike would be wrong
half the time.

> [!NOTE]
> Templates get this too: `{{ .outputAt }}` and `{{ .outputAge }}` on an enumeration step, with
> `{{#reRun}}` for one that has an earlier run behind it. A closeout line saying *"all enumeration
> re-run within the last N days"* is a real thing a client asks for.

### Doing the same thing twice

The commonest thing anybody does twice is the same tool against a different target. **Duplicate**
(beside the delete button) copies the step next to the original; on a section it copies the whole
branch, children and all.

What was authored comes with it — the title, the tool, the command, the phase, the write-up. What
happened does not: no output, no previous run, no outcome, no findings, no marked lines. A copy
carrying the last run's output would be a lie sitting in the tree waiting to be believed, and the
reason to duplicate a step is that this one has not been run yet.

### Artefacts

The machine-readable output of a run — the nmap XML, the httpx JSONL, a BloodHound zip — files
against the step that produced it. **Attach** on any step; it lists underneath with its size, and
downloads through the same guarded path as any engagement document, always as an attachment and
never as the type the uploader claimed.

Clients increasingly ask for these beside the write-up, and *"the file is in the ticket somewhere"*
is not an answer six months later.

### Reading it before you generate

The **eye** button above the tree renders this chapter the way the report will print it — in a
panel, not a download.

It is built from the report's own data, so the internal rows are already gone, the print policy has
already been applied and the numbering has already closed over the gaps. That is the point: a
preview assembled from the tree would answer a nearby question, and answer it wrongly in exactly
the cases that matter.

It is deliberately plain. Imitating the template's fonts would invite you to trust it about margins
it knows nothing about — the question it answers is *does this read well*.

Long panes are shortened in the panel — the first few lines or rows, with the full figure named:

> Showing 8 of 400 rows — the report prints all 400.

**Show whole panes** in the footer gives you everything. The default is the extract because a chapter
of sixty steps at four hundred lines each is two megabytes of HTML for the browser to lay out, and no
part of *does this read well* is answered by the four hundredth line of a subdomain sweep.

> [!IMPORTANT]
> Two sentences in this panel look alike and mean opposite things, so they are worded to be told
> apart:
>
> - *"Showing 8 of 400 rows — the report prints all 400"* — the panel is trimming. The document has
>   every line.
> - *"Extract only — 397 of 400 rows are not printed"* — the **print policy** is trimming. The
>   document will not have them either.
>
> The first is about this screen. The second is about what you are about to send a client.

### It stays as you left it

Which sections are folded is remembered per engagement, in your browser. It is a fact about where
you are working rather than about the engagement, so it is not pushed to the record — two people on
the same tree want different things open, and sharing it would have them fighting over it.

### Jumping straight to a step

**Ctrl+Shift+E** anywhere on the page opens a switcher: type part of a title, a tool, a target or a
number, and Enter takes the first match. At sixty rows, scrolling the tree is the slow way — and on
the workbench the tree may be hidden altogether.

### Not just red teams

The tab is on every engagement, whatever its type.

It began as a red team tab, on the theory that only an operation has a route worth recording. That
was wrong about ordinary testing: a web application test walks the same ground — what was
enumerated, with what, and what came back — and the alternative was somebody's terminal scrollback,
or a paragraph written from memory a fortnight later.

Nothing in it is red-team-specific. The phases are optional, and so is everything else: a section
with three `ffuf` runs under it is a perfectly ordinary use of the page. Both shipped templates print
the chapter, so a standard report includes it as soon as there is something to include.

### Why it opens quickly

Worth knowing if you are reading the API rather than the page. The tree and the steps in it are two
different requests:

| | |
| --- | --- |
| `GET /audits/:id/enumeration` | every row: title, tool, place in the tree, and *counts* — how many lines of output, whether it reads as a table, how many marked lines |
| `GET /audits/:id/enumeration/:stepId` | one step in full: the output, the write-up, the parsed table, the notes |

A sixty-step operation with four-hundred-line sweeps is a megabyte and a half of tool output. The
tree draws none of it — a title, a tool, some chips and a dot — so sending it with the list meant
paying for the whole operation to look at a list of names. The same split is why saving a step no
longer refetches the tree: the response is that step's row, and the page puts it back where it came
from.

### There is no step limit

Worth knowing because there used to be one, silently.

A step's output, the run it replaced and its write-up live in their own collection, one document per
step. They used to sit inside the engagement document — and a step can hold 200KB of output, as much
again of the previous run, and an uncapped write-up. That is roughly 400KB a step against MongoDB's
16MB ceiling on a single document: a wall at about **forty steps**, which does not announce itself as
a limit. It announces itself as a save being refused, in the middle of an operation, with the
paste you just made as the thing that would not fit.

Measured after the change: ninety steps holding **15.8MB** of tool output, engagement document
**68KB** — under half a percent of the limit, growing by about three quarters of a kilobyte per step
no matter how large the sweeps are.

What stays on the step is the shape and a handful of counts — how many lines, whether it reads as
columns, the first 240 characters for the filter. Those are what let the tree be one read.

> [!NOTE]
> Engagements that predate the change are moved on first boot, once, and the log says how many steps
> it moved. Nothing to run by hand.

The filter's text box searches titles, tools, targets, commands and the **first lines** of the
output. Searching all of it would mean sending all of it.

### A section is not a step

The editor follows the tree. Select a **section** and it leads with *what this section was for* and
its phase, because that is what a section has; the tool, command and output fold away behind a
button, since a heading usually ran nothing and a realistic-looking placeholder in a wide field
reads as content. Select a **step** and you get all of it.

A section that *did* run something keeps those fields open — somebody who filled in a command on a
heading meant it, and hiding what they typed would be the worse mistake by a long way.

### Start from a preset

**From a preset** builds a whole section at once, commands written. Six ship with the app:

| | |
| --- | --- |
| **Subdomain Enumeration** | phonebook, crt.sh, subfinder, assetfinder, bbot, amass, the sorted list, httpx validation |
| **WebServer Enumeration** | fingerprint, TLS, content discovery, nuclei, headers |
| **Port and Service Enumeration** | discovery, masscan sweep, nmap service scan, UDP top ports |
| **Email Enumeration** | phonebook, hunter.io, LinkedIn, verification, breach exposure |
| **Autonomous System Number (ASN)** | whois, bgp.he.net, amass intel, reverse DNS |
| **Cloud Enumeration** | CNAME survey, buckets, tenant discovery, takeover check |

The client's domain is substituted into every command where the engagement knows it; otherwise the
commands say `TARGET`, which is obviously unfinished — better than a plausible command aimed at the
wrong host.

> [!TIP]
> What a preset creates is ordinary steps. Nothing remembers where they came from, so delete the two
> tools you do not use and fix the rest. That is the intended first move, not a workaround.

### Save your own

The six that ship are a starting point; your real methodology is whatever the last engagement ended
up as. The **★** button on a section saves it as a preset, offered alongside the built-ins on every
engagement and marked with a star. Remove one from the menu with the bin beside it.

Structure and commands are saved — titles, tools, phases, write-ups and the shape of the branch.
**The output is not.** A preset is the question you ask, not last time's answer, and carrying one
client's sweep into another engagement is the one mistake this must not make easy.

### Earlier work for this client

**Earlier work** lists the sections from this client's other engagements — the ones you can already
open — with two ways to bring one forward:

| | |
| --- | --- |
| **Structure** | The shape and the commands. What a retest wants: the same ground, walked again |
| **With output** | Last time's answers too, for when the point is to compare |

Outcomes are never carried either way: what became of a step last time is not what became of it this
time.

## A step

The fields are all optional except the title, because a step is sometimes a tool run and sometimes a
screenshot with a sentence under it.

| | |
| --- | --- |
| **Title** | What it was. `Subdomain Enumeration — HTTPx` |
| **Tool** | Named as the reader would recognise it: `httpx`, `amass`, `BloodHound` |
| **Target** | What you pointed it at — a domain, a range, a host |
| **When** | Free text. `21 July 2026, 09:14` is a perfectly good answer |
| **Phase** | Reconnaissance, Initial access, Privilege escalation, Lateral movement, Actions on objective |
| **Outcome** | Completed, Nothing found, Timed out, Blocked, Not pursued |
| **Summary** | One line saying what this was for. On a section, printed above its steps |
| **Command** | The exact invocation, so somebody can run it again and get the same answer |
| **Output** | Pasted as-is. Printed in the report as a monospaced pane |
| **Write-up** | Screenshots, an HTTP request and response, and the prose around them |

### Say what became of it

Record the tools that found nothing, too — a report that only lists what worked overstates how tidy
the week was. **Outcome** is where that goes, rather than in the title:

| | |
| --- | --- |
| **Completed** | It ran and the output is here |
| **Nothing found** | It ran and returned nothing. Still a result |
| **Timed out** | Their resolver, their rate limiting, your patience |
| **Blocked** | Something stopped it — a WAF, a missing credential, an unopened firewall |
| **Not pursued** | Nobody got round to it. The honest label for it |

The difference matters at closeout: *"eight tools attempted, one timed out, none abandoned"* is a
sentence you can only write if the outcome is a field. `enumerationSummary.byStatus` gives the tally.

### Keeping something out of the report

Some rows are for you: the credential that worked, the pivot not worth printing. **Internal** holds a
step back from the report while leaving it in the app — which is what makes this tab the one place an
operation is recorded, instead of half of it living in Notes.

Marking a **section** internal takes everything under it. Held-back rows are struck through in the
tree with an 👁 marker, and a step held back by a section above it says so rather than letting you
find out from the document.

> [!NOTE]
> A finding written up from a held-back step keeps the finding — it just cannot say where it came
> from. `discoveredBy` would otherwise name the step by title, which is the quietest possible way to
> undo the flag.
>
> `enumerationSummary.internal` counts what was withheld, if you would rather tell the client the
> record is fuller than the report.

### How much output the report prints

A four-thousand-line sweep is forty pages nobody reads, and trimming the output before pasting it
destroys the record to fix the document. So the app keeps every line and the *report* gets a policy,
per step:

| | |
| --- | --- |
| **Print all of it** | The default |
| **Print the first lines only** | With a count you choose. The pane *and* the table are capped |
| **Print the table only** | Where the parse worked, and the raw pane adds nothing |
| **Do not print the output** | Recorded, not reproduced |

`{{#printTruncated}}` is true when what a step prints was cut, with `printOmitted` of `printTotal`
`printUnit` left out — say so, because a silently truncated sweep reads as a complete one. The
starter template does.

### Changing many at once

Tick the rows in the tree and a bar appears: set the phase, the outcome or the print policy across
all of them, or mark them internal. Deliberately flags only — a bulk edit that could overwrite
eleven write-ups with the same text is a mis-click away from being a disaster.

### Numbering

The report numbers the tree hierarchically — 1, 1.1, 1.2, 2 — and the same number is shown against
each row in the tab, so the two can be compared at a glance. Held-back rows are removed *before*
numbering, so the document never has a gap where one used to be: a gap is itself a disclosure.

### Exporting it

The **⤓** button writes the whole tree as CSV — number, title, tool, target, command, outcome,
output, findings — for a spreadsheet or a purple-team appendix. `?format=json` gives the same as
JSON, parsed tables included, for the client's own tooling. Internal rows are left out unless the
request asks for them.

### A section's own line

A heading with eight tools under it and nothing saying what they were for reads as a log. **Summary**
is one line — *what we were trying to establish* — printed above the children, and it is what makes
that part of the report read as writing.

### Why Output is a plain box

Output is deliberately *not* the rich-text editor. Tool output is preformatted text whose whole
value is being exactly what the tool printed — column alignment included. A rich editor would offer
to reflow it, smart-quote it and spell-check it. So it is a plain monospaced box, stored verbatim,
and the report prints it as a code pane with the line breaks intact.

Once saved, the pane underneath shows it the way the report will: **numbered**, **foldable** past 40
lines, and with a **copy** button.

### What changed since last time

Paste a fresh run over an old one and the previous output is kept. A **±** button appears on the
pane showing what **appeared** and what has **gone**:

```
+ https://new.acme.example   [200]
− https://old.acme.example   [301]
```

It compares as a set rather than line by line, because enumeration output is nearly always a *list*
— hosts, subdomains, ports, users — and the only useful question about a re-run is what is in it
now that was not before. Saving a title or a command does not touch the snapshot.

### Output as a table

A code pane is honest, but five hundred lines of httpx is something a client scrolls past. When the
output's shape can be recognised, a **Table** button reads it into columns — and the report can print
a real Word table:

```
{{#hasTable}}{{@rich.outputTable}}{{/hasTable}}
{{^hasTable}}{{#hasOutput}}{{@rich.output}}{{/hasOutput}}{{/hasTable}}
```

`httpx`, `nmap` and `masscan` are recognised by name, and anything consistently delimited on tabs or
runs of spaces is read generically. The parsers are also tried when the **Tool** field is blank,
because the bracket grammar of httpx and nmap's port lines are distinctive on their own.

> [!NOTE]
> Every parser either is confident or returns nothing. A table with the columns misaligned looks
> authoritative and is worse than the text it came from, so most output stays a pane — `hasTable`
> is false and the fallback above prints it.

The raw output is never replaced. `{{@rich.output}}` still prints exactly what the tool said.

## Finding what you recorded

Past eight rows a filter bar appears above the tree: free text across title, tool, target, command
and output, plus a tool, a phase, an outcome, and three toggles — *has output*, *reads as a table*,
*became a finding*.

Matches keep their **ancestors**, because a step without its section is not an answer: `crt.sh` on
its own does not say which question it was answering. Folding is ignored while filtering — the point
of a search is to find the row you cannot see.

## From a step to a finding

Two buttons in a step's header close the loop between what you found and what you reported.

**Write up** turns the step into a finding: the command and the output go in as code blocks, then
your write-up. The step stays where it is — it is the record of what was run — and gains a link to
the finding, shown as a badge in its header. One sweep can produce several findings; each write-up
adds another link rather than replacing the last.

In the report this reads from both ends. A step can say what it became, and a finding can say where
it came from:

```
{{#hasLedTo}}Written up as: {{#ledToFindings}}{{ .identifier }} {{ .title }}{{/ledToFindings}}{{/hasLedTo}}

{{#hasDiscoveredBy}}How it was found: {{#discoveredBy}}{{ .title }} — {{ .tool }}{{/discoveredBy}}{{/hasDiscoveredBy}}
```

*"How did you find this"* is the first question in a red team readout, and until now the answer lived
in somebody's memory of the week.

## From a step to the scope

**Scope** offers the hostnames found in the step's output and target, and adds the ones you tick to
a scope group — an existing one, or a new one it creates.

Nothing is added automatically. Deciding which lines of a sweep are assets is a judgement — a
wildcard, a CDN edge, somebody else's domain in a certificate — and it belongs to you, not to a
regular expression. Everything starts unticked.

> [!TIP]
> Set the status to **Excluded** for something you found and agreed *not* to touch. That is how the
> closeout table can account for it instead of it being remembered by nobody.

This is the most common real problem on a red team: enumeration turns up something the scope
document never mentioned, and the decision about it gets made in a chat message.

## In the report

There is a starter template built around all of this — `DEFAULT_RED_TEAM_REPORT.docx`, from
`npm run make:redteam-template`. It prints Enumeration as a chapter rather than an appendix, next to
a Detection and Response chapter, and every finding says how it was found. See
[Templates](/templates).

In your own template:

```
{{#hasEnumeration}}
Tooling used: {{ enumerationSummary.toolList }}

{{#enumeration}}
{{#isGroup}}{{ .title }}{{/isGroup}}

{{^isGroup}}
{{ .index }}. {{ .title }}
Tool: {{ .tool }}   ·   Target: {{ .target }}   ·   {{ .ranAt }}
{{#phaseLabel}}Phase: {{ .phaseLabel }}{{/phaseLabel}}

{{#hasCommand}}{{ .command }}{{/hasCommand}}
{{#hasOutput}}{{@rich.output}}{{/hasOutput}}
{{#hasContent}}{{@rich.content}}{{/hasContent}}
{{/isGroup}}
{{/enumeration}}
{{/hasEnumeration}}
```

The tree arrives **flat, in reading order**, with `{{ .depth }}` on every row — 0 at the top, 1
under a section, and so on. It has to: the template language has no recursion, so a nested loop
cannot walk a tree of unknown depth. Indent by `depth`, or use `isGroup` to print sections and steps
differently, which is what the starter does.

Every tag is in the app under **Templates → Tag reference**, in the *Enumeration* group.

> [!WARNING]
> Guard the parts with `{{#hasOutput}}` and `{{#hasContent}}`. A step that is a screenshot and a
> sentence has no output, and an unguarded **Output** heading would sit over nothing on every step
> like it.

`{{#hasEnumeration}}` wraps the whole section, so a template that carries it prints nothing at all
on a standard test. That makes it safe to leave in your one house template rather than maintaining a
second one for red team work.

### Telling it by phase instead

`{{#enumerationPhases}}` regroups the same steps into the phases of the operation, for a report that
narrates the week rather than the tab:

```
{{#enumerationPhases}}
{{ .label }} — {{ .count }} steps
{{#steps}}{{ .title }} ({{ .tool }})
{{/steps}}
{{/enumerationPhases}}
```

Phases with nothing in them are dropped, so an operation that never got past recon does not print
four empty headings.

## What it is not

- **Not the methodology section.** That is the narrative of your approach, written once. This is the
  log of what actually ran.
- **Not the notes.** [Notes](/checklists-and-scope) are internal and stripped from every report —
  half-formed leads, credentials that worked. Enumeration is written to be read by the client.
- **Not the checks.** A check is a thing you intended to cover and either did or did not; a step is
  a thing you ran and what came back.

> [!DANGER]
> Deleting a section deletes everything nested under it, output and screenshots included. The
> confirmation says how many rows will go.


## Screenshots in a step

A picture pasted into a step's write-up is evidence exactly like one pasted into a finding, and the
report treats it that way: it is numbered in the same sequence, so a reader gets *Figure 1* to
*Figure 50* across the whole document rather than two separate runs that both start at one. You do
not have to caption them — an uncaptioned one simply reads *"Figure 12"*.

[More on how that works](/evidence).
