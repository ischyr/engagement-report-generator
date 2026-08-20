# Users, roles and access

## The roles

An account holds **one or more** roles. A consultant who is also a manager passes both checks —
making them choose would mean two accounts and two passwords.

| Role | Can |
| --- | --- |
| **Administrator** | Everything, including users, settings and the rate card |
| **Manager** | Deliver work, sign a client's paperwork off, approve a price, set targets |
| **Consultant** | Engagements they are on: findings, evidence, reports |
| **Read only** | See what they are on, change nothing |
| **Sales** | The Sales section, and nothing else |

**Read only wins over everything else it is paired with.** The point of the role is that somebody
cannot change anything, so a second role must not quietly undo it.

## The sales wall

A sales account reaches the Sales section — the pipeline, clients, proposals, invoicing — and no
engagements, no findings and no clients' reports.

This is enforced at the API, as an **allowlist** rather than a denylist, so it fails the safe way:
a route added tomorrow and forgotten is invisible to sales rather than exposed to them. Hiding the
links would not be access control; a URL typed by hand arrives at the same gate.

An account that holds a sales role *and* a working role is not confined — that is the small firm
where the same person sells the work and helps deliver it.

## Getting an account

Two ways, depending on `ALLOW_REGISTRATION`:

- **Registration open.** Somebody signs up and waits for an administrator to approve them. They can
  set a password and enrol two-factor while they wait, but they cannot sign in until approved. The
  admins are notified.
- **Registration closed.** An administrator creates the account.

The **first** account ever created is let straight through and promoted to admin, because otherwise
there is nobody to do the approving.

## Two-factor authentication

Any account can enrol an authenticator app from **Profile**. Sign-in then asks for the six-digit
code as a second step.

An administrator can reset it for somebody who has lost their phone:

```bash
npm run reset-2fa -- <username>
```

Enrolment can also be *required* of an account, in which case the person sets it up before they can
use the app.

## Sessions

Every sign-in is a session, listed on the profile page with where and when. Any of them can be
revoked, including from another device — which is what somebody wants after losing a laptop.

Access tokens are short-lived and kept in memory; the refresh token is an httpOnly cookie. Closing
the tab does not sign you out, and a stolen access token expires quickly.

## Disabling somebody

An account can be **disabled** — it used to work and no longer does. That is deliberately different
from *not approved*, which is an account that has never been let in. Both are refused at sign-in
with a message that says which.

Their work stays. Findings keep their author, activity keeps their name, and the engagements they
were on are unchanged.

## Skills and the team page

Each person can record what they are good at, which is what the staffing view reads when it
suggests who could take a job. The Team page shows utilisation — booked days against available days
— and what everybody is working on.
