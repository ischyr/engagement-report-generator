# Scope, checklists and notes

The parts of an engagement that are not findings but decide whether the findings are any good.

## Scope

Hosts, addresses, services and what each one is. It is the list a report prints as "what was
tested", and the thing a client checks first.

A row can hold a hostname, an IP, an operating system and a set of services with ports and
products. A row with neither a hostname nor an address is flagged by the preflight, because it
prints as an empty line.

### Importing it

Nmap XML can be imported straight in. Hosts and services are merged into what is already there
rather than replacing it, so a second scan later in the test adds what it found without discarding
the notes you wrote against the first.

### Scope changes

Scope changes during a test. The **scope changes** record says what was added or removed, when,
who agreed it and through which channel — so the report can say *"the API host was added on the
14th, agreed by Dana"* rather than quietly including something nobody remembers agreeing.

## Checklists

A checklist is your methodology, written down: the things you set out to test. Attach one to an
engagement and it becomes a list of checks to tick off, grouped the way you grouped them.

Each check can be:

- **done**, with who verified it and when,
- **blocked**, with a reason — which is a result, not a failure, and prints as one,
- **assigned** to somebody, so two people can split a methodology without a conversation.

The preflight counts what is outstanding. A report that says it followed a methodology while half
of it is unticked is a claim nobody wants to defend.

There are presets to start from, and a checklist can be edited per engagement without changing the
firm's copy.

## Notes

Working notes: what you tried, what did not work, the command that finally did. They never appear
in a report.

Notes are where findings come from. A note that turns out to be a finding is written up as one —
the note stays, because how you got there is worth keeping for the retest.

## Credentials

The accounts a client gave you, encrypted at rest with `VAULT_KEY` — see
[Installing and running it](/installation).

If no key is configured the vault stays switched off rather than storing secrets in the clear, and
the page says so. Each credential can carry an expiry, so an account that only works for the test
window is visibly dead afterwards rather than mysteriously broken.

Credentials never appear in a generated report.

## Detection

For a test where it matters whether the client noticed: each action, when it was taken, how loud it
was, whether they noticed and whether they responded — with the latency between the two.

It prints as its own section, and it is usually the part of a purple-team report the client's own
team reads first.

## Time

Hours logged against the engagement, a day at a time. Six hours on the 12th means six hours; the
same entry twice means six hours, not twelve, because a timesheet that silently doubles is worse
than one that is empty.

Person-days are hours over the working day — eight, which is the only definition of a day the app
uses. The report can print the effort actually spent, which is a fact rather than the estimate.
