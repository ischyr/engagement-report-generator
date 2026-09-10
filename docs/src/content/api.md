# The API

Everything in this application is reachable from a browser by a person who has signed in. Some of
it is worth reaching from something that is not a browser: a scanner that files what it found, a
build that fails when an engagement still has an unfixed critical, a script that records every tool
run without anybody pasting output into a box.

That is what `/api/v1` is for, and it is a deliberately small, deliberately stable part of the
instance. It is not the same thing as the routes the interface uses.

## Why it is separate

The application's own endpoints exist to serve the application's own pages. They change shape
whenever a page does — a list becomes an object because the page needs to know whether a feature is
switched on, a field is renamed because the old name was wrong. That freedom is worth keeping.

It is also incompatible with being something a client's pipeline depends on. So there are two
surfaces:

| | The interface's routes | The versioned API |
|---|---|---|
| Path | `/api/…` | `/api/v1/…` |
| Credential | a browser session | an API token |
| Stability | changes with the interface | additive changes only |
| Reach | everything you can see | what the token names |

The two credentials are not interchangeable, and that is enforced rather than merely intended. A
browser session sent to `/api/v1` is refused. An API token sent anywhere else is refused. Both
refusals say which credential the route wanted, because the first mistake everybody makes is
copying the wrong header out of a network tab.

## What v1 promises

**Additive change only.** New endpoints, new fields on existing responses, new optional query
parameters — all of these can happen, and a caller that ignores them keeps working. Anything that
removes a field, renames one, or changes what one means is `v2`, and `v1` keeps working alongside
it.

Two consequences you can rely on:

- **Every response is a JSON object, never a bare array.** Lists arrive as
  `{ "findings": [ … ], "total": 4 }`. A route that answered with an array would have nowhere to put
  a field that is added later, so the promise would be broken by the first improvement.
- **Every field is published deliberately.** The response shapes are written out by hand rather than
  derived from the database, so a field added to the application tomorrow does not appear in your
  integration's data without somebody deciding it should. This is also why some things are missing
  on purpose — see below.

## Making a token

Your profile page has an **API tokens** card, beside the list of browser sessions. A token needs:

- **A label.** Name it after the thing that will hold it — `Nightly scanner on build-02`, not
  `token 3`. In six months this list is the only record of what has a key to your engagements.
- **Scopes**, which say what it may do. No scope implies another: a token that files findings cannot
  read them unless you tick both.
- **Engagements**, optionally. Naming them is the narrower choice and the better one. Leaving them
  all clear means the token reaches every engagement you are on, *including ones you join later*.
- **A lifetime**, up to a year.

The secret is shown once, in a dialog, and never again. The server keeps a SHA-256 of it and the
first few characters — enough to tell one row in the list from another, and not enough to use. There
is no endpoint that could show it to you again, which is the same reason there is no endpoint that
could show it to anybody else.

> [!important]
> Changing your password ends every browser session and deliberately leaves your tokens alone, so a
> routine password change does not break a running pipeline. If you think a token has leaked, revoke
> it — or use **Revoke all**, which is there for the moment when you are not sure which one.

Tokens begin with `engy_`. That prefix is not decoration: it makes the string recognisable to a
repository scanner or a pre-commit hook, so a token committed by accident has a chance of being
caught by the tools that look for secrets. Send one to the wrong place and it says so — an API
token used on the application's own routes is told it belongs on `/api/v1`, and a browser session
sent to `/api/v1` is told the same in reverse.

### Without a browser

For a headless instance, or for trying this out before working out whose password you know:

```bash
npm run make:api-token -- --user ines --label "Nightly scanner" \
  --scopes findings:write,findings:read --engagement 6aa17a4f… --days 30

npm run make:api-token -- --help      # the scopes, with what each one covers
```

It calls the same code the card calls, so the read-only refusal, the scope validation and the
lifetime ceiling are identical — a shell that could mint what the interface refuses would be a way
around the rules rather than a way in without a browser.

Its companion lists and revokes, and is the only way to revoke somebody *else's*:

```bash
npm run revoke:api-tokens -- --user ines             # lists them, changes nothing
npm run revoke:api-tokens -- --user ines --all
```

## What a token can reach

Three bounds, and a request has to satisfy all of them:

1. **Its scopes** — the verbs it was given.
2. **The engagements it names** — or, if it names none, every engagement its owner is on.
3. **Its owner's access, as it stands at that moment.** This one is worth reading twice: a token can
   never reach more than the person who made it. Take somebody off an engagement and their tokens
   lose it in the same instant, with no token to update. Disable an account and every token it owns
   stops working.

Two things follow that surprise people, both on purpose:

- **An administrator's token is not an administrator.** An admin can open every engagement in the
  instance from the browser. A long-lived string sitting in a pipeline's configuration does not
  inherit that, so an admin's token has to name its engagements like anybody else's.
- **Engagements marked restricted cannot be reached with a token at all.** Restricted work requires
  somebody signing in with two-factor authentication — a person proving themselves twice. A token is
  one string and can prove nothing twice, so the answer is no, and the error says why rather than
  pretending the engagement is missing.

## Trying it

Every token can call `whoami` without any scope at all. It is the right first call, and the right
call again when something has stopped working:

```bash
curl -H "Authorization: Bearer engy_…" https://engy.example/api/v1/whoami
```

```json
{
  "token": {
    "label": "Nightly scanner on build-02",
    "preview": "engy_7fQ2xK",
    "scopes": ["findings:write", "findings:read"],
    "engagements": ["6aa17a4f0ad96e8ca5a9b215"],
    "reach": "named engagements",
    "expiresAt": "2026-12-08T09:14:02.113Z"
  },
  "actingAs": { "id": "…", "username": "ines", "name": "Ines Adeyemi" }
}
```

`GET /api/v1` lists every endpoint with the scope it needs, so the API describes itself and this
page cannot be the only record of it.

## The endpoints

### Engagements

| | | |
|---|---|---|
| `GET` | `/api/v1/engagements` | `engagements:read` |
| `GET` | `/api/v1/engagements/:id` | `engagements:read` |

The list takes `limit` (up to 200), `offset` and `state`, and answers with `total` so you can tell
whether you have them all. The detail adds the dates, the scope and the language.

### Findings

| | | |
|---|---|---|
| `GET` | `/api/v1/engagements/:id/findings` | `findings:read` |
| `GET` | `/api/v1/engagements/:id/findings/:findingId` | `findings:read` |
| `POST` | `/api/v1/engagements/:id/findings` | `findings:write` |
| `PATCH` | `/api/v1/engagements/:id/findings/:findingId` | `findings:write` |

The list takes `severity` and `remediationStatus`. Severity is computed from the vector and the
team's override by the same code the report uses, so your integration and the delivered document
cannot disagree about whether something is a High.

Filing one:

```bash
curl -X POST https://engy.example/api/v1/engagements/$ID/findings \
  -H "Authorization: Bearer engy_…" \
  -H "Content-Type: application/json" \
  -d '{
        "title": "Directory listing enabled on the document host",
        "cvssv3": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
        "description": "Filed automatically by the nightly sweep.",
        "remediation": "Disable autoindex on the vhost."
      }'
```

The finding number — what the report prints as `VULN-03` — is allocated by the server and cannot be
chosen by a caller. A number you picked could collide with an existing finding's, or renumber one
that a delivered report already cites.

### Enumeration

| | | |
|---|---|---|
| `GET` | `/api/v1/engagements/:id/enumeration` | `enumeration:read` |
| `GET` | `/api/v1/engagements/:id/enumeration/:stepId` | `enumeration:read` |
| `POST` | `/api/v1/engagements/:id/enumeration` | `enumeration:write` |

This is the one an operator's own tooling wants. A step is a tool run: what was run, against what,
and what came back.

```bash
nmap -sV portal.example -oN - | curl -X POST \
  https://engy.example/api/v1/engagements/$ID/enumeration \
  -H "Authorization: Bearer engy_…" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -Rs '{title:"Service sweep", tool:"nmap",
      command:"nmap -sV portal.example", target:"portal.example", output:.}')
```

The list leaves the output behind and the detail route carries it, because a tree of sixty steps at
four hundred lines each is over a megabyte of JSON to draw a list of titles.

## What is deliberately absent

**Nothing can be deleted.** Not a finding, not a step, not an engagement. A token is a string in a
configuration file, and the failure mode of a misconfigured script with delete rights is somebody's
engagement quietly emptying out. Removing things stays something a person does while looking at the
screen.

**Some fields are never published.** A finding's internal comments, the client's own account of a
fix, who has the record open for editing, and which borrowed account was used to prove it — none of
these appear in a v1 response. They are things colleagues wrote for each other, and a script is not
the audience.

**Evidence upload and report generation are not in v1 yet.** Both are wanted and both are better
absent than half-promised: adding an endpoint to v1 later is allowed, and changing one is not.

## When it says no

Every refusal is a JSON object with an `error` that is meant to be read by the person debugging it.

| Status | What it means |
|---|---|
| `401` | The credential is missing, unrecognised, expired, revoked, or is a browser session. |
| `403` | The token is live but lacks the scope, is not for that engagement, its owner is not on that engagement, or the engagement is restricted. |
| `404` | No such engagement, finding or step — or no such route, which is what a `DELETE` gets. |
| `409` / `422` | The body did not validate. `422` carries a `details` array naming the fields. |
| `429` | More than 300 requests in a minute for that one token. |

The limit is counted per token rather than per address, because a CI provider runs every customer's
job from a handful of addresses and one busy pipeline elsewhere should not throttle yours.

Every response carries an `X-Request-Id`. If something breaks in a way the message does not explain,
that string appears on every line the server logged while answering — so "it failed and it said
`a1b2c3d4`" is a complete bug report.

## What the log says

A write made with a token appears in the engagement's activity log like any other, with one
difference: it names the token rather than pretending a person did it.

> “Nightly scanner on build-02” (an API token of Ines Adeyemi's) created the finding *Directory
> listing enabled on the document host*

The account is Ines's and the hands were a pipeline's, and somebody reading the log a month later
needs to know which. Entries made this way are marked, so anything that later wants to count machine
writes separately can.
