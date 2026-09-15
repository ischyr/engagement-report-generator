import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Bookmark, BookmarkPlus, Star, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useUnsaved } from '../../context/UnsavedContext.jsx';
import { useSmoothNavigate } from '../../context/NavigationContext.jsx';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/Button.jsx';
import { Modal } from '../ui/Modal.jsx';

/**
 * The lists somebody works from, kept where they can be got back to.
 *
 * Several pages keep their state in the address bar, which made a filtered list linkable and
 * reloadable — and unmemorable. `/engagements?state=REVIEW&mine=1&sort=-updatedAt` is the view a
 * reviewer opens every morning, and the only way back to it was to rebuild it from the controls
 * or keep a browser bookmark the app knows nothing about.
 *
 * A view is a label and a URL. Deliberately not a copy of the filters: a stored
 * `{ state: 'REVIEW' }` would need migrating whenever a page changed its parameters and would
 * quietly stop matching what the page reads, whereas a URL either still works or visibly does not.
 *
 * One dialog does all three things. Saving a place already saved is a rename — the server treats
 * the destination as the identity — and the dialog offers Remove when there is something to
 * remove, which is why there are no hover controls on the rows. A sidebar where every row grows a
 * delete button on mouseover is a sidebar people click delete in by accident.
 */

/** The pages where saving a view is a thing anybody would want. */
const SUGGESTED = {
  '/engagements': 'Engagements',
  '/library': 'Vulnerabilities',
  '/deliverables': 'Deliverables',
  '/schedule': 'Schedule',
  '/inbox': 'Inbox',
  '/verification': 'Verification',
  '/insights': 'Insights',
  '/data': 'Clients & data',
  '/scratchpad': 'Scratchpad',
  '/checklists': 'Checklists',
  '/templates': 'Templates',
  '/proposals': 'Proposal queue',
  '/inquiries': 'Inquiries',
};

/**
 * A name to offer, from the page and the first thing that is filtered.
 *
 * A suggestion, not a rule — the field is focused and selected, so typing replaces it. But an
 * empty box asks somebody to name a thing they have not decided they are keeping yet, and the
 * commonest answer to that is to close the dialog.
 */
function suggest(pathname, search) {
  const page = SUGGESTED[pathname] ?? pathname.replace(/^\//, '').replace(/\/.*$/, '') ?? 'View';
  const params = new URLSearchParams(search);
  /* `q` first: a saved search is named by what was searched for, not by the fact of searching. */
  const named =
    params.get('q') ||
    params.get('state') ||
    params.get('status') ||
    params.get('severity') ||
    params.get('kind') ||
    '';
  const label = named ? `${page} — ${named}` : page;
  return label.slice(0, 60);
}

export function SavedViews({ onNavigate }) {
  const location = useLocation();
  const navigate = useSmoothNavigate();
  const toast = useToast();
  const { guard } = useUnsaved();

  const [views, setViews] = useState([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  /*
   * Fetched once, then kept in step by hand.
   *
   * Refetching after every save would be a round trip to learn something the response already
   * said, on a list that lives beside every page in the app. The three writes below each return
   * the row they wrote, which is enough to keep this honest.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .get('/views')
      .then((data) => {
        if (!cancelled) setViews(data.views ?? []);
      })
      /* A sidebar section that cannot load is an absent section, not an error message. */
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const here = `${location.pathname}${location.search}`;
  const saved = useMemo(() => views.find((view) => view.href === here) ?? null, [views, here]);

  /*
   * The dashboard with nothing on it is not a view, and neither is a record.
   *
   * An engagement, a proposal or a client is already reachable by name from a list; saving one
   * would fill the sidebar with rows that go stale when the work finishes. What this is for is a
   * *list in a particular state*, so the star appears on the pages that have one.
   */
  const savable = useMemo(() => {
    if (saved) return true;
    if (!SUGGESTED[location.pathname]) return false;
    return Boolean(location.search);
  }, [saved, location.pathname, location.search]);

  const openDialog = useCallback(() => {
    setLabel(saved?.label ?? suggest(location.pathname, location.search));
    setOpen(true);
  }, [saved, location.pathname, location.search]);

  /* ⌘/Ctrl+Shift+D — beside ⌘K for the search, and listed in the shortcuts dialog. */
  const openRef = useRef(openDialog);
  openRef.current = openDialog;
  const savableRef = useRef(savable);
  savableRef.current = savable;
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== 'd') return;
      if (!savableRef.current) return;
      event.preventDefault();
      openRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const save = async () => {
    const name = label.trim();
    if (!name) return;
    setBusy(true);
    try {
      const row = await api.post('/views', { label: name, href: here });
      setViews((current) => [...current.filter((view) => view._id !== row._id), row]);
      setOpen(false);
      toast.success(saved ? 'View renamed' : 'View saved');
    } catch (error) {
      toast.error(error.message || 'Could not save the view');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (view) => {
    setBusy(true);
    try {
      await api.del(`/views/${view._id}`);
      setViews((current) => current.filter((entry) => entry._id !== view._id));
      setOpen(false);
      toast.success('View removed');
    } catch (error) {
      toast.error(error.message || 'Could not remove the view');
    } finally {
      setBusy(false);
    }
  };

  if (!views.length && !savable) return null;

  return (
    <>
      <div className="mt-4 flex items-center justify-between gap-1 px-2.5 pb-1">
        <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
          Views
        </p>
        {savable ? (
          <button
            type="button"
            onClick={openDialog}
            title={saved ? `Saved as “${saved.label}”` : 'Save this view (Ctrl+Shift+D)'}
            aria-label={saved ? 'Edit this saved view' : 'Save this view'}
            className={cn(
              'rounded p-0.5 transition-colors',
              saved ? 'text-brand-300' : 'text-fg-subtle hover:text-fg'
            )}
          >
            {saved ? <Star size={13} fill="currentColor" /> : <BookmarkPlus size={13} />}
          </button>
        ) : null}
      </div>

      {views.map((view) => (
        <NavLink
          key={view._id}
          to={view.href}
          onClick={(event) => {
            /*
             * A modified click belongs to the browser. This intercepted every click, including
             * Ctrl-, Cmd- and middle-click, so opening a section in a second tab — which is how
             * anybody works on two engagements at once — quietly navigated this one instead.
             */
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
              return;
            }
            event.preventDefault();
            /* The same unsaved-work guard every other navigation goes through. */
            guard(() => {
              navigate(view.href);
              onNavigate?.();
            });
          }}
          className={cn(
            'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
            view.href === here
              ? 'bg-brand-500/12 text-brand-300'
              : 'text-fg-muted hover:bg-white/5 hover:text-fg'
          )}
        >
          <span
            className={cn(
              'absolute left-0 top-1/2 h-4.5 w-0.5 -translate-y-1/2 rounded-r bg-brand-400 transition-opacity',
              view.href === here ? 'opacity-100' : 'opacity-0'
            )}
          />
          <Bookmark size={16} className="shrink-0" />
          <span className="truncate">{view.label}</span>
        </NavLink>
      ))}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={saved ? 'This view' : 'Save this view'}
        description={here}
        size="sm"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            {saved ? (
              <Button
                variant="ghost"
                icon={Trash2}
                onClick={() => remove(saved)}
                disabled={busy}
                className="text-crit"
              >
                Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={save} disabled={busy || !label.trim()}>
                {saved ? 'Rename' : 'Save'}
              </Button>
            </div>
          </div>
        }
      >
        <label className="block text-xs font-medium text-fg-muted">
          Name
          <input
            data-autofocus
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
            maxLength={60}
            className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand-400"
          />
        </label>
        <p className="mt-2 text-[0.6875rem] text-fg-subtle">
          A view is a name and an address. It remembers where you were, not what you could see —
          the page asks the same questions of you as it ever did.
        </p>
      </Modal>
    </>
  );
}

export default SavedViews;
