<h1 align="center">
  <img src="client/public/favicon.svg" width="76" alt="Engy Report"><br>
  Engy Report
</h1>

<h4 align="center">A pentest reporting platform that fills <em>your own</em> Word template.<br>You write the findings. It writes the document.</h4>

<div align="center">

![Node](https://img.shields.io/badge/Node-20.19+-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white) ![React](https://img.shields.io/badge/React-18-149ECA?style=flat-square&logo=react&logoColor=white) ![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white) ![MongoDB](https://img.shields.io/badge/MongoDB-8-47A248?style=flat-square&logo=mongodb&logoColor=white) ![Docker](https://img.shields.io/badge/Docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white) ![Tests](https://img.shields.io/badge/tests-1415%20checks-2ea043?style=flat-square)

</div>

<div align="center">

[Quick start](#quick-start) &nbsp;•&nbsp; [Docker](#run-it-with-docker) &nbsp;•&nbsp; [Documentation](#documentation) &nbsp;•&nbsp; [Template language](docs/src/content/template-language.md) &nbsp;•&nbsp; [Screenshots](#a-look-around)

</div>

---

📄 **Your `.docx` is the design.** Cover page, fonts, headers, tables, numbering — all from your template. None of it lives in the code.<br>
✍️ **Write a finding once.** Keep it in the library, pull it into any engagement, edit it there without touching the original.<br>
🧮 **CVSS 3.1 and 4.0**, scored in the app, with the threat and environmental metrics.<br>
🤝 **Several people, one engagement** — presence, finding locks, review threads, approvals.<br>
🐳 **One command to run it**, on a machine with neither Node nor MongoDB installed.

<br>

## A look around

<p align="center">
  <img src="assets/screenshots/findings.png" alt="The findings of an engagement, ordered by CVSS score">
</p>
<p align="center"><em>Findings order themselves by score, or by hand. Severity, category, author and evidence at a glance.</em></p>

<br>

<table>
<tr>
<td width="50%"><img src="assets/screenshots/finding-cvss.png" alt="The CVSS calculator inside a finding"></td>
<td width="50%"><img src="assets/screenshots/template-playground.png" alt="Every placeholder in a template, and what it resolved to"></td>
</tr>
<tr>
<td><b>Score it in place.</b> Both CVSS versions, every metric explained in a sentence, base and threat scores as you click.</td>
<td><b>Test a template before you trust it.</b> Every placeholder in reading order, what it resolved to, and which ones are not tags at all.</td>
</tr>
<tr>
<td width="50%"><img src="assets/screenshots/library.png" alt="The vulnerability library"></td>
<td width="50%"><img src="assets/screenshots/engagements.png" alt="The engagement list"></td>
</tr>
<tr>
<td><b>A library, not a copy-paste folder.</b> Importing copies the text, so per-client edits never leak back.</td>
<td><b>Every engagement, with what it still needs.</b> Findings without evidence, checks left, sign-offs outstanding.</td>
</tr>
<tr>
<td colspan="2"><img src="assets/screenshots/insights.png" alt="Insights across engagements"></td>
</tr>
<tr>
<td colspan="2"><b>Across all of it.</b> Severity over time, remediation, what keeps coming up — the case for a hardening standard.</td>
</tr>
</table>

<br>

## Quick start

Needs **Node 20.19+** and a **MongoDB** you can reach.

```bash
npm install
cp .env.example .env
npm run seed              # database, admin account, reference data
npm run make:template     # writes DEFAULT_PENTEST_REPORT.docx
npm run make:redteam-template  # and DEFAULT_RED_TEAM_REPORT.docx
npm run dev               # API on :4000, app on :5173
```

Open **http://localhost:5173**, sign in as `admin` / `Admin123!`, and change it on the Profile page.

Then: **Templates** → upload `DEFAULT_PENTEST_REPORT.docx` → **Engagements** → New → add findings → **Generate report**.

> [!TIP]
> `npm run seed:demo` builds a finished engagement — findings with evidence, a part-worked
> methodology, a review conversation — so the pages have something in them while you look around.

## Run it with Docker

For a machine that has neither Node nor MongoDB on it. Everything comes with it, and nothing is installed outside Docker.

```bash
docker compose up -d --build
```

- **http://localhost:4000** — the app
- **http://localhost:4100** — the documentation

The bundled MongoDB is not published to the host, so it will not collide with one you already run. Data lives in two named volumes and survives `docker compose down`. Real JWT and vault secrets are generated on first boot, so nothing secret sits in `docker-compose.yml`.

## Writing a template

A template is an ordinary Word document with placeholders in it. Spacing inside the braces never matters, and the leading dot is optional.

```
{{ .name }}                         Engagement name
{{ .company.name }}                 Client
{{ .date | date:'dd/MM/yyyy' }}     A filter
{{@rich.executiveSummary}}          Rich text: headings, lists, tables, images

{{#findings}}                       Loop
  {{ .id }} — {{ .title }} ({{ .severity }})
  {{@rich.description}}
{{/findings}}

{{#hasDetection}} … {{/hasDetection}}    Conditional block
```

**The complete list is in the app: Templates → Tag reference** — searchable, with copy-to-clipboard, generated from the same source the renderer uses so it cannot drift.

Rich text maps onto Word's built-in styles rather than hard-coded formatting, which is what makes the output match your design. Your template needs `Heading1`–`Heading6`, `ListParagraph`, `Quote` and `Caption` to exist.

## Documentation

Twenty-eight pages with their own search, as one of four workspaces in this repo:

```bash
npm run docs        # http://localhost:5175
```

| | |
| --- | --- |
| [Installing and running it](docs/src/content/installation.md) | Node, MongoDB, the first account |
| [Running it with Docker](docs/src/content/docker.md) | Volumes, secrets, backups |
| [Your first report](docs/src/content/first-report.md) | Engagement to document in about ten minutes |
| [The template language](docs/src/content/template-language.md) | Every tag and filter, and the traps |
| [One house style](docs/src/content/house-style.md) | Letterheads and inheritance across templates |
| [Working together](docs/src/content/working-together.md) | Presence, locks, reviews, approvals |
| [The assistant](docs/src/content/assistant.md) | Optional, off by default, and what it never sends |
| [Operations and maintenance](docs/src/content/operations.md) | Backups, housekeeping, the scripts |
| [The API](docs/src/content/api.md) | `/api/v1`, scoped tokens, and what v1 promises |

## The presentation site

The page for somebody who has not run this yet lives in its own repository,
[ischyr/engy-report-presentation](https://github.com/ischyr/engy-report-presentation), and is
published with GitHub Pages. It builds this documentation into itself, so its own footer links
resolve, and it uses the screenshots below.

## Screenshots of the app

Several documentation pages carry real captures of the running app. They are taken from the demo
engagement, and from nothing else: every other engagement in a working database belongs to a real
client, so the script finds that one by name and stops if it is not there.

```bash
npm run dev        # the app and the API
npm run seed:demo  # the demo engagement
npm run shots      # into docs/public/shots, and the site's copy if it is checked out next door
```

It drives the Chrome already on the machine over the DevTools protocol, so it adds no dependency:
all it needs is navigate, type, click and screenshot, and Node has a WebSocket client built in.

## Checking it works

Twenty-four suites — the first twelve want a real database, the rest do not:

```bash
npm run test:tags     # the template language and the OOXML it produces
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
npm run test:media    # evidence, storage and the render cache
npm run test:charts   # the report charts, drawn and delivered into a document
npm run test:mail     # the message format and the SMTP conversation
npm run test:images   # the rules that scale a screenshot on its way in
npm run test:keys     # what counts as a save keystroke, and what does not
npm run test:import   # reading findings back out of a spreadsheet
npm run test:figures  # the surgery that captions and reorders evidence
npm run test:report-craft # word diffs, prose checks, the page estimate, appendices
npm run test:page-break  # starting every finding at the top of a page
npm run test:numbering   # the order findings print in, and the numbers on them
npm run test:opinion     # a second opinion on one finding, and the hours nobody logged
npm run test:bulk-users  # deleting several accounts at once, and its guards
npm run test:data-summary # what the Clients & data page counts, and who may know
npm run test:notify-prefs # what reaches your bell, and that no sender can bypass it
npm run test:mark-lines  # pointing at the one line of a pane that matters
npm run test:figure-width # how wide a screenshot prints, and two of them side by side
npm run test:evidence-api # a script putting a screenshot in the evidence bin
npm run test:media-access # who can read another team’s evidence, renders and live feed
npm run test:acceptance # a risk the client accepted, and a check done on nine of twelve hosts
npm run test:report-blocks # page breaks, callouts, footnotes, finding references, charts
npm run test:editor-blocks # and that the editor can actually write them
npm run test:audit-size # how close an engagement is to the 16 MB one can hold
npm run test:captions # numbered tables, and the lists of figures and tables at the front
npm run test:code-pane # syntax colouring, line numbers, and the marked line that survives the cut
npm run test:table-caption # the editor can name a table without breaking the table
npm run test:assistant # what the optional assistant sends, and what it never does
npm run test:chunks   # the first load stays small (needs npm run build first)
npm run test:live-poll # the signed-in app still runs one timer, not four
npm run test:findings-rows # typing beside a list of sixty findings re-renders none of them
npm run test:enumeration-rows # and typing beside the enumeration tree re-renders none of it
npm run test:library  # the library lists without its prose, and still holds every word
npm run test:library-editor # and will not save an entry it has not finished reading
npm run test:verification # the queue of what clients said, and the wall round each engagement
npm run test:timeline-window # the operation timeline opens on the latest ten
npm run test:url-state # filters live in the address bar, and the columns sort
npm run test:engagement-tabs # every tab of an engagement still opens, now that none arrives with it
npm run test:views    # saved views are one person's, and point inside this app
npm run test:sessions # where you are signed in, who may see that, and what signing out does
npm run test:share-send # the client is sent their link, and the link survives a mail failure
npm run test:client-ask # what a client can say, including on a report that is closed
npm run test:reminders # chasing a client, and the ten reasons not to
npm run test:portfolio # a client's whole history on one link, and the four walls round it
npm run test:checklist-io # a methodology out as a file and back, into any instance
npm run test:unfiled  # output pasted with nowhere to put it, and the one rule that makes that safe
npm run test:prose-limit # a write-up fits, a pasted log does not, and old work stays writable
npm run test:navigation # a click does not empty the screen, and says so if it takes a moment
npm run test:typing   # a search box stays ahead of the keys, whatever it is filtering
npm run test:optimistic # a tick draws at once, and goes back if the server refuses it
npm run smoke         # a rendered report, every page, the docs, WCAG contrast
```

They create everything they need under a `zz-` prefix and remove it afterwards.

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, run it for clients, sell what you build on it;
keep the copyright notice with it.

Every one of the 411 packages this installs is permissive too — MIT, ISC, BSD, Apache-2.0 or
Unlicense, with nothing copyleft anywhere in the tree — so there is no obligation riding along
underneath that licence. `docxtemplater` and `pizzip`, which do the .docx work, are the two worth
naming, because both offer a paid tier and neither is needed for anything this uses.

Reports you generate are yours. Nothing in this licence reaches the documents the software
produces, the templates you write, or the client data you put into it.

---

<div align="center">
<sub>Design decisions live in comments beside the code they explain. <code>git log</code> is the long-form version of this file.</sub>
</div>
