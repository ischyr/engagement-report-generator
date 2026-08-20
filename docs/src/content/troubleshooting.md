# Troubleshooting

The failures that actually happen, and what each one really means.

## Word refuses to open the report

> Word experienced an error trying to open the file. Check the file permissions… make sure there is
> sufficient free memory and disk space.

None of which is the problem. That message is what Word says about a **package it cannot make sense
of** — most often a part with no content type, or XML that does not close.

What to do: generate again on a current build. If it persists, `npm run smoke` renders a report and
runs the package validator over it, which names the part and the reason. The validator checks that
every part has a content type, that the ones Word checks specifically have their own declaration,
that every relationship points at something present, and that every XML part is well-formed.

## A number or a section comes out blank

A tag that resolves to nothing renders empty rather than failing — which is right for a
half-finished template and unhelpful when you cannot see why.

**Templates → Test render** is the answer. It says which tags resolved, which did not, and why:
misspelled, outside the loop it belongs to, or a field the sample has no value for.

The three usual causes:

- **Wrong scope.** `{{ title }}` inside `{{#findings}}` is the finding's title; outside it, the
  engagement's. A condition over a scalar — `{{#isPriced}}` — does *not* move scope.
- **A misspelling.** The upload lint and the test render both suggest the tag you are one edit
  away from.
- **Nothing there.** An engagement with no scope rows prints no scope rows.

## The table of contents is empty

Word populates a table of contents when it refreshes fields. **Settings → Report formatting →
Refresh fields on open** controls whether the document asks it to.

If it is on and the client still sees an empty contents page, they opened it in something that is
not Word. The **How each document was generated** card records this setting per render, so you can
check what the document they have was built with.

## A finding cannot be saved

- **"Someone else edited this."** The record moved while you were typing. You are shown a merge —
  your version, theirs, and what you both started from — field by field. Nothing is lost either way.
- **423, "locked by …"** Somebody has taken the finding. Read it, comment on it, or ask them. A lead
  can force the lock off.
- **A validation error naming a field you did not touch.** Usually a stale browser tab. Reload the
  page and try again; if it survives a reload, the message names the field and the rule.

## A lock will not release

A lock lapses on its own once **both** halves are stale: it was taken more than an hour ago and its
holder has not been seen for an hour. A lock taken seconds ago by somebody whose browser is closed
is still live, deliberately.

A lead or an administrator can force it. A consultant cannot.

## "Who else is here" shows nobody

Presence is a heartbeat and a poll. If the whole sidebar is empty, the browser is not reaching the
API — check the network tab. If it shows people but not *where they are*, the location was refused;
that is a bug worth reporting rather than a setting.

## An engagement cannot be deleted

Something still points at it. The refusal names what — usually a proposal that became it, or a
delivery record. Deal with that first.

A proposal that became an engagement cannot be deleted while that engagement is **live**; one in the
trash no longer holds it back.

## Findings cannot be renumbered

Two reasons, both deliberate:

- **It has been delivered.** The client has written their remediation tickets against those
  numbers, and ours and theirs disagreeing is worse than an untidy sequence.
- **Something is in the trash.** A restored finding comes back carrying its number, so renumbering
  around it would hand a live finding a number the trash can produce a second copy of. Empty the
  trash or restore it.

## Templates warn about tags that clearly exist

Fixed, but if you see it on an older build: the offer vocabulary — `validUntil`, `constraints`, the
firm block — was documented and not registered with the lint, so proposal templates warned about
their own tags. `npm run backfill:lint` re-analyses every template.

## Evidence does not appear in the report

- The image was uploaded but never placed in a field. It is in the **Evidence** bin.
- The finding is in the trash.
- The image was deleted after being placed, in which case the render logs which id it could not
  find and carries on — a report with one missing screenshot beats no report.

## Nobody can sign in after a restart

- **MongoDB is not up.** The API says so on start and every request fails.
- **The JWT secrets changed.** Every existing session is invalid — which is what rotating them is
  for. Everybody signs in again.
- **The account is disabled or unapproved.** The sign-in page says which.

## The app is running but the page is blank

The client build is stale or missing. `npm run build`, then `npm start`. In development, `npm run
dev` serves the client from Vite instead and the API on its own port.
