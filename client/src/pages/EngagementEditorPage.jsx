import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  Boxes,
  ChevronLeft,
  CircleHelp,
  Crosshair,
  FileDown,
  ScanSearch,
  History,
  Info,
  ListChecks,
  ClipboardCheck,
  ArrowRightLeft,
  ImagePlus,
  KeyRound,
  NotebookPen,
  Printer,
  MailCheck,
  Paperclip,
  PenLine,
  Radar,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Timer,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useActivity, useHere } from '../context/PresenceContext.jsx';
import { useUnsaved } from '../context/UnsavedContext.jsx';
import { downloadBlob, filenameFromResponse, formatDate, timeAgo } from '../lib/utils.js';

import { PageHeader, Tabs } from '../components/ui/Misc.jsx';
import { StateBadge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Select } from '../components/ui/Field.jsx';
import { ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { SeverityBar, SeverityLegend } from '../components/cvss/CvssEditor.jsx';

import OverviewTab from '../components/engagement/OverviewTab.jsx';
import FindingsTab from '../components/engagement/FindingsTab.jsx';
import SectionsTab from '../components/engagement/SectionsTab.jsx';
import ScopeTab from '../components/engagement/ScopeTab.jsx';
import NotesTab from '../components/engagement/NotesTab.jsx';
import QuestionsTab from '../components/engagement/QuestionsTab.jsx';
import EnumerationTab from '../components/engagement/EnumerationTab.jsx';
import CredentialsTab from '../components/engagement/CredentialsTab.jsx';
import TimeTab from '../components/engagement/TimeTab.jsx';
import DeliveryTab from '../components/engagement/DeliveryTab.jsx';
import EngagementSearch from '../components/engagement/EngagementSearch.jsx';
import SignaturesTab from '../components/engagement/SignaturesTab.jsx';
import PreflightPanel from '../components/engagement/PreflightPanel.jsx';
import ReviewReadiness from '../components/engagement/ReviewReadiness.jsx';
import ReviewerSuggestions from '../components/engagement/ReviewerSuggestions.jsx';
import HoldBanner, { HoldButton } from '../components/engagement/HoldBanner.jsx';
import TestChecksTab from '../components/engagement/TestChecksTab.jsx';
import DetectionTab from '../components/engagement/DetectionTab.jsx';
import DocumentsTab from '../components/engagement/DocumentsTab.jsx';
import EvidenceBin from '../components/engagement/EvidenceBin.jsx';
import HandoverTab from '../components/engagement/HandoverTab.jsx';
import KitTab from '../components/engagement/KitTab.jsx';
import PhishingTab from '../components/engagement/PhishingTab.jsx';
import ActivityTab from '../components/engagement/ActivityTab.jsx';

import { calculateCvss } from '../lib/cvss.js';

/**
 * The tabs every engagement has.
 *
 * `only` marks a tab that belongs to one kind of engagement. Thirteen is already a lot, and a
 * phishing campaign showing a Scope of hosts — or a network test showing a mailing list — is how
 * a tab bar stops being read.
 */
/**
 * How often to ask whether anything changed.
 *
 * The same eight seconds the sales pages poll on, for the same reason: fast enough that a colleague's
 * work appears while you are still looking at the screen, slow enough to be free. `useResource` pauses
 * it while the tab is hidden.
 */
const LIVE_MS = 8_000;

/**
 * Who moved something, for the banner.
 *
 * Taken from the finding whose timestamp changed, because that is the change a reader on this page
 * cares about and the only one the pulse can attribute. Anything else — a note, a check — comes back
 * as nobody in particular, and the banner says "somebody" rather than guessing.
 */
function whoChanged(pulse, audit) {
  const previous = new Map(
    (audit?.findings ?? []).map((finding) => [String(finding._id), new Date(finding.updatedAt ?? 0).getTime()])
  );
  for (const finding of pulse?.findings ?? []) {
    const before = previous.get(finding.id);
    if (before === undefined) continue;
    if (new Date(finding.updatedAt ?? 0).getTime() > before) return finding.updatedBy?.fullname ?? '';
  }
  return '';
}

const TABS = [
  { value: 'overview', label: 'Overview', icon: Info },
  { value: 'findings', label: 'Findings', icon: ShieldAlert },
  /*
   * Straight after Findings, on every engagement.
   *
   * The two are read together: the findings are what was wrong, the enumeration is how it was
   * reached. Putting it anywhere else in the bar separates a question from its answer, and this
   * is the one place where a reader going through the tabs in order gets the work narrated.
   *
   * It began as a red team tab, on the theory that only an operation has a route worth recording.
   * That was wrong about ordinary testing: a web application test walks the same ground — what was
   * enumerated, with what, and what came back — and the alternative was somebody's terminal
   * scrollback. Nothing in it is red-team-specific; the phases are optional and so is everything
   * else.
   */
  { value: 'enumeration', label: 'Enumeration', icon: ScanSearch },
  { value: 'sections', label: 'Sections', icon: ListChecks },
  { value: 'scope', label: 'Scope', icon: Crosshair },
  { value: 'notes', label: 'Notes', icon: NotebookPen },
  /*
   * Beside Notes, and deliberately not inside it. Both are written while the work happens, but a
   * note is ours and never leaves; a question is the client's and becomes the caveats paragraph.
   */
  { value: 'questions', label: 'Questions', icon: CircleHelp },
  { value: 'credentials', label: 'Credentials', icon: KeyRound },
  /*
   * Beside Notes for the same reason Notes sits where it does: both are what a tester produces
   * during the test and turns into findings afterwards. Evidence captured with no finding to put it
   * in used to have nowhere to live except somebody's desktop.
   */
  { value: 'evidence', label: 'Evidence', icon: ImagePlus },
  /* Next to Notes and Evidence: the three things a tester produces during a test rather than for it. */
  { value: 'handover', label: 'Handover', icon: ArrowRightLeft },
  { value: 'time', label: 'Time', icon: Timer },
  { value: 'delivery', label: 'Delivery', icon: Send },
  { value: 'signatures', label: 'Signatures', icon: PenLine },
  { value: 'checks', label: 'Checks', icon: ClipboardCheck },
  { value: 'detection', label: 'Detection', icon: Radar },
  { value: 'phishing', label: 'Sending list', icon: MailCheck, only: 'phishing' },
  // Beside Delivery in spirit: one is what we sent them, this is what they sent us.
  { value: 'documents', label: 'Documents', icon: Paperclip },
  // Beside Documents: both are the physical side of a job rather than the report.
  { value: 'kit', label: 'Kit', icon: Boxes },
  { value: 'activity', label: 'Activity', icon: History },
];

const STATES = [
  { value: 'EDIT', label: 'In progress' },
  { value: 'REVIEW', label: 'In review' },
  { value: 'APPROVED', label: 'Approved' },
];

export default function EngagementEditorPage() {
  const { id, findingId } = useParams();
  const toast = useToast();
  const { canWrite, isAdmin } = useAuth();
  const { guard, isDirty } = useUnsaved();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: audit, error, loading, reload, setData } = useResource(`/audits/${id}`);

  /*
   * Somebody else's work, arriving without a refresh.
   *
   * The pulse is a fingerprint — timestamps, counts and locks, no prose — so asking every eight
   * seconds is cheap. The engagement itself is refetched only when that fingerprint moves, which is
   * the difference between this and polling the document: the document carries every finding's HTML
   * and would be megabytes an hour for a tab somebody left open.
   */
  const pulse = useResource(`/audits/${id}/pulse`, { poll: LIVE_MS });
  /** The last fingerprint this browser has actually applied. */
  const appliedRef = useRef('');
  /** Set when a change arrived that cannot be applied yet, because something here is unsaved. */
  const [pending, setPending] = useState(null);

  useEffect(() => {
    const fingerprint = pulse.data?.fingerprint;
    if (!fingerprint) return;
    if (!appliedRef.current) {
      appliedRef.current = fingerprint;
      return;
    }
    if (fingerprint === appliedRef.current) return;

    /*
     * Never over the top of unsaved work. Reloading replaces the finding an editor is bound to, which
     * would silently throw away whatever is in it — the exact failure this whole feature is supposed
     * to prevent, arriving by a different door. So: silent when there is nothing to lose, and a
     * banner when there is.
     */
    if (isDirty()) {
      setPending({ fingerprint, at: pulse.data.at, who: whoChanged(pulse.data, audit) });
      return;
    }
    appliedRef.current = fingerprint;
    reload({ quiet: true });
  }, [pulse.data, audit, isDirty, reload]);

  /** Applies what arrived while something was unsaved, at the reader's own choosing. */
  const applyPending = () => {
    appliedRef.current = pending?.fingerprint ?? appliedRef.current;
    setPending(null);
    reload({ quiet: true });
  };
  const [generating, setGenerating] = useState(false);
  /**
   * The report this browser produced most recently, so the Delivery tab can offer to record
   * it without anybody retyping a 64-character hash. Held in state rather than persisted:
   * it describes what *this* person just downloaded, which is exactly its useful lifetime.
   */
  const [lastGenerated, setLastGenerated] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [savingState, setSavingState] = useState(false);
  /**
   * A pending move into review, held while somebody reads who is actually around.
   *
   * Only ever set when the server says there is something worth saying — a dialog that appears
   * every time, mostly to report that everything is fine, is a dialog people learn to dismiss
   * without reading, including on the day it matters.
   */
  const [reviewCheck, setReviewCheck] = useState(null);
  /** Which half of the Checks tab is showing. */
  const [checkView, setCheckView] = useState('tests');

  /**
   * Ctrl+Shift+F opens it.
   *
   * Deliberately not Ctrl+F: the browser's own find is genuinely useful inside a long
   * finding, and taking it away to offer something similar is a bad trade. Ctrl+K is already
   * the global palette, so this is the same idea one scope down.
   */
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Tells everyone else in the sidebar which engagement this person is in.
  useActivity(audit?.name ? `Editing ${audit.name}` : '');

  /**
   * The tabs this engagement actually has.
   *
   * A kind-specific tab also stays visible once it holds something, so nothing can be hidden
   * after the fact by changing the kind — a mailing list that vanished because somebody flipped a
   * dropdown would look exactly like data loss.
   */
  const tabs = useMemo(
    () =>
      TABS.filter(
        (entry) =>
          !entry.only ||
          entry.only === audit?.kind ||
          (entry.value === 'phishing' && audit?.phishingCount > 0) ||
          /* Same rule, same reason: steps already written must not disappear behind a dropdown. */
          (entry.value === 'enumeration' && (audit?.enumerationCount ?? 0) > 0)
      ),
    /* A count, because the tree itself is fetched by the tab that draws it. */
    [audit?.kind, audit?.phishingCount, audit?.enumerationCount]
  );

  /*
   * A finding in the path wins: `/engagements/:id/findings/:findingId` is a link to that
   * finding, so it opens the Findings tab whatever `?tab=` says.
   */
  const tab = findingId
    ? 'findings'
    : tabs.some((t) => t.value === searchParams.get('tab'))
      ? searchParams.get('tab')
      : 'overview';

  /*
   * And where this person is, precisely enough for somebody to be taken here.
   *
   * Below `tab` on purpose: it reads it. Above, it was a reference into the temporal dead zone that
   * only fired once an engagement had actually loaded — invisible to a render check that runs every
   * page with no data.
   *
   * The finding editor claims a more specific place on top of this one; the stack in
   * PresenceContext means opening and closing a finding does not lose the engagement underneath,
   * which is what following needs.
   */
  useHere(audit?._id ? `engagement:${audit._id}:${tab}` : '');

  // Switching tab unmounts whichever editor is open, so an unsaved finding, note or
  // section would go with it.
  const setTab = (next) =>
    guard(() => {
      // Leaving a finding's own URL means leaving the finding, so the path goes back to
      // the engagement rather than keeping a finding id that no longer applies.
      if (findingId) {
        navigate(`/engagements/${id}?tab=${next}`);
        return;
      }
      const params = new URLSearchParams(searchParams);
      params.set('tab', next);
      setSearchParams(params, { replace: true });
    });

  /** Applies a server response onto local state without a full refetch. */
  const patchAudit = useCallback(
    (patch) => setData((current) => (current ? { ...current, ...patch } : current)),
    [setData]
  );

  const severityCounts = useMemo(() => {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, none: 0 };
    for (const finding of audit?.findings ?? []) {
      const severity = calculateCvss(finding.cvssv3).baseSeverity;
      const key = severity === 'None' ? 'none' : severity.toLowerCase();
      if (key in counts) counts[key] += 1;
    }
    return counts;
  }, [audit?.findings]);

  const findingCount = audit?.findings?.length ?? 0;

  // Approved engagements are frozen for everyone but an admin.
  const editable = canWrite && (audit?.state !== 'APPROVED' || isAdmin);

  const generateReport = async () => {
    setGenerating(true);
    try {
      const response = await api.raw(`/audits/${id}/report`);
      const blob = await response.blob();
      const filename = filenameFromResponse(response, `${audit?.name ?? 'report'}.docx`);
      downloadBlob(blob, filename);
      // The server hashed exactly the bytes it sent; the Delivery tab prefills from this.
      const hash = response.headers.get('X-Report-Sha256');
      if (hash) {
        setLastGenerated({
          filename,
          hash,
          size: Number(response.headers.get('X-Report-Size')) || blob.size,
          kind: 'docx',
          at: new Date().toISOString(),
        });
      }
      toast.success('Report generated', 'Check your downloads folder.');
    } catch (err) {
      toast.fromError(err, 'Could not generate the report');
    } finally {
      setGenerating(false);
    }
  };

  const [archiving, setArchiving] = useState(false);

  /** Archiving is visibility, not permission, so it is a plain toggle rather than a dialog. */
  const setArchived = async (next) => {
    setArchiving(true);
    try {
      if (next) await api.post(`/audits/${id}/archive`, {});
      else await api.del(`/audits/${id}/archive`);
      await reload({ quiet: true });
      toast.success(
        next ? 'Archived' : 'Back in the list',
        next
          ? 'It has left the engagements list. Everything else about it is unchanged.'
          : 'It is being worked on again.'
      );
    } catch (err) {
      toast.fromError(err);
    } finally {
      setArchiving(false);
    }
  };

  const changeState = async (next, { checked = false } = {}) => {
    /*
     * Asking for a review means asking people. Find out whether they are there first — an
     * engagement handed to its only reviewer on the Friday their fortnight off begins waits a
     * fortnight, and nobody finds out until somebody wonders why sign-off never happened.
     */
    if (next === 'REVIEW' && audit.state !== 'REVIEW' && !checked) {
      try {
        const readiness = await api.get(`/audits/${id}/review-readiness`);
        if (readiness?.worthSaying) {
          setReviewCheck(readiness);
          return;
        }
      } catch {
        // A failed availability check must never block the state change: the request is the
        // point, and this is advice about it.
      }
    }

    setSavingState(true);
    try {
      const result = await api.put(`/audits/${id}/state`, { state: next });
      patchAudit({ state: next });
      setReviewCheck(null);
      // The server answers with the same readiness the dialog showed, so somebody who went
      // ahead is reminded of what they went ahead into rather than told it was all fine.
      if (result?.review?.worthSaying) {
        // The server keeps dates out of its sentence; this is the side that knows how to write
        // one, so the "back on" is appended here rather than baked in as an ISO string.
        toast.info(
          'Review requested',
          [
            result.review.summary,
            result.review.soonestBackOn
              ? `The soonest anybody is back is ${formatDate(result.review.soonestBackOn)}.`
              : null,
          ]
            .filter(Boolean)
            .join(' ')
        );
      } else {
        toast.success(`Marked as ${STATES.find((s) => s.value === next)?.label.toLowerCase()}`);
      }
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSavingState(false);
    }
  };

  if (loading) return <LoadingBlock label="Loading engagement…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!audit) return null;

  const checkCount = audit.testChecks?.length ?? 0;
  const checksDone = (audit.testChecks ?? []).filter((check) => check.done).length;

  // Same rule the server applies: a signature whose fingerprint no longer matches the
  // report covers text that reviewer never read, and an empty one either side means
  // there is nothing to compare rather than something to distrust.
  const signatures = audit.approvals ?? [];
  const staleSignatures = signatures.filter(
    (approval) =>
      audit.contentFingerprint &&
      approval.fingerprint &&
      approval.fingerprint !== audit.contentFingerprint
  ).length;
  const signedOff = signatures.length - staleSignatures;

  const COUNTS = {
    findings: findingCount,
    sections: audit.sections?.length ?? 0,
    notes: audit.notes?.length ?? 0,
    /*
     * A count, not an array. The engagement payload stopped carrying the enumeration tree — the
     * tab that draws it fetches its own — and this still read the array, so the badge quietly
     * became a zero and vanished.
     */
    enumeration: audit.enumerationCount ?? 0,
    // Progress rather than a total, so coverage is visible without opening the tab.
    checks: checkCount ? `${checksDone}/${checkCount}` : 0,
  };

  const tabsWithCounts = tabs.map((entry) =>
    COUNTS[entry.value] ? { ...entry, count: COUNTS[entry.value] } : entry
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumb={
          <Link
            to="/engagements"
            onClick={(event) => {
              event.preventDefault();
              guard(() => navigate('/engagements'));
            }}
            className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition hover:text-fg"
          >
            <ChevronLeft size={13} />
            All engagements
          </Link>
        }
        title={audit.name}
        description={
          audit.reference || audit.company || audit.auditType ? (
            <span className="flex flex-wrap items-center gap-x-1.5">
              {audit.reference ? <span>{audit.reference}</span> : null}
              {audit.reference && audit.company?._id ? <span>·</span> : null}
              {audit.company?._id ? (
                <Link
                  to={`/clients/${audit.company._id}`}
                  className="transition hover:text-brand-300"
                  title={`Everything for ${audit.company.name}`}
                >
                  {audit.company.name}
                </Link>
              ) : null}
              {audit.auditType ? (
                <>
                  <span>·</span>
                  <span>{audit.auditType}</span>
                </>
              ) : null}
            </span>
          ) : (
            'No client or engagement type set yet'
          )
        }
        actions={
          <>
            <Button
              variant="ghost"
              icon={Search}
              title="Search this engagement (Ctrl+Shift+F)"
              onClick={() => setSearchOpen(true)}
            >
              Search
            </Button>
            {/* Only when it is running: the banner carries the way back. */}
            {canWrite && !audit.onHold ? <HoldButton audit={audit} onReload={reload} /> : null}
            {/* Only once there is nothing left to do: archiving something mid-test is a mistake
                somebody would have to undo. */}
            {canWrite && !audit.archivedAt ? (
              <Button
                variant="ghost"
                icon={Archive}
                loading={archiving}
                title="Finished — put it away"
                onClick={() => setArchived(true)}
              >
                Archive
              </Button>
            ) : null}
            <Select
              value={audit.state}
              onChange={(event) => changeState(event.target.value)}
              options={STATES}
              disabled={!canWrite || savingState}
              className="h-9.5 w-36"
              wrapperClassName="w-36"
            />
            {/* Which button makes sense depends on the assigned template: a Word
                template produces a file, an HTML one is printed to PDF. */}
            {audit.template?.kind === 'html' ? (
              <Button
                as={Link}
                to={`/engagements/${audit._id}/print`}
                variant="primary"
                icon={Printer}
              >
                Print / Save as PDF
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={generating ? undefined : FileDown}
                loading={generating}
                onClick={generateReport}
                disabled={!audit.template}
                title={
                  audit.template
                    ? 'Generate the .docx report'
                    : 'Assign a template on the Overview tab first'
                }
              >
                Generate report
              </Button>
            )}
          </>
        }
      />

      {/*
        Above everything, on every tab. The failure this prevents is somebody opening the
        engagement on Monday and carrying on where they left off.
      */}
      {/*
        * Only shown when the refresh could not be silent. Everything else about this feature is
        * meant to be invisible: the numbers simply become right.
        */}
      {pending ? (
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-500/10 px-3 py-2 text-xs ring-1 ring-brand-500/25">
          <RefreshCw size={14} className="shrink-0 text-brand-300" />
          <span className="text-fg">
            {pending.who ? `${pending.who} changed` : 'Somebody changed'} this engagement while you
            have unsaved work here.
          </span>
          <span className="text-fg-subtle">
            Save yours first, or load theirs and lose what is unsaved.
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={applyPending}>
            Load their changes
          </Button>
        </p>
      ) : null}

      <HoldBanner audit={audit} editable={canWrite} onReload={reload} />

      {/*
        Said plainly rather than left to be inferred from the engagement's absence elsewhere.
        Nothing is locked — this is about which lists it appears in.
      */}
      {audit.archivedAt ? (
        <p className="flex flex-wrap items-center gap-3 rounded-card border border-line-soft bg-surface/60 px-5 py-3.5">
          <Archive size={16} className="shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">
            Archived {timeAgo(audit.archivedAt)}. It is out of the engagements list and still
            counts everywhere the question is historical. Nothing is locked.
          </span>
          {canWrite ? (
            <Button
              variant="ghost"
              size="sm"
              icon={ArchiveRestore}
              loading={archiving}
              onClick={() => setArchived(false)}
            >
              Take it back out
            </Button>
          ) : null}
        </p>
      ) : null}

      {/* Status strip: the numbers worth seeing on every tab. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-card border border-line-soft bg-surface/60 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">Status</span>
          <StateBadge state={audit.state} />
        </div>
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">
              {findingCount} finding{findingCount === 1 ? '' : 's'}
            </span>
            <SeverityLegend counts={severityCounts} className="gap-x-3" />
          </div>
          <SeverityBar counts={severityCounts} total={findingCount} />
        </div>
        {/* Visible next to the state control, because that is where somebody decides
            an engagement is finished. */}
        {(audit.reviewers ?? []).length ? (
          <button
            type="button"
            onClick={() => setTab('overview')}
            title="Who has signed this report off"
            className="flex items-center gap-2.5 rounded-md transition hover:opacity-80"
          >
            <span className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">
              Sign-off
            </span>
            <span className="text-xs font-medium text-fg">
              {signedOff}/{audit.reviewers.length}
              {staleSignatures ? (
                <span className="ml-1.5 text-[0.6875rem] font-normal text-med">
                  {staleSignatures} out of date
                </span>
              ) : null}
            </span>
          </button>
        ) : null}
        <div className="flex items-center gap-2.5">
          <span className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">Template</span>
          <span className="text-xs font-medium text-fg">
            {audit.template?.name ?? <span className="text-med">not assigned</span>}
          </span>
        </div>
      </div>

      {!editable && audit.state === 'APPROVED' ? (
        <p className="flex items-center gap-2 rounded-lg border border-low/25 bg-low/[0.06] px-4 py-2.5 text-xs text-fg-muted">
          <Info size={14} className="shrink-0 text-low" />
          This engagement is approved and locked. An administrator can move it back to review to
          make further changes.
        </p>
      ) : null}

      <Tabs options={tabsWithCounts} value={tab} onChange={setTab} />

      {tab === 'overview' ? (
        <OverviewTab audit={audit} editable={editable} onPatch={patchAudit} onReload={reload} />
      ) : null}
      {tab === 'findings' ? (
        <FindingsTab audit={audit} editable={editable} onPatch={patchAudit} onReload={reload} />
      ) : null}
      {tab === 'enumeration' ? (
        <EnumerationTab audit={audit} editable={editable} onReload={reload} />
      ) : null}
      {tab === 'sections' ? (
        <SectionsTab audit={audit} editable={editable} onPatch={patchAudit} onReload={reload} />
      ) : null}
      {tab === 'scope' ? (
        <ScopeTab audit={audit} editable={editable} onPatch={patchAudit} onReload={reload} />
      ) : null}
      {tab === 'questions' ? <QuestionsTab audit={audit} editable={editable} /> : null}
      {tab === 'notes' ? (
        <NotesTab
          audit={audit}
          editable={editable}
          /* A finding written up from a note is opened by its own URL, which is the same
             path a link to it anywhere else in the app uses. */
          onOpenFinding={(findingId2) => {
            if (!findingId2) return;
            reload({ quiet: true });
            navigate(`/engagements/${id}/findings/${findingId2}`);
          }}
        />
      ) : null}
      {tab === 'checks' ? (
        <div className="flex flex-col gap-4">
          <Tabs
            options={[
              { value: 'tests', label: 'Test checks', icon: ClipboardCheck },
              { value: 'readiness', label: 'Report readiness', icon: ShieldAlert },
            ]}
            value={checkView}
            onChange={setCheckView}
            size="sm"
          />
          {checkView === 'tests' ? (
            <TestChecksTab audit={audit} editable={editable} onReload={reload} />
          ) : (
            <PreflightPanel auditId={audit._id} onGoToTab={setTab} />
          )}
        </div>
      ) : null}
      {tab === 'credentials' ? <CredentialsTab audit={audit} editable={canWrite} /> : null}
      {tab === 'time' ? <TimeTab audit={audit} editable={canWrite} /> : null}
      {tab === 'delivery' ? (
        <DeliveryTab audit={audit} editable={canWrite} lastGenerated={lastGenerated} />
      ) : null}
      {/* Signing is not editing the report, so an approved engagement still allows it. */}
      {tab === 'signatures' ? <SignaturesTab audit={audit} editable={canWrite} /> : null}
      {tab === 'detection' ? <DetectionTab audit={audit} editable={canWrite} /> : null}
      {tab === 'phishing' ? <PhishingTab audit={audit} editable={editable} /> : null}
      {tab === 'evidence' ? <EvidenceBin auditId={audit._id} /> : null}
      {tab === 'handover' ? <HandoverTab audit={audit} editable={editable} /> : null}
      {tab === 'documents' ? <DocumentsTab audit={audit} editable={canWrite} /> : null}
      {tab === 'kit' ? <KitTab audit={audit} editable={canWrite} /> : null}

      {/*
        Never a refusal. A lead who knows their reviewer is away and wants the request queued
        anyway is not making a mistake, and a tool that declines to record reality gets worked
        around — the same rule the schedule applies to overlapping bookings.
      */}
      <Modal
        open={Boolean(reviewCheck)}
        onClose={() => setReviewCheck(null)}
        title="Before you ask for a review"
        description={`Who can look at this between ${
          reviewCheck ? formatDate(reviewCheck.from) : ''
        } and ${reviewCheck ? formatDate(reviewCheck.to) : ''}.`}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReviewCheck(null)} disabled={savingState}>
              Not yet
            </Button>
            <Button
              variant="primary"
              loading={savingState}
              onClick={() => changeState('REVIEW', { checked: true })}
            >
              Request it anyway
            </Button>
          </>
        }
      >
        <ReviewReadiness data={reviewCheck} />
        {/*
          Offered here rather than as a permanent panel: this is the moment somebody is deciding
          who should look at the report, and the only moment the answer is worth the query.
        */}
        <div className="mt-4 border-t border-line-soft pt-4">
          <ReviewerSuggestions audit={audit} onAdded={reload} />
        </div>
      </Modal>
      {tab === 'activity' ? <ActivityTab audit={audit} /> : null}

      <EngagementSearch
        open={searchOpen}
        audit={audit}
        onClose={() => setSearchOpen(false)}
        onGo={(hit) => {
          setSearchOpen(false);
          // A finding has its own URL; everything else is a tab.
          if (hit.kind === 'finding') {
            guard(() => navigate(`/engagements/${id}/findings/${hit.id}`));
            return;
          }
          const params = new URLSearchParams(searchParams);
          params.set('tab', { section: 'sections', note: 'notes', check: 'checks' }[hit.kind]);
          guard(() => setSearchParams(params, { replace: true }));
        }}
      />
    </div>
  );
}
