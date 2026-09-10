import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  EyeOff,
  History,
  Eye,
  LayoutList,
  Maximize2,
  Variable,
  Plus,
  ScanSearch,
  Search,
  Sheet,
  Star,
  Trash2,
  X,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import { offerUndo } from '../../lib/undo.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { useUnsaved, useUnsavedWork } from '../../context/UnsavedContext.jsx';
import { cn, downloadBlob } from '../../lib/utils.js';
import { announceMentions } from '../../lib/mentions.js';

import { Card } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import ConflictDialog from '../ui/ConflictDialog.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import EnumerationTree from './EnumerationTree.jsx';
import EnumerationEditor from './enumeration/EnumerationEditor.jsx';
import {
  BLANK,
  MAX_PANE,
  MIN_PANE,
  PANE_KEY,
  PHASES,
  PRINT_MODES,
  STATUSES,
  draftOf,
  filterRows,
  idOf,
  lightenStep,
  pickBody,
  readFolds,
  relocate,
  subtreeOf,
  writeFolds,
} from './enumeration/tree-ops.js';
import {
  HistoryDialog,
  JumpDialog,
  PreviewDialog,
  SavePresetDialog,
  ScopeDialog,
  VarsDialog,
} from './enumeration/dialogs.jsx';

export default function EnumerationTab({
  audit,
  editable,
  onReload,
  layout = 'tab',
  treeHidden = false,
}) {
  const asPage = layout === 'page';
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, reload, setData } = useResource(`/audits/${audit._id}/enumeration`, {
    initial: [],
  });

  const [selectedId, setSelectedId] = useState(null);
  /**
   * The body of the step being read, fetched on its own.
   *
   * The tree arrives without any output at all — measured at 6KB against 1.44MB for a sixty-step
   * operation — and this holds the one step somebody is actually looking at. Kept as a map rather
   * than a single value so going back to a step already read is instant.
   */
  const [details, setDetails] = useState({});
  const [detailBusy, setDetailBusy] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  /**
   * The step the draft is a complete draft *of*.
   *
   * Null while a step's body is still on its way. The write-up editor waits for this rather than for
   * the selection, and that is not a nicety: the editor reports a change whenever its value prop
   * moves under it, so mounting it with an empty write-up and then filling it in makes the step look
   * edited the moment it is opened — which hides the output pane behind an unsaved-changes state
   * nobody asked for.
   */
  const [draftFor, setDraftFor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [moving, setMoving] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readFolds(audit._id));
  const [dragId, setDragId] = useState(null);
  const [dropHint, setDropHint] = useState(null);
  const [promoting, setPromoting] = useState(null);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [scoping, setScoping] = useState(null);
  const [presets, setPresets] = useState(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetBusy, setPresetBusy] = useState('');
  const [filter, setFilter] = useState({ text: '', tool: '', phase: '', status: '', flag: '' });
  const [picked, setPicked] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [savingPreset, setSavingPreset] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Whether a section's run fields are showing, when it has nothing in them. */
  const [showRunFields, setShowRunFields] = useState(false);
  const [vars, setVars] = useState(null);
  const [varsOpen, setVarsOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  /** Whether the preview is showing whole panes. Off by default — see `PreviewDialog`. */
  const [previewFull, setPreviewFull] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  const { guard } = useUnsaved();

  /*
   * The width of the tree pane, remembered per person.
   *
   * Only meaningful in the page layout; declared unconditionally because a hook cannot be. Stored
   * rather than derived: how wide the tree wants to be depends on how somebody names their sections,
   * which nothing here can know.
   */
  const [paneWidth, setPaneWidth] = useState(() => {
    const stored = Number(window.localStorage?.getItem(PANE_KEY));
    return Number.isFinite(stored) && stored >= MIN_PANE && stored <= MAX_PANE ? stored : 340;
  });
  const splitRef = useRef(null);
  const dragging = useRef(false);

  const startResize = useCallback((event) => {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  /*
   * The move and release listeners go on the window, not on the handle: a pointer leaves a
   * five-pixel target constantly mid-drag, and a handle-scoped listener would drop the resize
   * wherever the mouse happened to be at that moment.
   */
  useEffect(() => {
    if (!asPage) return undefined;
    const onMove = (event) => {
      if (!dragging.current) return;
      const left = splitRef.current?.getBoundingClientRect().left ?? 0;
      setPaneWidth(Math.min(MAX_PANE, Math.max(MIN_PANE, Math.round(event.clientX - left))));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage?.setItem(PANE_KEY, String(paneWidth));
      } catch {
        /* A browser refusing storage is not worth an error; the width resets next time. */
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [asPage, paneWidth]);

  /*
   * Ctrl+Shift+E opens the switcher.
   *
   * Not Ctrl+K, which is the global palette, and not Ctrl+Shift+F, which is the engagement search —
   * this is the same idea one scope further down, so it takes the next free combination rather than
   * stealing one that already means something.
   */
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== 'e') return;
      event.preventDefault();
      setJumpOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useUnsavedWork(dirty, 'This enumeration step', () => save());

  /* The server sends reading order with a depth on each row; trusting it keeps one definition. */
  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  /*
   * The light row with its body laid over it, once that has arrived.
   *
   * The row is the authority on where the step sits in the tree and the detail on what is in it, so
   * the light row goes underneath: a stale detail cannot move a step somewhere it is not.
   */
  const selected = useMemo(() => {
    const row = rows.find((entry) => idOf(entry._id) === idOf(selectedId));
    if (!row) return null;
    const detail = details[idOf(selectedId)];
    return detail ? { ...detail, ...row, ...pickBody(detail) } : row;
  }, [rows, selectedId, details]);
  /** Whether the body is here yet — the editor waits for it rather than showing an empty box. */
  const bodyReady = Boolean(details[idOf(selectedId)]);

  const filtering = Boolean(
    filter.text.trim() || filter.tool || filter.phase || filter.status || filter.flag
  );
  const matched = useMemo(() => filterRows(rows, filter), [rows, filter]);

  /** The tools actually used here, for the filter — not a list of every tool in the world. */
  const toolsUsed = useMemo(() => {
    const seen = new Map();
    for (const row of rows) {
      const tool = String(row.tool ?? '').trim();
      if (tool && !seen.has(tool)) seen.set(tool, true);
    }
    return [...seen.keys()].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  /**
   * Rows actually on screen: a collapsed heading hides its branch.
   *
   * Folding is ignored while filtering. Hiding a match because its section happened to be collapsed
   * would make the search look broken, and the point of a filter is to find the row you cannot see.
   */
  const visible = useMemo(() => {
    if (filtering) return matched;
    const hidden = new Set();
    for (const id of collapsed) {
      for (const child of subtreeOf(rows, id)) if (child !== idOf(id)) hidden.add(child);
    }
    return rows.filter((row) => !hidden.has(idOf(row._id)));
  }, [rows, collapsed, filtering, matched]);

  const siblings = useMemo(
    () => (selected ? rows.filter((row) => idOf(row.parent) === idOf(selected.parent)) : []),
    [rows, selected]
  );
  const position = siblings.findIndex((row) => idOf(row._id) === idOf(selectedId));

  useEffect(() => {
    if (!selectedId && rows.length) setSelectedId(rows[0]._id);
  }, [rows, selectedId]);

  /* One step's body, when it is opened. Cached, so going back to it costs nothing. */
  useEffect(() => {
    const id = idOf(selectedId);
    if (!id || details[id]) return;
    let live = true;
    setDetailBusy(true);
    api
      .get(`/audits/${audit._id}/enumeration/${id}`)
      .then((step) => {
        if (live) setDetails((current) => ({ ...current, [id]: step }));
      })
      .catch((error) => {
        /* A step deleted by somebody else while it sat selected: the tree reload will say so. */
        if (live && error?.status !== 404) toast.fromError(error);
      })
      .finally(() => {
        if (live) setDetailBusy(false);
      });
    return () => {
      live = false;
    };
  }, [selectedId, details, audit._id]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * The draft, twice: once from the row, then again when the body lands.
   *
   * Selecting a step used to hand over everything at once; now the row comes first and the output a
   * beat later. Both passes matter. The first clears whatever the last step left in the boxes — the
   * alternative is the previous step's write-up sitting in the editor, which is the one state from
   * which a save does real damage. The second fills in the half only the detail endpoint has.
   */
  useEffect(() => {
    if (!selected) return;
    setDraft(draftOf(selected));
    setDirty(false);
    setShowRunFields(false);
    setDraftFor(bodyReady ? idOf(selected._id) : null);
  }, [selected?._id, bodyReady]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Folds outlive the page: the same sections are open when you come back to the engagement. */
  useEffect(() => {
    writeFolds(audit._id, collapsed);
  }, [audit._id, collapsed]);

  const patch = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  /**
   * A saved step put back where it came from.
   *
   * The alternative — and what this used to do — is re-fetch the whole tree after every save, which
   * means renaming a step costs a request that returns all sixty rows. The response already contains
   * the row, so the tree can be patched in place and the body cached in one go.
   *
   * `tree` is for the one save that genuinely changes more than its own row: marking a step internal
   * holds back everything under it, so every descendant's state has changed and only a reload knows
   * the new shape.
   */
  const applySaved = (saved, { tree = false } = {}) => {
    if (!saved?._id) return;
    const id = idOf(saved._id);
    setDetails((current) => ({ ...current, [id]: saved }));
    const row = lightenStep(saved);
    setData((current) =>
      Array.isArray(current)
        ? current.map((entry) => (idOf(entry._id) === id ? { ...entry, ...row } : entry))
        : current
    );
    if (tree) refresh();
  };

  const refresh = async () => {
    await reload({ quiet: true });
    /* So the tab bar's count and the visibility fallback see the change too. */
    onReload?.({ quiet: true });
  };

  /* Fetched once, when the menu is first opened — the list never changes within a session. */
  const openPresets = async () => {
    setPresetOpen((open) => !open);
    if (presets) return;
    try {
      setPresets(await api.get(`/audits/${audit._id}/enumeration/presets`));
    } catch (error) {
      toast.fromError(error);
    }
  };

  const applyPreset = async (key) => {
    setPresetBusy(key);
    try {
      const result = await api.post(`/audits/${audit._id}/enumeration/preset`, {
        preset: key,
        /* The client's domain, when there is one, so the commands arrive runnable. */
        target: audit.company?.website
          ? String(audit.company.website).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
          : '',
      });
      setPresetOpen(false);
      await refresh();
      setSelectedId(result.section);
      toast.success(
        'Section added',
        `${result.added} rows. Delete the tools you do not use and fix the commands — they are ordinary steps.`
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setPresetBusy('');
    }
  };

  /** One patch across the selection. Only the flags — a bulk edit of prose is a mis-click away. */
  const applyBulk = async (patch) => {
    if (!picked.size) return;
    setBulkBusy(true);
    try {
      const result = await api.put(`/audits/${audit._id}/enumeration/bulk`, {
        ids: [...picked],
        patch,
      });
      await refresh();
      setPicked(new Set());
      toast.success(`${result.changed} step${result.changed === 1 ? '' : 's'} updated`);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBulkBusy(false);
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    if (history) return;
    try {
      setHistory(await api.get(`/audits/${audit._id}/enumeration/history`));
    } catch (error) {
      toast.fromError(error);
    }
  };

  const copyFrom = async (fromAudit, step, withOutput) => {
    try {
      const result = await api.post(`/audits/${audit._id}/enumeration/copy-from`, {
        audit: fromAudit,
        step,
        withOutput,
      });
      setHistoryOpen(false);
      await refresh();
      setSelectedId(result.section);
      toast.success('Copied in', `${result.added} rows from ${result.from}.`);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const savePreset = async (name, description) => {
    try {
      const result = await api.post(
        `/audits/${audit._id}/enumeration/${savingPreset._id}/save-preset`,
        { name, description }
      );
      setSavingPreset(null);
      /* Drop the cache so the menu shows it next time it opens. */
      setPresets(null);
      toast.success('Saved as a preset', `"${result.name}" — ${result.steps} rows, without the output.`);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const deletePreset = async (preset) => {
    try {
      await api.del(`/audits/${audit._id}/enumeration/presets/${preset._id}`);
      setPresets((current) => (current ?? []).filter((p) => p.key !== preset.key));
      toast.success('Preset removed', `"${preset.label}" is no longer offered.`);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const openVars = async () => {
    setVarsOpen(true);
    if (vars) return;
    try {
      setVars(await api.get(`/audits/${audit._id}/enumeration/vars`));
    } catch (error) {
      toast.fromError(error);
    }
  };

  const saveVars = async (next) => {
    try {
      const result = await api.put(`/audits/${audit._id}/enumeration/vars`, { vars: next });
      setVars(result.vars);
      setVarsOpen(false);
      /* Every command's resolved form changes with them, so the tree is refetched rather than patched. */
      await reload({ quiet: true });
      toast.success('Variables saved', 'Every command that uses them is updated.');
    } catch (error) {
      toast.fromError(error);
    }
  };

  /**
   * The chapter, as the report will read.
   *
   * `full` asks the server for whole panes. Off by default: a chapter of sixty steps at four
   * hundred lines each is two megabytes of HTML, and no part of "does this read well" is answered
   * by the four hundredth line of a subdomain sweep. The panel says which lines it is not showing,
   * and this is the way to see them anyway.
   */
  const openPreview = async (full = false) => {
    setPreviewOpen(true);
    setPreviewFull(full);
    setPreview(null);
    try {
      setPreview(
        await api.get(`/audits/${audit._id}/enumeration/preview${full ? '?full=1' : ''}`)
      );
    } catch (error) {
      setPreviewOpen(false);
      toast.fromError(error);
    }
  };

  const attach = async (file) => {
    if (!file || !selected) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.post(`/audits/${audit._id}/enumeration/${selected._id}/documents`, form);
      await reload({ quiet: true });
      toast.success('Filed against this step', file.name);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setUploading(false);
    }
  };

  const detach = async (doc) => {
    try {
      await api.del(`/audits/${audit._id}/documents/${doc._id}`);
      await reload({ quiet: true });
      toast.success('Artefact removed', doc.filename);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const exportAs = async (format) => {
    try {
      const response = await api.get(
        `/audits/${audit._id}/enumeration/export?format=${format}&internal=include`,
        { raw: true }
      );
      const blob = await response.blob();
      downloadBlob(blob, `${audit.reference || audit.name} enumeration.${format}`);
    } catch (error) {
      toast.fromError(error);
    }
  };

  /**
   * The enumeration as a workbook — summary, one row per step, one row per marked line.
   *
   * Not the same thing as the CSV beside it. The CSV is everything this engagement holds, internal
   * rows included, for feeding another tool. This is the appendix that goes *with* the report: the
   * same rows the document prints, in the file a client's reviewer will sort and filter. The server
   * names it, so the file is called what the report calls the engagement.
   */
  const downloadSheet = async () => {
    setSheetBusy(true);
    try {
      const response = await api.get(`/audits/${audit._id}/enumeration.xlsx`, { raw: true });
      const blob = await response.blob();
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(
        response.headers.get('content-disposition') ?? ''
      );
      downloadBlob(
        blob,
        named ? decodeURIComponent(named[1]) : `${audit.reference || audit.name} enumeration.xlsx`
      );
      toast.success('Spreadsheet downloaded', 'Summary, one row per step, and the marked lines.');
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSheetBusy(false);
    }
  };

  /* Every id that has children — what "expand all" and "collapse all" operate on. */
  const foldable = useMemo(
    () => rows.filter((row) => row.hasChildren).map((row) => idOf(row._id)),
    [rows]
  );

  const create = async (parent = null) => {
    try {
      const step = await api.post(`/audits/${audit._id}/enumeration`, {
        title: parent ? 'Untitled step' : 'Untitled section',
        ...(parent ? { parent } : {}),
      });
      await refresh();
      if (parent) {
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(idOf(parent));
          return next;
        });
      }
      setSelectedId(step._id);
    } catch (error) {
      toast.fromError(error);
    }
  };

  const save = async ({ force = false } = {}) => {
    if (!selected) return;
    setSaving(true);
    try {
      const saved = await api.put(`/audits/${audit._id}/enumeration/${selected._id}`, {
        ...draft,
        // Two operators writing up the same sweep is normal; refuse a stale write rather than
        // quietly replacing whatever the other one typed.
        ...(selected.updatedAt && !force ? { expectedUpdatedAt: selected.updatedAt } : {}),
      });
      announceMentions(toast, saved);
      setConflict(null);
      setDirty(false);
      applySaved(saved, { tree: Boolean(saved.treeChanged) });
    } catch (error) {
      if (error?.isConflict) setConflict(error.current ?? {});
      else toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const takeTheirs = async () => {
    if (conflict) setDraft(draftOf(conflict));
    setConflict(null);
    setDirty(false);
    /* The cached body is the one we just lost the race to; drop it so the pane refetches. */
    setDetails((current) => {
      const next = { ...current };
      delete next[idOf(selectedId)];
      return next;
    });
    await reload({ quiet: true });
    toast.info('Loaded the saved version', 'Your unsaved changes were discarded.');
  };

  /* --------------------------------------------------------------- marked lines -- */

  /*
   * Each of these answers with the whole step, which is what makes them cheap to apply: the note
   * count on the tree row and the strip above the pane both come from the one response.
   */
  const markLine = async (line) => {
    try {
      applySaved(await api.post(`/audits/${audit._id}/enumeration/${selected._id}/notes`, { line }));
    } catch (error) {
      toast.fromError(error);
    }
  };

  const editNote = async (noteId, text) => {
    try {
      applySaved(
        await api.put(`/audits/${audit._id}/enumeration/${selected._id}/notes/${noteId}`, { text })
      );
    } catch (error) {
      toast.fromError(error);
    }
  };

  const removeNote = async (noteId) => {
    try {
      applySaved(
        await api.del(`/audits/${audit._id}/enumeration/${selected._id}/notes/${noteId}`)
      );
    } catch (error) {
      toast.fromError(error);
    }
  };

  /**
   * The same step again, without what happened to it.
   *
   * A whole-tree reload rather than a patch, because this adds rows: the numbering shifts and the
   * new branch has to appear in reading order, which is the server's to decide.
   */
  const duplicate = async (branch) => {
    if (!selected) return;
    setMoving(true);
    try {
      const made = await api.post(
        `/audits/${audit._id}/enumeration/${selected._id}/duplicate`,
        { branch }
      );
      await refresh();
      setSelectedId(made._id);
      toast.success(
        made.copied > 1 ? `Copied ${made.copied} steps` : 'Copied the step',
        'The commands came with it; the output did not.'
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setMoving(false);
    }
  };

  /** Sends the whole arrangement, because that is the only thing that cannot half-apply. */
  const applyOrder = async (next) => {
    if (!next) return;
    setMoving(true);
    try {
      await api.put(`/audits/${audit._id}/enumeration-order`, {
        order: next.map((row) => ({ id: row._id, parent: row.parent ?? null })),
      });
      await refresh();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setMoving(false);
      setDragId(null);
      setDropHint(null);
    }
  };

  const move = (delta) => {
    if (position < 0) return;
    const neighbour = siblings[position + delta];
    if (!neighbour) return;
    applyOrder(relocate(rows, selectedId, neighbour._id, delta < 0 ? 'before' : 'after'));
  };

  const indent = () => {
    const previous = siblings[position - 1];
    if (!previous) return;
    applyOrder(relocate(rows, selectedId, previous._id, 'inside'));
  };

  const outdent = () => {
    if (!selected?.parent) return;
    applyOrder(relocate(rows, selectedId, selected.parent, 'after'));
  };

  /*
   * The dragged id comes from the drop event, not from state.
   *
   * `onDragStart` puts it in `dataTransfer` and also in state, but state is the wrong one to read
   * here: React batches, and a drop that arrives in the same tick as the dragstart — which is what
   * a synthetic drag does, and what a fast real one can do — sees the old value and silently does
   * nothing. The payload is on the event that caused this, so it cannot be stale.
   */
  const onDrop = (event, targetId, zone) => {
    const source = event.dataTransfer?.getData('text/plain') || dragId;
    if (!source) return;
    const next = relocate(rows, source, targetId, zone);
    if (!next) {
      setDragId(null);
      setDropHint(null);
      return;
    }
    applyOrder(next);
  };

  const promote = async () => {
    const step = promoting;
    if (!step) return;
    setPromoteBusy(true);
    try {
      if (dirty && idOf(step._id) === idOf(selected?._id)) await save();
      const result = await api.post(`/audits/${audit._id}/enumeration/${step._id}/promote`, {
        title: (dirty ? draft.title : step.title) || undefined,
      });
      setPromoting(null);
      await refresh();
      toast.success(
        'Written up as a finding',
        `"${result?.finding?.title ?? 'The finding'}" is on the Findings tab. The step stays here.`
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setPromoteBusy(false);
    }
  };

  const confirmDelete = async () => {
    try {
      const result = await api.del(`/audits/${audit._id}/enumeration/${pendingDelete._id}`);
      if (idOf(selectedId) === idOf(pendingDelete._id)) setSelectedId(null);
      setPendingDelete(null);
      await refresh();
      /*
       * The one that most needed a way back: a step is a command somebody typed and output
       * somebody pasted, and a section takes its whole branch with it.
       */
      offerUndo(toast, {
        auditId: audit._id,
        undo: result?.undo,
        onDone: refresh,
        fallback: result?.removed > 1 ? `${result.removed} steps deleted` : 'Step deleted',
      });
    } catch (error) {
      toast.fromError(error);
    }
  };

  /*
   * Which kind of node is open.
   *
   * A section with something of its own is treated as a step: somebody who filled a command in on a
   * heading meant it, and hiding what they typed would be the worse mistake by a long way.
   */
  const runFields = ['tool', 'target', 'ranAt', 'command', 'output', 'status'];
  /*
   * The row's own flags are part of this, not just the draft: a section with output would otherwise
   * fold its run fields away for the moment before its body arrives and open them again after.
   */
  const hasRunDetails =
    runFields.some((field) => String(draft[field] ?? '').trim()) ||
    Boolean(selected?.hasOutput) ||
    Boolean(selected?.hasContent);
  const isSection = Boolean(selected?.hasChildren);
  const runVisible = !isSection || hasRunDetails || showRunFields;

  if (loading) return <LoadingBlock label="Loading enumeration…" />;

  const doomed = pendingDelete ? subtreeOf(rows, pendingDelete._id).size : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          How the ground was mapped, in the order you mapped it. Nest tool runs under a section by
          dragging, or with the indent buttons. Templates print these with{' '}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[0.6875rem]">
            {'{{#enumeration}}'}
          </code>
          .
        </p>
        {editable ? (
          <div className="relative flex items-center gap-2">
            {rows.length ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Sheet}
                  loading={sheetBusy}
                  title="The enumeration as a spreadsheet — the appendix a reviewer can sort and filter"
                  onClick={downloadSheet}
                >
                  Spreadsheet
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  icon={Download}
                  title="Export as CSV — everything, internal rows included"
                  onClick={() => exportAs('csv')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={History}
                  onClick={openHistory}
                  title="What was enumerated for this client before"
                >
                  Earlier work
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" icon={History} onClick={openHistory}>
                Earlier work
              </Button>
            )}
            {/*
              The way out of the tab. Always offered, empty list included — the workbench is where
              you start a long enumeration, not only where you finish one.
            */}
            {!asPage ? (
              <Link
                to={`/engagements/${audit._id}/enumeration`}
                onClick={(event) => {
                  event.preventDefault();
                  guard(() => navigate(`/engagements/${audit._id}/enumeration`));
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-soft px-2.5 text-xs text-fg-muted transition hover:border-brand-500/40 hover:text-fg"
                title="Open the full-height workbench"
              >
                <Maximize2 size={13} />
                Workbench
              </Link>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              icon={Variable}
              title="Engagement variables — $TARGET and friends"
              onClick={openVars}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              icon={Eye}
              title="Read this chapter the way the report will print it"
              onClick={() => openPreview()}
            />
            <Button variant="ghost" size="sm" icon={LayoutList} onClick={openPresets}>
              From a preset
            </Button>
            <Button variant="primary" size="sm" icon={Plus} onClick={() => create(null)}>
              New section
            </Button>

            {presetOpen ? (
              <>
                {/* A click anywhere else closes it — the usual contract for a menu. */}
                <button
                  type="button"
                  aria-label="Close the preset list"
                  className="fixed inset-0 z-30 cursor-default"
                  onClick={() => setPresetOpen(false)}
                />
                <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-card border border-line bg-overlay shadow-pop">
                  <p className="border-b border-line-soft px-3 py-2 text-[0.625rem] text-fg-subtle">
                    A section and its steps, with the commands written. Ordinary steps once added —
                    delete what you do not use.
                  </p>
                  {presets === null ? (
                    <p className="px-3 py-3 text-xs text-fg-muted">Loading…</p>
                  ) : (
                    <ul className="max-h-80 divide-y divide-line-soft overflow-auto">
                      {presets.map((preset) => (
                        <li key={preset.key} className="group/preset flex items-stretch">
                          <button
                            type="button"
                            disabled={Boolean(presetBusy)}
                            onClick={() => applyPreset(preset.key)}
                            className="min-w-0 flex-1 px-3 py-2 text-left transition hover:bg-white/[0.05] disabled:opacity-50"
                          >
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="flex min-w-0 items-center gap-1.5">
                                {/* Saved ones are marked, so the built-ins stay recognisable as they accumulate. */}
                                {preset.custom ? (
                                  <Star size={9} className="shrink-0 text-brand-300" />
                                ) : null}
                                <span className="truncate text-xs font-medium text-fg">{preset.label}</span>
                              </span>
                              <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                                {presetBusy === preset.key ? 'adding…' : `${preset.steps} steps`}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                              {preset.description}
                            </span>
                          </button>
                          {preset.custom ? (
                            <button
                              type="button"
                              title={`Stop offering "${preset.label}"`}
                              onClick={() => deletePreset(preset)}
                              className="grid w-9 shrink-0 place-items-center text-fg-subtle opacity-0 transition hover:bg-white/[0.05] hover:text-crit group-hover/preset:opacity-100"
                            >
                              <Trash2 size={12} />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {/*
        The filter, once there is enough here to lose something in. Below a dozen rows the tree is
        the filter, and a search box over eight items is furniture.
      */}
      {rows.length >= 8 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-line-soft bg-surface/60 px-3 py-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              value={filter.text}
              onChange={(event) => setFilter((f) => ({ ...f, text: event.target.value }))}
              placeholder="Title, tool, target, command, output…"
              className="h-8 w-56 rounded-lg border border-line-soft bg-canvas/60 pl-7 pr-2 text-xs text-fg placeholder:text-fg-subtle focus:border-brand-500/50 focus:outline-none"
            />
          </div>

          <select
            value={filter.tool}
            onChange={(event) => setFilter((f) => ({ ...f, tool: event.target.value }))}
            className="h-8 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg-muted focus:outline-none"
          >
            <option value="">Any tool</option>
            {toolsUsed.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </select>

          <select
            value={filter.phase}
            onChange={(event) => setFilter((f) => ({ ...f, phase: event.target.value }))}
            className="h-8 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg-muted focus:outline-none"
          >
            <option value="">Any phase</option>
            {PHASES.filter((p) => p.value).map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>

          <select
            value={filter.status}
            onChange={(event) => setFilter((f) => ({ ...f, status: event.target.value }))}
            className="h-8 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg-muted focus:outline-none"
          >
            <option value="">Any outcome</option>
            {STATUSES.filter((x) => x.value).map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>

          {[
            ['output', 'Has output'],
            ['table', 'Reads as a table'],
            ['notes', 'Has a marked line'],
            ['stale', 'Not run in a week'],
            ['finding', 'Became a finding'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() =>
                setFilter((f) => ({ ...f, flag: f.flag === value ? '' : value }))
              }
              className={cn(
                'h-8 rounded-lg border px-2.5 text-xs transition',
                filter.flag === value
                  ? 'border-brand-500/40 bg-brand-500/12 text-brand-200'
                  : 'border-line-soft bg-canvas/60 text-fg-muted hover:text-fg'
              )}
            >
              {label}
            </button>
          ))}

          <span className="ml-auto flex items-center gap-2 text-[0.6875rem] text-fg-subtle">
            {filtering ? `${matched.length} of ${rows.length}` : `${rows.length} rows`}
            {filtering ? (
              <Button
                variant="ghost"
                size="icon-sm"
                icon={X}
                title="Clear the filter"
                onClick={() => setFilter({ text: '', tool: '', phase: '', status: '', flag: '' })}
              />
            ) : null}
          </span>
        </div>
      ) : null}

      {/*
        The bulk bar, only while something is selected.
        Flags only: applying a phase to eleven steps is the useful case, and overwriting eleven
        write-ups with the same text is the mistake that would be one mis-click away.
      */}
      {picked.size ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-brand-500/30 bg-brand-500/[0.07] px-3 py-2">
          <span className="text-xs font-medium text-brand-200">
            {picked.size} selected
          </span>
          <select
            defaultValue=""
            disabled={bulkBusy}
            onChange={(event) => {
              if (event.target.value) applyBulk({ phase: event.target.value === 'none' ? '' : event.target.value });
              event.target.value = '';
            }}
            className="h-8 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg-muted focus:outline-none"
          >
            <option value="">Set phase…</option>
            <option value="none">No phase</option>
            {PHASES.filter((p) => p.value).map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            defaultValue=""
            disabled={bulkBusy}
            onChange={(event) => {
              if (event.target.value) applyBulk({ status: event.target.value === 'none' ? '' : event.target.value });
              event.target.value = '';
            }}
            className="h-8 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg-muted focus:outline-none"
          >
            <option value="">Set outcome…</option>
            <option value="none">No outcome</option>
            {STATUSES.filter((x) => x.value).map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
          <select
            defaultValue=""
            disabled={bulkBusy}
            onChange={(event) => {
              if (event.target.value) applyBulk({ printOutput: event.target.value });
              event.target.value = '';
            }}
            className="h-8 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg-muted focus:outline-none"
          >
            <option value="">Output in the report…</option>
            {PRINT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            icon={EyeOff}
            loading={bulkBusy}
            onClick={() => applyBulk({ internal: true })}
            title="Keep these out of the report"
          >
            Internal
          </Button>
          <Button variant="ghost" size="sm" onClick={() => applyBulk({ internal: false })}>
            Reportable
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            icon={X}
            title="Clear the selection"
            className="ml-auto"
            onClick={() => setPicked(new Set())}
          />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={ScanSearch}
            title="No enumeration recorded"
            description="Start with a section — Subdomain Enumeration, Cloud Enumeration — then add a step under it for each tool you ran. Unlike notes, these reach the report."
            actionLabel={editable ? 'New section' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => create(null) : undefined}
          />
        </Card>
      ) : (
        <div
          ref={splitRef}
          className={cn('grid', asPage ? 'gap-0' : 'gap-4 lg:grid-cols-[19rem_1fr]')}
          style={
            asPage
              ? { gridTemplateColumns: treeHidden ? '0 0 1fr' : `${paneWidth}px 5px 1fr` }
              : undefined
          }
        >
          <Card
            /*
              On the page the tree stays where you left it while the editor beside it scrolls with
              the window — `self-start` first, because a stretched grid item is exactly as tall as
              its row and a sticky box with no slack never moves.
            */
            className={cn(
              'overflow-hidden',
              asPage
                ? 'sticky top-[4.5rem] flex max-h-[calc(100dvh-6rem)] flex-col self-start lg:top-6'
                : 'h-fit',
              asPage && treeHidden && 'hidden'
            )}
          >
            {/* Fold controls, once the tree is deep enough for folding to be the point. */}
            {foldable.length > 1 ? (
              <div className="flex items-center gap-1 border-b border-line-soft px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronsDownUp}
                  title="Collapse every section"
                  onClick={() => setCollapsed(new Set(foldable))}
                >
                  Fold
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronsUpDown}
                  title="Expand every section"
                  onClick={() => setCollapsed(new Set())}
                >
                  Unfold
                </Button>
                <span className="ml-auto pr-1 text-[0.625rem] text-fg-subtle">
                  {visible.length} of {rows.length}
                </span>
              </div>
            ) : null}

            <div className={cn(asPage ? 'min-h-0 flex-1 overflow-auto' : '')}>
              <EnumerationTree
                rows={rows}
                visible={visible}
                selectedId={selectedId}
                onSelect={(id) => guard(() => setSelectedId(id))}
                picked={picked}
                onPick={(id) =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                collapsed={collapsed}
                onToggleCollapse={(id) =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                filtering={filtering}
                editable={editable}
                moving={moving}
                onAddChild={(id) => create(id)}
                dragId={dragId}
                setDragId={setDragId}
                dropHint={dropHint}
                setDropHint={setDropHint}
                onDrop={onDrop}
                variant={asPage ? 'full' : 'compact'}
              />
            </div>
          </Card>

          {/*
            The handle. Keyboard-resizable as well, because a splitter only a mouse can move is a
            wall for anybody who does not use one.
          */}
          {asPage ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the tree"
              tabIndex={treeHidden ? -1 : 0}
              onPointerDown={startResize}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setPaneWidth((w) => Math.max(MIN_PANE, w - 16));
                if (event.key === 'ArrowRight') setPaneWidth((w) => Math.min(MAX_PANE, w + 16));
              }}
              className={cn('group relative cursor-col-resize', treeHidden && 'hidden')}
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line-soft transition group-hover:bg-brand-500/70 group-focus:bg-brand-500" />
            </div>
          ) : null}

          <EnumerationEditor
            selected={selected}
            draft={draft}
            draftFor={draftFor}
            patch={patch}
            dirty={dirty}
            saving={saving}
            save={save}
            editable={editable}
            runVisible={runVisible}
            setShowRunFields={setShowRunFields}
            isSection={isSection}
            position={position}
            siblings={siblings}
            move={move}
            indent={indent}
            outdent={outdent}
            duplicate={duplicate}
            moving={moving}
            setPendingDelete={setPendingDelete}
            setPromoting={setPromoting}
            setScoping={setScoping}
            setSavingPreset={setSavingPreset}
            openVars={openVars}
            attach={attach}
            detach={detach}
            uploading={uploading}
            markLine={markLine}
            editNote={editNote}
            removeNote={removeNote}
            audit={audit}
            asPage={asPage}
          />
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={doomed > 1 ? `Delete this section and its ${doomed - 1} steps?` : 'Delete this step?'}
        confirmLabel="Delete"
        message={
          doomed > 1
            ? `"${pendingDelete?.title || 'Untitled step'}" and everything nested under it will be removed, output and screenshots included. This cannot be undone.`
            : `"${pendingDelete?.title || 'Untitled step'}" will be removed, output and screenshots with it. This cannot be undone.`
        }
      />

      <ConfirmDialog
        open={Boolean(promoting)}
        onClose={() => setPromoting(null)}
        onConfirm={promote}
        loading={promoteBusy}
        title="Write this up as a finding?"
        confirmLabel="Write it up"
        message={`"${
          promoting?.title || 'Untitled step'
        }" becomes a new finding — the command and the output as code blocks, then the write-up. The step stays here, linked to it, so the report can say where the finding came from.`}
      />

      <ScopeDialog
        step={scoping}
        auditId={audit._id}
        scope={audit.scope}
        onClose={() => setScoping(null)}
        onDone={async (message) => {
          setScoping(null);
          await refresh();
          toast.success('Added to the scope', message);
        }}
      />

      <VarsDialog
        open={varsOpen}
        vars={vars}
        onClose={() => setVarsOpen(false)}
        onSave={saveVars}
        editable={editable}
      />

      <PreviewDialog
        open={previewOpen}
        preview={preview}
        full={previewFull}
        onFull={() => openPreview(true)}
        onClose={() => setPreviewOpen(false)}
      />

      <JumpDialog
        open={jumpOpen}
        rows={rows}
        onClose={() => setJumpOpen(false)}
        onPick={(id) => {
          setJumpOpen(false);
          guard(() => setSelectedId(id));
        }}
      />

      <SavePresetDialog
        step={savingPreset}
        onClose={() => setSavingPreset(null)}
        onSave={savePreset}
      />

      <HistoryDialog
        open={historyOpen}
        history={history}
        onClose={() => setHistoryOpen(false)}
        onCopy={copyFrom}
      />

      <ConflictDialog
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        onDiscard={takeTheirs}
        onOverwrite={() => save({ force: true })}
        label={`the enumeration step “${draft.title || 'Untitled step'}”`}
        current={conflict}
        loading={saving}
      />
    </div>
  );
}

/* -------------------------------------------------------- variables dialog ---- */

/**
 * The engagement's variables.
 *
 * A whole-table edit rather than one field at a time, because renaming a variable is a delete and an
 * add, and doing that as two saves would leave a moment where commands referred to something that
 * did not exist. Names are forced upper case as you type: `$target` would not resolve, and finding
 * that out from a command that silently did nothing is the worst way to learn it.
 */
