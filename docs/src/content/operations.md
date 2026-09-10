# Operations and maintenance

## Before you deploy

Three things, in order of how much they matter.

1. **Change the JWT secrets.** The defaults are in `.env.example`, the server warns about them on
   every start, and anybody who knows them can mint a token for any account.
2. **Set `VAULT_KEY`, and back it up somewhere else.** Without it the credential vault stays off.
   With it, and no backup, the credentials encrypted under it are unrecoverable.
3. **Run the suites.** They take a couple of minutes between them; the first seven want a real
   database.

```bash
npm run test:tags     # the template language and the OOXML it emits
npm run test:collab   # the app's own routes end to end, as several people at once
npm run test:api      # the versioned API: which credential, which scope, which fields
npm run test:live     # one heartbeat carries the roster and the notifications
npm run test:projection # a tab that reads less still answers with everything, and still refuses
npm run test:search   # the search filters in Mongo now, and still finds every result it did
npm run test:media    # evidence, storage, the render cache
npm run test:charts   # the report charts, drawn and delivered
npm run test:mail     # the message format and the SMTP conversation
npm run test:images   # the rules that scale a screenshot
npm run test:keys     # what counts as a save keystroke
npm run test:import   # reading a findings spreadsheet
npm run test:figures  # captioning and reordering evidence
npm run test:findings-rows # typing beside sixty findings re-renders none of them
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
- **Report generation happens inside the HTTP request.** A large report with many screenshots holds
  that request open for tens of seconds. Set your proxy's timeout accordingly.
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
- **Indexes are not created automatically in production.** `autoIndex` is on in development and off
  when `NODE_ENV=production`, which is the right default — building an index on a large collection
  at boot is not something to discover during a deployment — but it means a fresh production
  instance runs without the indexes the models declare. On a small installation nothing about that
  is noticeable. Create them once, from a shell on the instance, if you have grown past that.

## Logs

The server logs to stdout: every request with its status and duration, and a stack for anything
that failed. In production the API returns a plain "internal server error" and keeps the detail in
the log rather than sending it to the browser.
