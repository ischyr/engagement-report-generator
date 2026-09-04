# Questions and assumptions

Every test accumulates them. Is the staging host in scope? Is this behaviour intentional? Who owns
that box? May we test the payment flow with real cards? They are asked in email, answered in a
meeting, and three weeks later the report needs a caveats paragraph — which gets reconstructed from
memory, if it gets written at all.

The **Questions** tab is that list, kept as it happens.

## The three states

| | |
| --- | --- |
| **Waiting on them** | Asked, nobody has answered. Something to chase, and by default not something to publish. |
| **They answered** | Recorded with who settled it and when. |
| **We assumed** | Nobody answered, so a decision was made and the work carried on. |

The third one is the point. An unanswered question does not stop a test: somebody assumes something
and continues, and *that assumption* is what the report has to declare. Recording it as an
assumption rather than as an unanswered question is the difference between a caveat the client can
challenge and a gap nobody mentions.

## Getting them into the report

Anything marked to print is available to templates:

```text
{{#assumptions}}
{{ .text }} — {{ .answer }}
{{/assumptions}}
```

`{{#questions}}` is the whole printable log, `{{#assumptions}}` is narrowed to what was assumed, and
`{{ openQuestions }}` counts what was never settled — worth a sentence, or worth chasing before the
report goes out. `{{#allQuestions}}` includes the ones held back from the client, for an internal
copy.

Settling a question stamps who did it and when, and moving one back to waiting takes that off again:
a question edited months later should not look as though it was answered today.
