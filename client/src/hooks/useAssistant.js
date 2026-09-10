import { useEffect, useState } from 'react';

import { api } from '../lib/api.js';

/**
 * Whether this instance has an assistant, and whether it will answer this particular job.
 *
 * The answer decides whether a button is *rendered*, not whether it is enabled. An instance that
 * has not configured an assistant looks exactly as it did before the feature existed — no greyed
 * out controls, no "upgrade to enable", nothing to explain to a new joiner. A disabled button is an
 * advertisement, and this is a tool people pay for once and run themselves.
 *
 * Asked once per page load and shared. Four call sites across three tabs would otherwise each ask
 * on mount, which is four requests to answer one boolean — and the answer cannot change while
 * somebody is looking at a page, because changing it means an administrator saving Settings.
 *
 * Server-rendered pages get `null` and therefore `available: false`, which is the right default:
 * the render smoke test mounts every tab with no browser and no API, and nothing here may throw.
 */
let inFlight = null;
let snapshot = null;

function load() {
  if (!inFlight) {
    inFlight = api
      .get('/assistant')
      /* A failure is indistinguishable from "not configured", and both mean: draw nothing. */
      .catch(() => ({ available: false, jobs: {}, model: '' }))
      .then((value) => {
        snapshot = value;
        return value;
      });
  }
  return inFlight;
}

/** Forgets the cached answer, so saving Settings takes effect without a reload. */
export function forgetAssistant() {
  inFlight = null;
  snapshot = null;
}

/**
 * @param {string} [job] one of `summary`, `rewrite`, `enumeration`, `library`
 * @returns {{available: boolean, model: string, ready: boolean}}
 */
export function useAssistant(job) {
  const [state, setState] = useState(snapshot);

  useEffect(() => {
    let live = true;
    load().then((value) => {
      if (live) setState(value);
    });
    return () => {
      live = false;
    };
  }, []);

  return {
    available: Boolean(state?.available && (!job || state.jobs?.[job] !== false)),
    model: state?.model ?? '',
    ready: Boolean(state),
  };
}

export default useAssistant;
