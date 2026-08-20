# Your first report

Engagement to document, in about ten minutes. This assumes you have signed in as the admin the
seed created.

## 1. Put a template in

**Templates → Upload .docx.** Use the starter that ships with the app if you have nothing else to
hand:

```bash
npm run make:template
```

That writes a plain report template into the template store, tagged and ready. Your own is better —
see [Templates](/templates) for how to tag one — but the starter is enough to see the whole loop.

When it uploads, the page shows the tags it found and any it does not recognise. A misspelling is
listed here rather than discovered as a gap in a client's document.

## 2. Add a client

**Clients & Data → Companies.** A name and a registered address. The address is what an NDA and a
permission to attack print as the second party, so it is worth getting right once.

## 3. Start an engagement

**Engagements → New.** It needs a name, a client and a type. The type is a blueprint: picking
*Web Application Penetration Test* brings in the sections that kind of report normally has, so you
start with an executive summary and a methodology rather than an empty document.

Set the testing window while you are there. Clients check the dates they paid for.

## 4. Write a finding

**Findings → New finding.**

- **Title.** What is wrong, in the words the client will read.
- **CVSS.** Pick the vector; the score and the severity follow. If your team disagrees with the
  score, override the severity — you will be asked why, and the reason prints beside it.
- **Description, observation, remediation.** Rich text: headings, lists, tables, code blocks,
  screenshots. All of it becomes real Word formatting in your template's own styles.
- **Affected scope.** Where it is.

In a hurry? The line at the top of the findings list takes a title and nothing else. It leaves a
draft, marked as one, for you to write up later.

## 5. Add a screenshot

Paste it straight into the description — the clipboard works — or drag a file in. Then, before it
goes anywhere:

- crop it,
- **redact** anything that should not leave the building. The redaction is applied to the image
  itself, not drawn over it, so there is nothing underneath to recover.

## 6. Generate

**Generate report**, top right. Two things happen first:

- **Preflight** looks for what would embarrass you: an untitled finding, an incomplete CVSS
  vector, placeholder text still in a section, a finding with no remediation. Blockers stop the
  generation, warnings do not.
- The template is filled in and the document downloads.

Open it in Word. It should be your template, with your findings in it.

> [!tip]
> If a number comes out blank or a section is empty, do not start editing the .docx. Go to
> **Templates → Test render**, which renders your template against sample data and tells you which
> tag resolved to nothing and why. [Troubleshooting](/troubleshooting) lists the usual causes.

## 7. Record what you sent

Once the report is with the client, **Delivery → Record a delivery**: the version, who it went to,
and the hash of the exact file. Months later, "which report do they actually have?" is a question
with an answer rather than an argument.

The **How each document was generated** card beside it fills itself in: which template version made
each file, under which settings, and what changed between one and the next.

## Where to go from here

- [Findings](/findings) — severity overrides, merging, bulk actions, retests.
- [The template language](/template-language) — every tag, every filter.
- [Working together](/working-together) — what happens when two people open the same finding.
