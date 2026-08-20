# Installing and running it

Engy Report is a Node application with a MongoDB database, and this page installs it directly on the
machine — against the MongoDB you already have, with the dev servers that reload as you edit. That
is what you want for working on it.

> [!tip]
> Just want to *run* it, on a machine with nothing installed? [Running it with
> Docker](/docker) is one command and brings its own database.

## What you need

| | |
| --- | --- |
| **Node.js** | 20.19 or newer (22 is what it is developed on) |
| **MongoDB** | Running locally, or reachable over the network |
| **Microsoft Word** | Only to *open* the reports. The app never needs it |
| **Disk** | The templates and the evidence live on disk and in GridFS — allow for the screenshots |

## Setting it up

```bash
git clone https://github.com/ischyr/engagement-report-generator.git
cd engagement-report-generator
npm install
cp .env.example .env
```

Then open `.env`. Two things matter before anybody else can reach the app:

```ini
MONGODB_URI=mongodb://127.0.0.1:27017/engy-report

# Generate each with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_ACCESS_SECRET=…
JWT_REFRESH_SECRET=…
```

> [!danger]
> The secrets in `.env.example` are placeholders and the server warns about them on every start.
> Anybody who knows the default can mint a token for any account. Change them before the app is
> reachable by more than you.

### The credential vault key

`VAULT_KEY` encrypts the per-engagement credential vault. Leave it empty and the vault stays
switched off rather than storing secrets in the clear.

```ini
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
VAULT_KEY=…
```

> [!warning]
> Back this key up somewhere other than the server. It is deliberately not derived from the JWT
> secrets — those get rotated, and rotating them must not destroy stored credentials. Lose the key
> and the credentials encrypted under it cannot be read again.

## The first run

```bash
npm run seed      # settings, taxonomies, and the first admin
npm run dev       # API on :4000, app on :5173
```

`npm run seed` is safe to run more than once — it fills in what is missing and leaves the rest
alone. It creates the admin named in `.env`:

```ini
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=Admin123!
```

Sign in at **http://localhost:5173** and change that password.

> [!tip]
> Want something to look at? `npm run seed:demo` builds a full demo engagement — findings with
> evidence, a client, a proposal — so the pages have something in them while you look around.

## Two-factor authentication

Every account can enrol an authenticator app from **Profile**. An administrator can require it, and
can reset it for somebody who has lost their phone:

```bash
npm run reset-2fa -- <username>
npm run reset-password -- <username>
```

## Registration

`ALLOW_REGISTRATION=true` lets people create their own accounts, which then wait for an
administrator to approve them. The very first account is let straight through and promoted to
admin — otherwise there would be nobody to do the approving.

Close it once your team exists:

```ini
ALLOW_REGISTRATION=false
```

## Building for a real deployment

```bash
npm run build     # the client, into client/dist
npm start         # the API, which also serves that build
```

The API serves the built client, so one process is enough. Put it behind a reverse proxy that
terminates TLS, and set `CORS_ORIGIN` to the origin people will actually use.

> [!note]
> `crypto.subtle` — used to hash a file in the browser when recording a delivery or checking a
> render — needs a secure context. `localhost` counts; plain `http://` over a LAN does not, and the
> app falls back to asking for the hash rather than failing.

## Running the documentation

This site is a third workspace, and builds to static files:

```bash
npm run docs        # http://localhost:5175
npm run build:docs  # docs/dist
```

## Checking it works

Four suites, all runnable against a real database:

```bash
npm run test:tags     # the template language and OOXML
npm run test:collab   # the API, end to end, as several people
npm run test:media    # evidence, storage and the render cache
npm run smoke         # renders a report and every page, checks contrast
```

They create everything they need under a `zz-` prefix and remove it afterwards. Run them before you
deploy — see [Operations and maintenance](/operations).
