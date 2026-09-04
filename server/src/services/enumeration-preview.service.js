/**
 * The enumeration chapter, as HTML, for reading before committing to a document.
 *
 * Built from the *report* data rather than from the engagement: the internal rows are already gone,
 * the print policy has already been applied, the numbering has already closed over the gaps. That is
 * the whole value — a preview assembled from the raw tree would answer a different question from the
 * one being asked, and would answer it wrongly in exactly the cases that matter.
 *
 * The rich fields arrive already sanitised, because the caller builds the data with `target: 'html'`
 * and `expandRichFields` runs them through `sanitizeHtml`. Everything this file adds is escaped here.
 */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/*
 * How much of a pane the preview draws.
 *
 * A chapter of sixty steps at four hundred lines each is two megabytes of HTML and twenty-four
 * thousand lines for the browser to lay out inside a modal — measured, on an operation of ordinary
 * size. The question the preview answers is *does this read well*, and nobody answers it by reading
 * the four hundredth line of a subdomain sweep.
 */
const PREVIEW_LINES = 12;
const PREVIEW_ROWS = 8;

/**
 * The two sentences below say opposite things and must never be confused.
 *
 *   - the print policy cut it   → the document will not have those lines either
 *   - the preview cut it        → the document will have them; this panel is just not showing them
 *
 * Getting that backwards would be the worst possible bug in a preview: somebody trims a pane to
 * five lines, sees five lines here, and ships a report they believe is complete — or the reverse,
 * and pads a chapter that was never short. So the wording is explicit about which one happened,
 * and the preview's own trimming always names the full figure.
 */
const previewCut = (shown, total, unit) =>
  `<p class="preview-cut">Showing ${shown} of ${total} ${unit} — the report prints all ${total}.</p>`;

/** A `<pre>` pane cut down to its first lines, keeping the markup the report would produce. */
const shorten = (html, limit) => {
  const match = String(html ?? '').match(/^([\s\S]*?<code[^>]*>)([\s\S]*?)(<\/code>[\s\S]*)$/);
  if (!match) return { html, cut: 0, total: 0 };
  const lines = match[2].split('\n');
  if (lines.length <= limit) return { html, cut: 0, total: lines.length };
  return {
    html: `${match[1]}${lines.slice(0, limit).join('\n')}${match[3]}`,
    cut: lines.length - limit,
    total: lines.length,
  };
};

/** A table cut down to its first rows, the same way. */
const shortenTable = (html, limit) => {
  const rows = String(html ?? '').match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  /* The first is the header, so the limit applies to what follows it. */
  const body = rows.slice(1);
  if (body.length <= limit) return { html, cut: 0, total: body.length };
  const kept = [rows[0], ...body.slice(0, limit)];
  return {
    html: String(html).replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${kept.slice(1).join('')}</tbody>`),
    cut: body.length - limit,
    total: body.length,
  };
};

const meta = (step) => {
  const bits = [];
  if (step.tool) bits.push(`Tool: ${esc(step.tool)}`);
  if (step.target) bits.push(`Target: ${esc(step.target)}`);
  if (step.ranAt) bits.push(esc(step.ranAt));
  if (step.phaseLabel) bits.push(esc(step.phaseLabel));
  if (step.statusLabel) bits.push(`Outcome: ${esc(step.statusLabel)}`);
  return bits.join(' &middot; ');
};

/**
 * One chapter of HTML.
 *
 * Deliberately plain: headings, paragraphs, `pre` and `table`. The point is to read the words in the
 * order the document will put them, not to look like Word — a preview that imitated the template's
 * styling would invite somebody to trust it about fonts and margins, which it cannot know.
 */
export function enumerationChapterHtml(data, { extract = false } = {}) {
  const steps = data?.enumeration ?? [];
  if (!steps.length) {
    return '<p class="empty">Nothing recorded yet, so this chapter would not appear in the report at all.</p>';
  }

  const summary = data.enumerationSummary ?? {};
  const out = [];

  out.push('<h1>Enumeration</h1>');
  if (summary.toolList) out.push(`<p>Tooling used: ${esc(summary.toolList)}</p>`);
  out.push(
    `<p>${summary.steps ?? 0} steps recorded across ${summary.groups ?? 0} sections, ` +
      `${summary.withOutput ?? 0} with tool output, ${summary.ledToFindings ?? 0} written up as findings.</p>`
  );
  if ((summary.byStatus ?? []).length) {
    out.push(
      `<p>Outcomes: ${summary.byStatus.map((row) => `${row.count} ${esc(row.label)}`).join('. ')}.</p>`
    );
  }
  if (extract) {
    out.push(
      '<p class="preview-cut">Long output is shortened in this panel. Every line is in the report ' +
        'itself — where a pane is short because you asked for it to be, it says so under that pane.</p>'
    );
  }
  if (summary.internal) {
    out.push(
      `<p class="held">${summary.internal} further step(s) were recorded internally and are not reproduced here.</p>`
    );
  }

  for (const step of steps) {
    if (step.isGroup) {
      out.push(`<h2>${esc(step.number)}&nbsp; ${esc(step.title)}</h2>`);
      if (step.hasSummary) out.push(`<p class="summary">${esc(step.summary)}</p>`);
      continue;
    }

    out.push(`<h3>${esc(step.number)}&nbsp; ${esc(step.title)}</h3>`);
    const line = meta(step);
    if (line) out.push(`<p class="meta">${line}</p>`);
    if (step.hasSummary) out.push(`<p class="summary">${esc(step.summary)}</p>`);
    if (step.hasCommand) out.push(`<pre class="command">${esc(step.command)}</pre>`);

    /*
     * A table where the report would print one, the pane where it would print that — the same
     * choice the template makes, so the preview cannot flatter the document.
     */
    if (step.hasTable) {
      const table = extract
        ? shortenTable(String(step.rich?.outputTable ?? ''), PREVIEW_ROWS)
        : { html: String(step.rich?.outputTable ?? ''), cut: 0, total: 0 };
      out.push(table.html);
      if (table.cut) out.push(previewCut(PREVIEW_ROWS, table.total, 'rows'));
    } else if (step.hasOutput) {
      const pane = extract
        ? shorten(String(step.rich?.output ?? ''), PREVIEW_LINES)
        : { html: String(step.rich?.output ?? ''), cut: 0, total: 0 };
      out.push(pane.html);
      if (pane.cut) out.push(previewCut(PREVIEW_LINES, pane.total, 'lines'));
    }
    /*
     * The print policy's own truncation, which is a different statement entirely: these lines are
     * not going into the document at all. Said after the preview's note, never instead of it.
     */
    if (step.printTruncated) {
      out.push(
        `<p class="note">Extract only — ${step.printOmitted} of ${step.printTotal} ${esc(step.printUnit)} are not printed.</p>`
      );
    }

    /*
     * The marked lines, under the output they were marked in.
     *
     * Above the write-up rather than below it: the notes are about the pane immediately overhead,
     * and the write-up is the prose that follows from them.
     */
    if (step.hasNotes) {
      out.push(
        `<ul class="notes">${step.notes
          .map(
            (note) =>
              `<li><code>${esc(note.line)}: ${esc(note.snippet)}</code>` +
              `${note.text ? ` &mdash; ${esc(note.text)}` : ''}</li>`
          )
          .join('')}</ul>`
      );
    }

    if (step.hasContent) out.push(String(step.rich?.content ?? ''));
    if (step.hasLedTo) {
      out.push(
        `<p class="note">Written up as: ${step.ledToFindings
          .map((finding) => esc([finding.identifier, finding.title].filter(Boolean).join(' ')))
          .join(', ')}</p>`
      );
    }
  }

  return out.join('\n');
}

export default enumerationChapterHtml;
