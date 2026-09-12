import { useAuth } from '../../context/AuthContext.jsx';
import { useCapabilities } from '../../context/CapabilitiesContext.jsx';
import { useCollab } from '../../hooks/useCollab.js';
import { RichTextEditor } from './LazyRichTextEditor.jsx';
import { Avatar } from '../ui/Misc.jsx';

/**
 * One rich-text field, shared with whoever else has it open.
 *
 * A component per field rather than a hook per field in the parent, because each field is its own
 * room and each room is its own socket — and because a list of hooks called in a loop is a rule
 * waiting to be broken the first time somebody makes the field list conditional.
 *
 * ## What happens when it cannot connect
 *
 * Nothing visible. `useCollab` gives up after a few seconds and reports `unavailable`, this renders
 * the ordinary editor, and the field behaves exactly as it did before: one writer at a time, the
 * soft lock that says who has it, and the conflict merge if two people save anyway. There is no
 * polling fallback and deliberately so — see the note in `useCollab.js`.
 *
 * ## Why it remounts
 *
 * An editor's extension list is fixed when it is created, so becoming collaborative is a different
 * editor rather than a changed prop. The `key` does that, and it is why the transition is a blink
 * rather than a merge of two document models.
 */
export default function CollaborativeField({
  auditId,
  scope,
  id,
  field,
  enabled = true,
  ...editorProps
}) {
  const { user } = useAuth();
  /* One flag, fetched once for the whole app: a finding alone has five of these components. */
  const { collab: allowed } = useCapabilities();

  /*
   * `<auditId>/finding/<id>/<field>` or `<auditId>/section/<id>`, which is the shape the server
   * accepts and refuses anything else — see the pattern in `collab/index.js`.
   *
   * No room at all when an administrator has switched sharing off, so nothing is attempted rather
   * than attempted and refused: a socket per field that can only fail is noise in a log and a
   * pause in an editor.
   */
  const room =
    allowed && enabled && auditId && id
      ? `${auditId}/${scope}/${id}${field ? `/${field}` : ''}`
      : null;

  const { provider, doc, people, isWriter, synced, me } = useCollab(room, { user });
  /* Everybody but me — against the id this client announced, not a second guess at it. */
  const others = people.filter((person) => String(person.id) !== me.id);
  /* Shared, and proved so — not merely "we asked for a socket". */
  const live = Boolean(provider && synced);

  return (
    <div className="flex flex-col gap-1.5">
      {/*
        Whether this field is shared, and with whom, in the normal flow above it.

        Not floated over the editor: a badge positioned outside its own box is a badge that ends up
        behind a card header on somebody's screen, and this is the one piece of state a person needs
        to be able to trust. It says nothing at all on an instance that cannot share documents, so
        an editor without collaboration looks exactly as it always did.
      */}
      {live ? (
        <div className="flex items-center gap-2 text-[0.6875rem]">
          <span className="flex items-center gap-1 text-low">
            <span aria-hidden className="size-1.5 rounded-full bg-low" />
            Shared
          </span>

          {others.length ? (
            <>
              <span className="text-fg-subtle">·</span>
              <span className="flex items-center gap-1">
                {others.map((person) => (
                  <span
                    key={person.clientId}
                    title={`${person.name} is editing this`}
                    className="flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 ring-1"
                    style={{ '--tw-ring-color': person.color }}
                  >
                    <Avatar name={person.name} size={18} />
                    <span className="text-fg-muted">{person.name}</span>
                  </span>
                ))}
              </span>
            </>
          ) : (
            <span className="text-fg-subtle">· nobody else is in this field</span>
          )}
        </div>
      ) : null}

      <RichTextEditor
        /* A new editor when the mode changes, because extensions are decided at creation. */
        key={provider ? 'collab' : 'solo'}
        collab={
          provider && doc
            ? {
                provider,
                doc,
                canSeed: isWriter,
                synced,
                /* What goes on the caret: the account's own name, never anything typed. */
                user: { name: me.name, color: me.colour },
              }
            : null
        }
        {...editorProps}
      />
    </div>
  );
}
