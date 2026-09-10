# Posting to a chat channel

Findings get written, severities move, reports go out. Everything that happens inside an engagement
is already in its activity log — this puts the parts worth knowing about into the channel where your
team already talks about the job, as they happen, without anybody pressing anything.

Microsoft Teams, Discord, or a URL of your own.

> [!note]
> **Off until an administrator fills it in.** Nothing is posted anywhere until somebody sets a URL
> in Settings → *Posting to a chat channel*, and switching it off puts the app exactly back: the
> activity log still records everything, it simply stays in the app.

## Getting the URL

Both services hide it behind a few clicks, in a place this app cannot link to.

| | Where it lives |
| --- | --- |
| **Teams** | The channel's `⋯` menu → **Connectors** → **Incoming Webhook**. On newer tenants, where connectors are gone: **Workflows** → *"Post to a channel when a webhook request is received"*. Either gives you a URL. |
| **Discord** | **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**. A webhook belongs to one channel, so make it in the channel you want these in. |
| **Anything else** | Any URL that accepts a `POST` of JSON. See [the plain JSON option](#anything-else) below. |

Paste it in, tick the groups you want, and press **Post a test message**. A real message in the real
format goes to the channel — the only proof that works is something appearing in it. If the service
refuses, the answer is the service's own words rather than a status code.

> [!important]
> **That URL is the whole authorisation.** Anybody holding it can post to your channel as this app,
> for as long as nobody revokes it — there is no account and no password behind it. So it is stored
> encrypted with `VAULT_KEY`, like a client credential, and **never shown again to anybody,
> including the administrator who pasted it**. The settings page shows only whether one is set and
> which host it points at. To change it, paste a new one; to remove it, clear the box and save.
>
> If it leaks, revoke it at the service — Teams and Discord both let you delete a webhook — and
> paste a new one here.

## What gets posted

Groups, not individual events. The activity log holds a row for every save, and a channel told about
all of them is a channel somebody mutes on the first afternoon.

| Group | What reaches the channel |
| --- | --- |
| **Findings** | A finding is written or imported from a scan, its severity moves, or it is deleted. |
| **Review and sign-off** | The report is approved, an approval is withdrawn, the engagement changes state. |
| **Delivery** | A report is generated, or recorded as sent to the client. |
| **The client** | The client marks something fixed through their link, or a question is asked or settled. |
| **Client links** | A share link is issued or revoked. Off by default. |

The first four are on when you switch the feature on, so it does something rather than nothing.

**A finding being edited is not news.** A write-up is saved dozens of times while somebody works on
it, and every one of those is in the activity log. Only a change of *severity* — the vector, or a
severity set by hand — reaches the channel, because that is the one a lead wants to hear about
without asking.

The message itself is the sentence the activity log shows, so a channel and the app never disagree
about what happened. Cards are coloured by the severity of the finding they are about, using the
same palette the report uses — a High in Teams is the same orange as a High in the document.

## Anything else

The third option posts this app's own JSON to any URL: the fields rather than a rendered card, for a
script, a SIEM, or a service of your own.

```json
{
  "event": "findings",
  "action": "finding.created",
  "summary": "Mario Rossi wrote \"Shipment documents readable without authentication\"",
  "at": "2026-09-09T08:15:00.000Z",
  "actor": null,
  "severity": "Critical",
  "target": "Shipment documents readable without authentication",
  "engagement": { "id": "6a70c934…", "name": "Northwind Logistics", "reference": "NWL-2026-01" },
  "url": "https://engy.example/engagements/6a70c934…"
}
```

Set a **signing secret** and each request carries two headers, so your receiver can tell a real
request from somebody who guessed the URL:

```
X-Engy-Timestamp: 1789012345
X-Engy-Signature: sha256=<hex>
```

The signature is `HMAC-SHA256` over `<timestamp>.<raw body>` with the secret as the key. Verify it
against the raw body before parsing, and reject a timestamp that is not recent — the timestamp is
inside the signature precisely so a captured request cannot be replayed for ever.

Teams and Discord are sent no signature. Neither has any way to check one, and for those two the
secrecy of the URL is the authorisation.

## When it does not work

Nothing that happens here can affect the work. The post happens after the save, its failures are
swallowed, and the worst case is a line in the server log — a chat service being down is never
somebody's error message halfway through writing a finding.

- **A `429` or a `5xx`** is retried once, a few hundred milliseconds later. That covers the case
  this is actually for: a service briefly busy.
- **A `4xx` is not retried.** A revoked webhook, a deleted channel and a malformed payload all
  return one, and asking twice turns a clear failure into two.
- **No answer inside the timeout** (ten seconds by default) gives up, and is not retried either — a
  slow service asked twice is slower.

If messages stop arriving, press the test button. It uses the stored URL when you have not retyped
one, so you can check an instance you did not set up without needing a credential you cannot read.

## From the environment instead

`WEBHOOK_URL` and `WEBHOOK_SIGNING_SECRET` in the environment win over anything saved here, the same
way `SMTP_PASSWORD` does — so an instance deployed from a compose file can carry its secrets there
and nobody has to open the settings page. The page says when a URL is coming from the environment.
