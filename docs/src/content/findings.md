# Findings

A finding is the unit of work and the unit of the report. Everything here ends up in the document.

## The fields

| Field | Notes |
| --- | --- |
| **Title** | What is wrong, in the client's words. It is what the report prints as the heading |
| **Type and category** | How the report groups things. Both come from the taxonomy under Clients & Data |
| **CVSS** | The vector. The score and the severity follow from it |
| **Severity override** | A severity the team stands behind when it differs from the score. A reason is required |
| **Priority and complexity** | Optional. How urgent, and how hard to fix |
| **Description, observation, remediation** | Rich text — headings, lists, tables, code, screenshots |
| **Proof of concept** | The steps. Also rich text |
| **Affected scope** | Where it is |
| **References** | One per line |
| **Status** | Not fixed, retesting, or fixed |

## Severity, and disagreeing with it

The severity comes from the CVSS vector. When the vector is wrong for your client — a compensating
control, a network that is not reachable the way the vector assumes — override it.

The app asks why, and refuses to store the override without a reason, because an unexplained
departure from a published score is exactly what a client disputes. The reason prints beside the
score, and the list shows both:

```text
Low  10.0   scored Critical
```

## Numbering

Each finding carries an `identifier`, which is what the report prints as `VULN-03`. It is allocated
when the finding is written, so a reordered report can print 01, 04, 07 in that order.

**Renumber** — on the bulk bar — puts them back in the order shown. It is refused once the
engagement has been delivered, because the client has written their remediation tickets against
those numbers, and while anything restorable is in the trash, because a restore brings a finding
back carrying its own.

## Doing one thing to many

Tick the checkbox on each row — shift-click takes a run, which after a sort by score is usually
exactly the set you want — and a bar appears at the bottom of the page.

It can set the **severity** (with one reason for all of them), the **status**, the **category**,
the **type**, the **priority** and the **complexity**; **move or copy** them to another engagement;
**delete** them; and **renumber** the whole list.

Only those fields — never prose. Bulk-editing a description would need a version per finding and
would be worse than doing it one at a time. Because nothing in the bar touches text, a colleague
retyping one of those descriptions cannot lose a word to somebody re-scoping the batch.

> [!note]
> Anything somebody else has **locked** is skipped and named — "6 changed, 2 skipped, held by Ana"
> — rather than failing the whole batch. One person reading a write-up must not block a change to
> the other thirty-nine.

## Merging two of the same thing

Two people write the same issue more often than anybody admits: *IDOR on document download* and
*missing authorisation on /documents*. **Merge** folds one into the other.

It concatenates rather than choosing. Each rich field becomes the survivor's text followed by the
other's, evidence and all; references are unioned; the severity is the **higher** of the two.
Nothing is summarised and nothing is dropped — the result reads like two people wrote it, which is
true, and is much easier to edit down than a lost paragraph is to recover.

The other finding goes to the same trash a delete uses, so a merge is reversible for as long as a
deletion is.

## Moving one somewhere else

**Move** files a finding on the engagement it belongs to; **copy** leaves the original alone. Either
way it gets a new number on the engagement it lands on, and its review comments stay behind — they
were a conversation about the other report.

Evidence travels with a move, and with a copy to the *same* client. A copy to a **different** client
leaves the screenshots behind: the alternative is one client's evidence in another's report.

## Deleting one

A deleted finding goes to the trash and can be restored whole. It is often an hour of writing with
screenshots attached, and the only thing between it and oblivion used to be a confirmation dialog.

## Retests

A finding carries a status — **not fixed**, **retesting**, **fixed** — and a *history* of them:
who moved it, when, and that it was marked fixed once before and came back. That is the record a
retest argument turns on, and it used to be reconstructed from memory.

The bulk bar sets the status across a selection, which is how a fix window ends: eleven findings
marked retested in one go, each one appending to its own history.

## What has been seen before

If the same issue was reported to this client before, the finding says so — which engagement, which
reference, when. Nothing infers it: it comes from the other engagements for that company.

## Comments

Comments on a finding are internal and never appear in the report, so reviewers can be blunt. They
can be attached to a specific field, mention a colleague — who gets a notification — and be marked
resolved.
