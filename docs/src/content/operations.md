# Operations and maintenance

## Before you deploy

Three things, in order of how much they matter.

1. **Change the JWT secrets.** The defaults are in `.env.example`, the server warns about them on
   every start, and anybody who knows them can mint a token for any account.
2. **Set `VAULT_KEY`, and back it up somewhere else.** Without it the credential vault stays off.
   With it, and no backup, the credentials encrypted under it are unrecoverable.
3. **Run the suites.** They take a couple of minutes between them; the first twelve want a real
   database.

```bash
npm run test:tags     # the template language and the OOXML it emits
npm run test:collab   # the app's own routes end to end, as several people at once
npm run test:api      # the versioned API: which credential, which scope, which fields
npm run test:live     # one heartbeat carries the roster and the notifications
npm run test:projection # a tab that reads less still answers with everything, and still refuses
npm run test:search   # the search filters in Mongo now, and still finds every result it did
npm run test:report-flow # a report is queued, collected, and two of them can be compared
npm run test:undo    # a delete offers itself back, and only to whoever may take it
npm run test:housekeeping # a finished engagement is counted, not loaded; notifications end
npm run test:workbench # the enumeration split pane, at a real width in a browser
npm run test:client-question # a client can ask, and never sees what the team asked
npm run test:media    # evidence, storage, the render cache
npm run test:charts   # the report charts, drawn and delivered
npm run test:mail     # the message format and the SMTP conversation
npm run test:images   # the rules that scale a screenshot
npm run test:keys     # what counts as a save keystroke
npm run test:import   # reading a findings spreadsheet
npm run test:figures  # captioning and reordering evidence
npm run test:findings-rows # typing beside sixty findings re-renders none of them
npm run test:enumeration-rows # and typing beside the enumeration tree re-renders none of it
npm run test:library  # the library lists without its prose, and still holds every word
npm run test:library-editor # and will not save an entry it has not finished reading
npm run test:verification # the queue of what clients said, and the wall round each engagement
npm run test:timeline-window # the operation timeline opens on the latest ten
npm run test:url-state # filters live in the address bar, and the columns sort
npm run smoke         # renders a report, renders every page, checks contrast
```

> [!warning]
> There is no CI. The suites only run when somebody types the command, so make that part of
> deploying rather than something to remember.

## Backups

There are two ways in, and they write the same file.

**Settings → Backup and restore** has a button for the copy you want *now* — before an upgrade,
before letting a contractor onto the instance — and it says how large the instance is and when a
backup was last taken. It is also where you restore one, without needing a shell.

**The command** is the one that belongs in cron, because a scheduled backup should not depend on
anybody having a browser open:

```sh
npm run backup -- /mnt/backups
```

One file, with everything in it: every document, every screenshot, and the templates — which live on
disk rather than in the database and are the part people forget. A directory argument gets a dated
filename (`engy-backup-2026-09-09T11-44-33.tar.gz`, which sorts correctly); a path ending in
`.tar.gz` is used as given; with no argument it lands in the working directory.

It is a `.tar.gz`, so `tar -tzf` opens it in ten years with or without this application. On a
small instance it takes about a second.

### Check it on the day you take it, not the day you need it

```sh
npm run restore -- --check /mnt/backups/engy-backup-2026-09-09T11-44-33.tar.gz
```

Reads every entry, verifies each against the digest recorded in the archive's manifest, and writes
nothing. That is the difference between having a backup and believing you have one — and it is worth
putting in the same cron job that takes them.

### Putting one back

From the page: choose the archive, and it is **read and checked** — every entry verified, nothing
written — and the summary comes back saying when it was taken, from which database, and how much is
in it. Applying it then needs the database name typed out. That is three deliberate steps, because a
single button that replaces a firm's entire history on one click is not a button, it is a trap.

Or from a shell:

```sh
npm run restore -- engy-backup-2026-09-09.tar.gz            # into an empty database
npm run restore -- --force engy-backup-2026-09-09.tar.gz    # replacing what is there
```

A restore is **not additive**: each collection in the archive replaces the one in the database. So a
database that already holds engagements is refused unless you pass `--force`, and the command prints
when the backup was taken and what is in it before it touches anything — a wrong file should be
obvious while it still can be.

Afterwards, everybody signs in again. Sessions are the one thing deliberately left out of a backup:
their contents are worthless a moment later, and restoring them would put revoked tokens back into
circulation.

> [!important]
> **Both need two-factor authentication on your account**, whichever route you take from the page.
> Not because an administrator could not already read all of it — they could, one page at a time —
> but because of what these two do in one request: a backup is every finding, every credential and
> every screenshot in a single file, and a restore replaces the instance. It is the same bar this
> app already sets for opening a restricted engagement, for the same reason.
>
> The command line has no such gate: somebody with a shell on the server has the database anyway.

> [!note]
> **Evidence keeps its ids.** A finding's write-up points at `/api/media/<id>`, so a screenshot
> restored under a fresh id would be a report full of broken pictures — and nothing would say so
> until somebody opened one. The archive preserves them, along with each file's name, content type
> and the digest that makes evidence content-addressed.
>
> **Indexes are rebuilt from the models**, not from the archive. A backup carries data; the shape of
> the collections belongs to whichever version of the app is reading it.

### What is in the file

```
manifest.json          what it is, when, from which database, and a digest per entry
db/<collection>.jsonl  every document, one per line, as MongoDB extended JSON
media/index.jsonl      the evidence catalogue — ids, filenames, lengths, metadata
media/<id>             the evidence itself
templates/<file>       the uploaded .docx templates
```

Extended JSON rather than plain, because an `ObjectId` is not a string and a `Date` is not a number —
a backup that flattened them would restore a database that looked right and joined to nothing. It is
the same format `mongoexport` uses, for the same reason.

### The other way, if you prefer your own tooling

`mongodump` plus a copy of `server/storage/templates` is still a complete backup, and if you already
have a database backup regime it may fit it better. Restore both together: a database whose templates
are missing produces a clear error on every render, which is at least honest, but not what you want
to discover in the morning.

## Housekeeping that nothing runs for you

The app ships these and never schedules them. On a real installation, put them on a timer.

| Command | What it does | Suggested |
| --- | --- | --- |
| `npm run purge-trash` | Removes engagements past their retention window, for good | Daily |
| `npm run media:gc` | Collects evidence nothing references any more, with a grace period | Weekly |
| `npm run remind:bookings` | Sends the reminders for work that is due | Daily |

Without them the trash never empties, orphaned images accumulate, and recurring work never nudges
anybody.

## One-off repairs

| Command | For |
| --- | --- |
| `npm run backfill:authors` | Findings written before the app recorded who wrote them. It recovers the ones the activity log can prove and leaves the rest unattributed rather than guessing |
| `npm run backfill:evidence` | Recounts evidence per finding |
| `npm run backfill:lint` | Re-analyses every template after a change to the tag vocabulary |
| `npm run fix:identifiers` | Repairs finding numbering |
| `npm run migrate:media` | Moves evidence into the current storage layout |
| `npm run reset-password -- <username>` | When somebody is locked out |
| `npm run reset-2fa -- <username>` | When somebody loses their phone |

## Automation, and the credentials it holds

Scripts talk to this instance through [the API](/api) at `/api/v1`, using tokens that people make
for themselves on their profile. Three things about that are an administrator's problem rather than
a user's.

**Tokens expire, and a pipeline does not notice until it fails.** The ceiling is a year and the
default is ninety days, so a token made during a deployment will stop working during some later
week that nobody has planned for. The list on each person's profile shows the expiry date and when
the token was last used, which is the only reliable way to tell a live credential from a forgotten
one before deleting it.

**A password change does not revoke them.** That is deliberate — a routine rotation should not
break a running job — and it means a password change is not the response to a suspected leak.
Revoking the token is, and there is a **Revoke all** button for the case where nobody is sure which
one leaked.

**You cannot revoke somebody else's from the interface.** There is no route for it, for the same
reason there is none for reading their sessions: knowing which credentials a person holds is not an
authority that managing accounts confers. Two levers exist instead. Disabling the account stops
every token it owns in the same instant. And from a shell on the server — a different kind of
access from an admin session, which is the one place that difference is allowed to mean something:

```bash
npm run revoke:api-tokens -- --user ines             # lists them, changes nothing
npm run revoke:api-tokens -- --user ines --all
npm run revoke:api-tokens -- --id <token id>
npm run make:api-token -- --help                     # and the other direction
```

`make:api-token` is how a headless instance gets its first token, before anybody has signed in.

> [!note]
> Engagements marked restricted are not reachable with a token at all, whatever scopes it has and
> whether or not its owner has an authenticator paired. Restricted work needs a person signing in
> with two-factor authentication, and a token is one string that can prove nothing twice.

## Where things live

| | |
| --- | --- |
| **MongoDB** | Engagements, findings, proposals, users, settings, and evidence in GridFS |
| **`server/storage/templates`** | Uploaded `.docx` templates |
| **`server/storage/tmp`** | Scratch output from the smoke test and the scripts |
| **`.env`** | Secrets. Not in the repository, and it should stay that way |

## Performance notes

- **Evidence is cached in memory between renders.** Safe because an image's id always means the
  same bytes — uploads are content-addressed. Bounded by total size, least recently used dropped
  first, and cleared for an image when it is deleted.
- **Reports are generated in a queue, not inside the request.** Asking for one records a job and
  answers immediately; a worker takes them one at a time and the page follows along, naming the
  step it is on. Three things follow. The request no longer sits open for tens of seconds, so no
  proxy timeout has to be raised for it. The tab can be closed — the render carries on, and the
  document is offered when you come back, for twelve hours. And two people generating at once
  queue instead of competing for the same single-threaded process.

  Access is re-checked when the job **runs**, not only when it was asked for: a queue puts time
  between the two, and somebody taken off an engagement in that gap must not be handed its report.

  What this does not change: assembling the document is synchronous CPU work, so while it runs it
  still occupies the process. Nobody is waiting on a socket for it any more, which was the part
  that showed.
- **The pipeline list is rows, not records.** Opening a proposal fetches it; the list does not carry
  every proposal's whole history.
- **The interface is loaded a page at a time.** The whole app used to be one 1.8 MB file, so signing
  in downloaded the collaborative editor, ProseMirror, Yjs and the chart renderer before the
  password box could be drawn. Each page is now fetched when somebody goes to it, which takes the
  first load down to about 116 kB compressed. `npm run test:chunks` holds that to a budget, because
  a single static import in the router quietly undoes it.
- **The signed-in app runs one timer.** It ran four: a presence heartbeat, a presence roster, a
  notification list, and another roster read per open record. Something has to tell the server a
  browser is still here, so the heartbeat is the request that cannot be removed — and it now
  answers with the roster and the notifications as well. It beats every 25 seconds, or every 8
  while a record is open.
- **A tab reads its own tab.** Opening the Notes tab used to load the engagement's findings, its
  checklist, its enumeration tree and its sections in order to answer with four notes. Twenty
  per-tab endpoints now name what they need: on the largest engagement this was measured against,
  that is 99% less read for the eleven that only needed the id, and 59–68% less for the ones that
  read one array.
- **The search filters in the database.** One search box covers engagements, findings, sections,
  notes, library entries and clients — and to answer it, the endpoint used to load every
  engagement the searcher could see, whole `findings`, `sections` and `notes` arrays, and then
  run an HTML parser over every prose field of every one of them. A firm with two hundred
  engagements read and parsed everything it had ever written to answer `xss`, on every query.
  Mongo is now asked which engagements contain the needle first, and only those are scored: on a
  43-engagement corpus that is 4 MB of prose and about 250 ms of server work replaced by one
  document read. It is still a collection scan — a case-insensitive substring cannot use an index,
  and a text index would tokenise, so `cros` would stop finding cross-site scripting and
  `api-staging.acme.example` would stop being one word — but the scan happens inside the storage
  engine rather than in Node. `npm run test:search` compares the results against what the
  unfiltered version returned, needle by needle, because a filter that loses a result looks exactly
  like a result that was never there.
- **The dashboard reads finished work separately from live work.** It loaded every engagement
  anybody could see, with its checklist and its findings' titles and authors, and then skipped the
  approved ones in JavaScript — so on an instance with three years of delivered jobs, most of what
  it fetched crossed the wire to be discarded. It is two reads now: the full projection for work
  still going on, and six fields for work that is finished. Finished engagements are still counted
  — they are in the totals and the severity figures, they can still be the next occurrence of
  recurring work, and a booking can point at one — which is why this is a split and not a filter.
- **Notifications expire.** They never did: a per-user feed, read once, kept forever, on a
  collection every poll touches. An unread one now lives six months, and a read one a month after
  it was read. Nothing is lost — the activity log is the permanent record of what happened; this
  is only the part that says *you* should look. Instances that predate the change have their
  existing notifications dated on the next boot, from when each was written rather than from now,
  so anything already old goes at once.
- **The editor arrives when somebody opens a field.** The rich text editor is TipTap and
  ProseMirror — 141 kB gzipped, the largest asset after the entry chunk. Every tab that writes
  prose imported it directly, and one of those is the findings tab, which the engagement page
  imports statically: so opening a job to look at its scope, its hours or its delivery register
  downloaded the whole editor first. It is behind a `lazy()` now. Opening an engagement fetches
  nothing; opening the findings *list* fetches nothing; opening a finding fetches it once, and the
  second finding costs nothing more. `npm run test:chunks` asserts no chunk imports it
  statically — the difference between `from"./RichTextEditor.js"` and `import("./…")` is the
  whole feature, so that is what is checked.
- **A click updates the row, rather than re-reading the engagement.** `reload({ quiet: true })`
  appears at 159 call sites, and on the engagement editor that reload is the whole engagement:
  every finding, every section, every check. Handing a finding to somebody re-downloaded all of it
  to show a different name in one dropdown; ticking a test check did it twice, once for the
  checklist and once for the engagement, because the preflight panel counts unticked checks.

  Those writes already answer with the row they changed, so it is applied where it belongs and
  nothing is refetched. Not optimistic — the server's answer is still what lands — and it falls
  back to the old reload when the row is not on the page, because a patch that quietly matched
  nothing would leave the screen showing what it showed before.

- **A findings list re-renders the row you touched.** The rows were two hundred lines of markup
  inside a loop, so all of them were rebuilt whenever anything on the tab re-rendered — every
  keystroke in the quick-capture box, every step of the `j`/`k` walk, every tick of a checkbox.
  Sixty findings, each with a severity computation, an avatar and a team-sized dropdown, rebuilt to
  put one more character in a text input. The row is its own memoised component now, and
  `npm run test:findings-rows` counts: typing renders no rows at all, moving the cursor renders
  the two that changed, ticking a box renders one. Every row stays in the page — nothing is
  windowed or deferred, so find-in-page, printing and the keyboard walk are unaffected. A
  `content-visibility` deferral for the off-screen rows was tried and taken back out: measured in
  a real browser against the same page without it, a 65-row list laid out 80px taller than its
  true height and every row from the twenty-seventh down sat at a different offset.

- **The enumeration tree re-renders the row you touched, not the tree.** The same fault as the
  findings list, on the screen where it costs more: the workbench is a tree beside an editor, and
  the editor's draft is state on the tab that holds both, so every keystroke in a step's write-up
  rebuilt every row in the tree — sixty on an ordinary operation, two hundred on a large one, each
  with its indent guides, its icon, its five chips and its drag handlers. The row is a memoised
  component now, and it is handed answers rather than collections: `isPicked` and `isCollapsed`
  rather than the `picked` and `collapsed` Sets, which change identity whenever anything in them
  does. The five callbacks the tree is given are created once and read the current implementation
  through a ref, because a dependency array for handlers that close over a dozen pieces of state
  would be either wrong today or wrong after the next edit. `npm run test:enumeration-rows` counts
  the renders: typing five characters in the write-up renders no rows at all, opening another step
  renders two, folding a section renders one. Restoring a single one of the five inline arrows —
  one prop out of twenty-three — puts all sixty rows back on every keystroke, which is what the
  suite is there to catch.

- **The vulnerability library listed its whole self.** `GET /vulnerabilities` answered with every
  entry in full — each locale's description, impact and remediation, screenshots and all, up to two
  thousand of them — so that a table of titles could be drawn. Three callers did that: the library
  page, the picker inside a finding, and the dashboard, which fetched the entire library to render
  the number of entries in it. The list now carries a stored `snippet` per locale and the bodies
  stay in the database, the dashboard asks `GET /vulnerabilities/count`, and the editor fetches the
  one entry it is about to edit.
- **That snippet is stored rather than derived**, which is the only interesting decision in it.
  Summarising a 500-entry library measured at 1.18 seconds of CPU: turning HTML into text is a parse
  per field and there are three thousand of them. Deriving it per request would have traded bytes on
  the wire for a second of server time, so it is written by `withSnippets` at every write path and
  backfilled at boot — exactly as an enumeration step stores `outputPreview`. `?search=` still reads
  the real text, which is how the page keeps searching descriptions it no longer holds.
- **And the editor will not save an entry it has not read.** It is opened from a row, and it saves
  whatever the form holds — so a form seeded from a row with no prose in it, saved before the entry
  arrives, would write three empty fields over somebody's write-up. The dialog fetches the entry and
  the save button stays disabled until it has, including when that fetch fails.
  `npm run test:library-editor` holds it shut: with the guard removed, two of its checks fail.
- **Indexes are not created automatically in production.** `autoIndex` is on in development and off
  when `NODE_ENV=production`, which is the right default — building an index on a large collection
  at boot is not something to discover during a deployment — but it means a fresh production
  instance runs without the indexes the models declare. On a small installation nothing about that
  is noticeable. Create them once, from a shell on the instance, if you have grown past that.

## Logs

The server logs to stdout: every request with its status and duration, and a stack for anything
that failed. In production the API returns a plain "internal server error" and keeps the detail in
the log rather than sending it to the browser.
