# Email

Until you fill this in, the app sends nothing. Notifications appear in the inbox and wait for
somebody to log in and look, which is fine for two people in one room and useless for a review that
needs a colleague's attention on a Thursday afternoon.

Configured, it does two things:

- **Notifications go out as mail** — mentions, review requests, reminders, approvals — to whoever
  has not turned them off on their own profile.
- **Reports can be sent from the engagement**, attached, with the delivery recorded automatically.

## Setting it up

**Settings → Email**, as an administrator. Pick your provider from the list and the server, port and
security fill themselves in; the only fields left are the account and the address to send from.

Then press **Send a test**. It uses the values on the form rather than the saved ones, so you find
out whether the details are right before committing them — and if the server refuses, you get its
own words back, plus the conversation that led to them.

### Gmail and Google Workspace

`smtp.gmail.com`, port 587, STARTTLS.

The account password **will not work**. Google requires an App Password: Google Account → Security →
2-Step Verification → App passwords. The From address must be the account itself or one of its
verified aliases.

### Microsoft 365 and Outlook

A tenant mailbox wants `smtp.office365.com`, port 587, STARTTLS — and an admin has to switch on
**Authenticated SMTP** for that mailbox under the Exchange admin centre, because it is off by
default on new tenants. A personal Outlook.com account wants `smtp-mail.outlook.com` and an app
password.

Either way the From address must be the mailbox that authenticated, or one it is allowed to send as.

### Anything else

Port 587 with STARTTLS is the usual pair; 465 is direct TLS. Port 25 with no security only makes
sense for a relay on your own network — and even then the app refuses to send a password over an
unencrypted connection unless you tick the box that says so.

For an internal relay with a certificate from your own CA, **Accept a certificate this machine does
not trust** is the escape hatch. Leave it off for anything on the public internet.

## Where the password lives

Two options, and the first is better.

**In the environment.** Set `SMTP_PASSWORD` in `.env` (or as a container secret) and the field in
Settings is left alone — nothing sensitive is in the database at all. The form says so rather than
looking empty and unset.

**In Settings.** Typed here, the password is encrypted with `VAULT_KEY`, the same key the credential
vault uses, in the same way. Without that key set the app refuses to store it rather than keeping it
in the clear under a reassuring label.

Either way it never comes back to the browser. The form is told whether one is stored, not what it
is, so an empty box means "leave it alone" — and forgetting a stored password is a button of its
own.

> [!TIP]
> Set `APP_URL` too. Links in a notification email have to be absolute, and without it they point
> at whatever the first allowed CORS origin is — which is the Vite dev server on a development
> machine.

## Sending a report

**Delivery → Send it by email**, on the engagement.

It renders the report as it stands at that moment, attaches it, and writes the delivery record
itself: version, filename, SHA-256, size, and who actually received it. That is the difference worth
caring about — recording a delivery by hand is somebody retyping a hash from memory after the fact,
and this is the register observing what happened.

The covering note is yours. Underneath it the message states the filename and the hash, so the
recipient has, in writing, the means to prove which document they were sent.

A partial send is recorded as a partial send. If three of four addresses are accepted and one is
refused, the three are recorded, and the one that bounced is named — both in the toast and on the
engagement's activity log.

Nothing is recorded if the send fails outright. A register saying a report went to four people when
the mail server refused it would be worse than no register.

## Turning it off for yourself

**Profile → Email me my notifications.** Everything still appears in the inbox; the mail stops.

## When it does not work

The test send is the place to start, because it reports the mail server's own refusal rather than a
shrug. The three that account for most of them:

| What it says | What it means |
| --- | --- |
| Rejected the username or password | Almost always an account password where an app password is required |
| Refused the From address | It does not match the account that authenticated |
| Did not offer STARTTLS | Wrong port for the security setting — 465 is direct TLS, 587 is the upgrade |

`npm run test:mail` checks the mail layer itself — the message format, the SMTP conversation, the
refusals — against a mail server it starts on a loopback port. It needs neither a database nor a
provider, so a failure there is the app rather than your configuration.
