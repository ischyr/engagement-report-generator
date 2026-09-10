# Running it with Docker

Two containers, one command, nothing installed on the machine but Docker itself. This is the way to
hand the whole thing to somebody — a colleague on a Mac, a laptop that has no Node on it, a spare
box — without walking them through installing MongoDB first.

It is not the way to *develop* it. For that, see [Installing and running it](/installation): a
container rebuilds to see a change, and the dev servers reload in about a second.

## What you need

Docker Desktop, and nothing else. It exists for
[macOS](https://docs.docker.com/desktop/install/mac-install/) — both Apple Silicon and Intel —
Windows and Linux. Nothing here pins an architecture, so the same files build a native image on an
M-series Mac as on an x86 server.

## Running it

```bash
git clone https://github.com/ischyr/engy-report.git
cd engy-report
docker compose up -d --build
```

The first build takes a few minutes: it installs dependencies twice, once to build the app and once
to produce the lean image that runs it. Later builds reuse most of that.

Then:

| | |
| --- | --- |
| **http://localhost:4000** | The app |
| **http://localhost:4100** | This documentation |

Sign in as `admin` / `Admin123!` and change the password.

> [!tip]
> `docker compose logs -f app` shows what it is doing. On a first run you want to see
> `first boot: generating secrets`, then `MongoDB is up`, then `seeding`, then
> `Engy Report API listening`.

## Everyday commands

```bash
docker compose up -d        # start it (after the first build)
docker compose stop         # stop it, keep everything
docker compose down         # remove the containers, keep the data
docker compose down -v      # remove the data too — templates, evidence, reports
docker compose logs -f app  # follow the API
docker compose up -d --build  # rebuild after pulling new code
```

> [!danger]
> `down -v` deletes the volumes. That is every engagement, every finding, every uploaded template
> and every screenshot in the instance. `down` on its own is the one you want.

## What is in it

Three images are built from one `Dockerfile`, which is why the build stage appears once and is
reused:

| Stage | What it is |
| --- | --- |
| `build` | Node 22 with the full toolchain. Builds the client and the docs, then is thrown away |
| `runtime` | Node 22 with production dependencies only, the API, and the built client it serves |
| `docs` | nginx with the built documentation |

And two services run:

- **app** — the API on port 4000, serving the built client from the same process. There is no
  separate web server for it and no CORS to configure, because the browser never leaves the origin.
- **mongo** — `mongo:7`, deliberately *not* published to the host. If you already run MongoDB
  locally, this one does not collide with it; if you want Compass pointed at it, uncomment the
  `ports:` block in `docker-compose.yml`.

## Where the data lives

Two named volumes, which survive `down`, rebuilds and upgrades:

| Volume | What is in it |
| --- | --- |
| `mongo-data` | The database: engagements, findings, users, evidence in GridFS |
| `app-storage` | Uploaded `.docx` templates, render scratch space, and the generated secrets |

Named volumes rather than folders on the host, on purpose. Bind mounts on macOS are slower for a
directory the app writes to constantly, and they bring file-ownership problems that a volume does
not.

Backing up is the same job as it is anywhere else — see
[Operations and maintenance](/operations) — with the dump taken through the container:

```bash
docker compose exec -T mongo mongodump --archive --db=engy-report > engy-backup.archive
docker run --rm -v engy-report_app-storage:/s -v "$PWD:/out" \
  alpine tar czf /out/storage-backup.tar.gz -C /s .
```

## Secrets

The application's defaults are named `dev-only-access-secret-change-me` and the server complains
about them at every start, which is the correct amount of complaining: anybody who knows a signing
key can mint a token for any account.

So the container does not use them. On its **first boot** it generates a fresh set —
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `VAULT_KEY` — and keeps them in the storage volume, at
`/app/server/storage/.secrets.env`. Later boots reuse that file. Nothing secret is written into
`docker-compose.yml`, so the file stays safe to commit.

Read them when you need them:

```bash
docker compose exec app cat /app/server/storage/.secrets.env
```

> [!warning]
> Back up `VAULT_KEY` somewhere other than the machine it runs on. It encrypts the per-engagement
> credential vault, and it is deliberately separate from the JWT secrets — those get rotated, and
> rotating them must not quietly destroy stored credentials. Lose the key and what was encrypted
> under it cannot be read again.

To supply your own instead, set them in the `app` service's `environment:`, or in a `.env` file next
to `docker-compose.yml`. Anything set there wins and the file is never generated.

## Configuring it

Everything worth changing is in the `app` service's `environment:` block.

| | |
| --- | --- |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | The bootstrap account. Change the password *before* the first `up` if anyone else can reach the machine |
| `ALLOW_REGISTRATION` | `false` once your accounts exist |
| `CORS_ORIGIN` | Only matters if you point a separate client at the API |
| `SEED_ON_BOOT` | `false` to skip the seed entirely |
| `PORT` | The port inside the container. To change the *outside* one, edit `ports:` — `'8080:4000'` |

The seed is idempotent: it fills in what is missing and leaves the rest alone, so it running on
every boot changes nothing after the first.

## Exposing it to other people

The container speaks plain HTTP, and should stay behind something that does not.

- Put a reverse proxy in front of it that terminates TLS, and set `CORS_ORIGIN` to the origin people
  will actually type.
- Set `ALLOW_REGISTRATION=false` once the accounts exist.
- Change the seeded admin password.

> [!note]
> `crypto.subtle` — used to hash a file in the browser when recording a delivery or verifying a
> render — needs a secure context. `localhost` counts; a plain `http://` address on the LAN does
> not, and the app falls back to asking for the hash instead of failing.

## When it does not start

**`docker compose up` exits immediately, or the app restarts in a loop.** Read the logs:
`docker compose logs app`. The two usual causes are Mongo not being ready — the app waits up to two
minutes and then says so — and a port already in use.

**"port is already allocated".** Something on the machine is on 4000 or 4100. Change the left-hand
side of the `ports:` entry: `'4001:4000'`.

**The app loads but every request fails after a rebuild.** New secrets would do that, but they are
not regenerated once the volume has them. If you ran `down -v`, they were — everyone is signed out
and needs to sign in again.

**The build fails on `npm ci`.** The lockfile and the manifests disagree, which usually means a
half-finished `npm install` on the host. `npm install` locally, commit the lockfile, and build again.

**Word will not open a report generated in the container.** That is not a container problem — see
[Troubleshooting](/troubleshooting).
