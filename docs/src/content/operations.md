# Operations and maintenance

## Before you deploy

Three things, in order of how much they matter.

1. **Change the JWT secrets.** The defaults are in `.env.example`, the server warns about them on
   every start, and anybody who knows them can mint a token for any account.
2. **Set `VAULT_KEY`, and back it up somewhere else.** Without it the credential vault stays off.
   With it, and no backup, the credentials encrypted under it are unrecoverable.
3. **Run the suites.** They take about a minute between them; the first three want a real
   database.

```bash
npm run test:tags     # the template language and the OOXML it emits
npm run test:collab   # the API end to end, as several people at once
npm run test:media    # evidence, storage, the render cache
npm run test:charts   # the report charts, drawn and delivered
npm run test:mail     # the message format and the SMTP conversation
npm run test:images   # the rules that scale a screenshot
npm run test:keys     # what counts as a save keystroke
npm run test:import   # reading a findings spreadsheet
npm run test:figures  # captioning and reordering evidence
npm run smoke         # renders a report, renders every page, checks contrast
```

> [!warning]
> There is no CI. The suites only run when somebody types the command, so make that part of
> deploying rather than something to remember.

## Backups

Two things to copy, and they are not in the same place:

- **MongoDB** — everything, including the evidence, which lives in GridFS inside the same database.
- **`server/storage/templates`** — the uploaded `.docx` files. The database holds the record; the
  bytes are on disk.

`mongodump` plus that directory is a complete backup. Restore both together: a database whose
templates are missing produces a clear error on every render, which is at least honest, but not
what you want to discover in the morning.

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

## Logs

The server logs to stdout: every request with its status and duration, and a stack for anything
that failed. In production the API returns a plain "internal server error" and keeps the detail in
the log rather than sending it to the browser.
