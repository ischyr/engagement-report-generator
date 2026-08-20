import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, ListChecks, NotebookPen, Search, ShieldAlert } from 'lucide-react';

import { htmlToSnippet } from '../../lib/utils.js';

import { Modal } from '../ui/Modal.jsx';
import { SearchInput } from '../ui/Misc.jsx';
import { Badge, SeverityBadge } from '../ui/Badge.jsx';
import { EmptyState } from '../ui/Feedback.jsx';
import { calculateCvss } from '../../lib/cvss.js';

/** Where a hit was, and what it opens. */
const KINDS = {
  finding: { label: 'Finding', icon: ShieldAlert, tab: 'findings' },
  section: { label: 'Section', icon: ListChecks, tab: 'sections' },
  note: { label: 'Note', icon: NotebookPen, tab: 'notes' },
  check: { label: 'Check', icon: ClipboardCheck, tab: 'checks' },
};

/** Rich text as plain text, for matching and for the snippet. */
const plain = (html) => htmlToSnippet(html ?? '', 100_000);

/**
 * The matched phrase in context.
 *
 * A hit is only useful if you can see *which* one it is: a finding that mentions "JWT" three
 * times and a note that mentions it once look identical as titles.
 */
function snippetAround(text, needle, span = 70) {
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return text.slice(0, span * 2);
  const from = Math.max(0, at - span);
  const to = Math.min(text.length, at + needle.length + span);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

function Highlighted({ text, needle }) {
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-brand-500/25 px-0.5 text-fg">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/**
 * Search inside one engagement.
 *
 * The global palette finds engagements and findings across the instance; once you are inside a
 * long one, "that thing about the JWT" meant opening findings one at a time. Everything here is
 * already loaded in the browser — findings, sections, notes and checks all arrive with the
 * engagement — so this needs no endpoint and answers as fast as you type.
 */
export default function EngagementSearch({ open, audit, onClose, onGo }) {
  const [term, setTerm] = useState('');

  useEffect(() => {
    if (open) setTerm('');
  }, [open]);

  const needle = term.trim().toLowerCase();

  const results = useMemo(() => {
    if (needle.length < 2) return [];
    const hits = [];
    const add = (kind, id, title, haystacks, extra) => {
      for (const [where, value] of haystacks) {
        const text = value ?? '';
        if (!text.toLowerCase().includes(needle)) continue;
        hits.push({
          kind,
          id,
          title,
          where,
          snippet: snippetAround(text, needle),
          ...extra,
        });
        return; // One hit per item: a list of the same finding five times is not a result list.
      }
    };

    for (const finding of audit.findings ?? []) {
      const cvss = calculateCvss(finding.cvssv3);
      add(
        'finding',
        finding._id,
        finding.title,
        [
          ['title', finding.title],
          ['category', [finding.category, finding.vulnType].filter(Boolean).join(' · ')],
          ['description', plain(finding.description)],
          ['observation', plain(finding.observation)],
          ['remediation', plain(finding.remediation)],
          ['proof of concept', plain(finding.poc)],
          ['affected', plain(finding.scope)],
        ],
        { severity: cvss.baseSeverity, score: cvss.baseScore }
      );
    }
    for (const section of audit.sections ?? []) {
      add('section', section.field, section.name || section.field, [
        ['name', section.name],
        ['text', plain(section.text)],
      ]);
    }
    for (const note of audit.notes ?? []) {
      add('note', note._id, note.title || 'Untitled note', [
        ['title', note.title],
        ['text', plain(note.content)],
      ]);
    }
    for (const check of audit.testChecks ?? []) {
      add('check', check._id, check.title, [
        ['title', check.title],
        ['category', check.category],
        ['description', check.description],
        ['result', check.result],
      ]);
    }
    return hits;
  }, [audit, needle]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Search this engagement"
      description="Findings, narrative sections, notes and checks — including the text inside them. Nothing leaves the browser; it is all already here."
      size="lg"
    >
      <div className="flex flex-col gap-3">
        <SearchInput
          value={term}
          onChange={setTerm}
          placeholder="A host, a parameter, half a sentence…"
          autoFocus
        />

        {needle.length < 2 ? (
          <p className="text-xs text-fg-subtle">Type at least two characters.</p>
        ) : results.length === 0 ? (
          <EmptyState
            icon={Search}
            title="Nothing in this engagement matches"
            description="The global search at the top of the window looks across every engagement you are on."
          />
        ) : (
          <>
            <p className="text-[0.6875rem] text-fg-subtle">
              {results.length} match{results.length === 1 ? '' : 'es'}, one per item.
            </p>
            <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
              {results.map((hit) => {
                const kind = KINDS[hit.kind];
                return (
                  <li key={`${hit.kind}-${hit.id}`}>
                    <button
                      type="button"
                      onClick={() => onGo(hit)}
                      className="w-full rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-left transition hover:border-brand-500/40"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <kind.icon size={12} className="shrink-0 text-fg-subtle" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                          <Highlighted text={hit.title} needle={needle} />
                        </span>
                        {hit.severity ? (
                          <SeverityBadge severity={hit.severity} score={hit.score} />
                        ) : (
                          <Badge tone="neutral">{kind.label}</Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-fg-muted">
                        <span className="text-fg-subtle">in {hit.where}: </span>
                        <Highlighted text={hit.snippet} needle={needle} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
