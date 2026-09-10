import { api } from './api.js';

/**
 * The toast that offers a deletion back.
 *
 * One helper because the alternative is ten tabs each writing their own wording, their own restore
 * call and their own idea of what happens afterwards — and the one that got it slightly wrong would
 * be the one nobody pressed in time.
 *
 * The offer only appears when the server sent a token. A delete of something with no restorer, or
 * one where remembering failed, simply says what it did — better than an Undo button that turns out
 * to be a lie.
 *
 * @param {object} toast the toast context
 * @param {object} options
 * @param {string} options.auditId
 * @param {{id:string, noun:string, label:string}|null} options.undo as returned by the delete
 * @param {() => any} [options.onDone] reload, after the restore lands
 * @param {string} [options.fallback] what to say when there is nothing to offer
 */
export function offerUndo(toast, { auditId, undo, onDone, fallback }) {
  if (!undo?.id) {
    if (fallback) toast.success(fallback);
    return;
  }

  const named = undo.label ? `"${undo.label}"` : 'It';
  toast.withAction(`${undo.noun} deleted`, `${named} can be put back for the next few minutes.`, {
    label: 'Undo',
    onClick: async () => {
      try {
        const restored = await api.post(`/audits/${auditId}/undo/${undo.id}`);
        await onDone?.();
        toast.success(`${restored?.noun ?? undo.noun} restored`);
      } catch (error) {
        /*
         * The window is short and the entry may already be gone — which is a sentence the server
         * writes, and worth showing rather than swallowing into a generic failure.
         */
        toast.fromError(error, 'It could not be put back');
      }
    },
  });
}

export default offerUndo;
