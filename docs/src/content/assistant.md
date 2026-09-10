# The assistant

Optional, off, and configured like the mail server. An instance that never fills it in behaves
exactly as it did before the feature existed — the four buttons it adds are not disabled, they are
not drawn at all.

It does four things, and it decides nothing.

## What it can be asked

**A first draft of the executive summary.** On the Sections tab, beside a section whose name reads
as a summary. Written from this engagement's findings, their severities and its scope — nothing
else. It arrives in the editor unsaved.

**A house-style rewrite of a passage.** In the finding editor, beside the description, the impact
and the remediation. It is told to keep every fact — hosts, ports, versions, parameters, and any
caveat such as *only when authenticated*, which are the sentences that get argued about later. Read
it against what you wrote; it is a draft, not a correction.

**One line for a tool run.** On the Enumeration workbench, beside *One-line summary*. It reads the
step's saved output and says what the run established — *"Three live hosts; staging answered but
was not in the scope document"* — which is what the report prints above the step. Disabled while
the step has unsaved changes, because it reads what is in the database rather than what is in the
box.

**A library match.** In the finding editor, on the *Reuse this write-up* card. Your own library is
shortlisted **here**, by the search this app already has, and only those few titles go anywhere.
Accepting a match fills the fields that are **empty** and no others — nothing you have written is
touched.

## What leaves the machine

This is the first thing in the app that sends a client's material to a computer you do not run, and
the material is a penetration test. So:

- **The proof of concept is never sent.** Not redacted — excluded, by name, in the code that builds
  every prompt. It is the field that holds the working exploit and the credential that worked.
- **Screenshots are never sent.** A rewrite of a passage that contains one is refused outright
  rather than quietly returning a version without it, which would lose evidence from a report.
- **Everything else is redacted first.** Private keys, `Authorization` headers, cookies, JWTs, keys
  with a recognisable prefix, `password=`, `-p` on a command line, pwdump lines, crypt hashes and
  credentials in a URL. What was removed is counted and shown to you under every answer.
- **Restricted engagements are refused**, separately, and by default. Marking work restricted
  already means it is handled more carefully than the rest; sending it to a third party because a
  general setting happened to be on would make the marking meaningless. There is a switch, and an
  administrator has to find it.

The redaction is a floor, not a guarantee, and is not written as though it were one. A pattern list
cannot recognise a password that looks like an English word. If that matters on your work, point the
endpoint at a model running on your own hardware — which is the reason the endpoint is configurable.

## What it never does

**It never writes.** No route behind these buttons touches an engagement. Every answer arrives in a
dialog, and only a click puts it in the editor — where the ordinary save, the ordinary conflict
check and the ordinary unsaved-work guard all still apply.

**It never invents.** Every prompt is given the facts rather than asked to recall them, and every
one of them says: use only what you are given, and if it is too thin, say less. That is an
instruction, not a guarantee — which is exactly why nothing is applied without somebody reading it.

## Setting it up

Settings → Assistant, and it looks like the mail card above it on purpose.

| Field | What it is |
| --- | --- |
| Provider | A preset. Fills in the endpoint and the wire shape so you do not have to remember a base URL. |
| Wire shape | Which protocol answers at that URL: the Messages API, or chat completions. |
| Model | Exactly as your provider writes it. |
| Endpoint | A base URL. Empty means the provider's own. **This is what makes a local model possible.** |
| API key | Write-only. Stored encrypted under `VAULT_KEY`, never sent back to the browser. `ASSISTANT_API_KEY` in the environment overrides it, and then nothing sensitive is in the database at all. |
| Timeout | Seconds. A model on a laptop is slower than an API. |
| House style | Put in front of every prompt. *"Third person throughout. Never 'malicious actor'. Remediation is numbered steps."* Your conventions win. |

### Which provider

Five presets, and the list is not the point — the endpoint is. Anything that answers either wire
shape at a URL works, whether it is on the list or not.

| Preset | Wire shape | Endpoint | Key |
| --- | --- | --- | --- |
| Anthropic (Claude) | Messages API | the provider's own | yes |
| OpenAI | Chat completions | `https://api.openai.com/v1` | yes |
| DeepSeek | Chat completions | `https://api.deepseek.com` | yes |
| Ollama, on this machine | Chat completions | `http://127.0.0.1:11434/v1` | no |
| Something else | either | yours | as needed |

**DeepSeek** wants a key from `platform.deepseek.com` and one of two model names:
`deepseek-v4-pro`, which is the capable one and the preset's default, or `deepseek-v4-flash`, which
is faster and cheaper and suits the one-line enumeration summaries. Both names track the current
version, so neither needs changing when a new one ships.

It also publishes an Anthropic-compatible surface, and this app speaks that too: choose the
**Messages API** wire and set the endpoint to `https://api.deepseek.com/anthropic`. Same key, same
models, same answers. Either route works — the preset takes the shorter one.

> [!note]
> **Reasoning models and the token budget.** Both DeepSeek models think before answering, and the
> thinking is charged against the same budget as the answer — so a request that allows 200 tokens
> for a one-line summary gets an *empty* answer, not a short one, because the budget was gone before
> the answer began. The app allows for this in two ways: every request carries headroom on top of
> the job's own budget, and the DeepSeek preset asks for `reasoning_effort: "low"`, which keeps the
> thinking proportionate to a paragraph. If you point **Something else** at a reasoning model, it
> gets the headroom but not the effort setting, and will cost more per draft than it needs to.

If an answer ever does run out of room, the dialog says so rather than showing you a blank: either
*"the model spent its whole token budget thinking"*, or the half-answer it managed with a note that
it was cut off.

> [!note]
> Azure, OpenRouter, Together, Groq, Fireworks and the rest all answer the chat-completions shape.
> Choose **Something else**, paste the base URL up to and including the version segment, and put in
> the model id as that provider writes it.

Then **Test it**. The test uses what is on the form rather than what is saved, because making you
save a broken configuration in order to discover that it is broken is the wrong way round. When it
fails it prints the provider's own words — *"your credit balance is too low"*, *"model not found"*,
*"connection refused"*, or a safety refusal with its category. Those are four different afternoons
and we are not going to flatten them into "could not connect".

### Keeping it on your own hardware

Choose **Ollama, on this machine**, pull a model, and leave the key empty. The endpoint defaults to
`http://127.0.0.1:11434/v1` and nothing leaves the machine. Anything else that serves an
OpenAI-compatible endpoint locally — vLLM, LM Studio, llama.cpp — works the same way; change the
port.

> [!note]
> The four jobs switch on and off individually. A team that wants a hand with the executive summary
> and would rather nothing touched a finding is a configuration, not a fork.

## What it costs

Each button is one request. There is a ceiling of sixty an hour per person — not a security
boundary, everybody here has an account, but a bill: a held-down key should cost an apology rather
than a month's budget. Nobody writing a report will ever see it.

The summary sends the findings as a list of one-line entries rather than in full; the enumeration
job trims a long output from the middle, keeping both ends, because a tool announces itself on its
first line and concludes on its last.
