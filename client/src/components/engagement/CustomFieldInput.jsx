import { Field, Input, Select, Textarea } from '../ui/Field.jsx';
import { RichTextEditor } from '../editor/RichTextEditor.jsx';
import { cn } from '../../lib/utils.js';

/**
 * One custom field, rendered as whatever type it was defined as.
 *
 * Nine types can be chosen when defining a field, but only `select` and `date` were
 * ever rendered — everything else fell through to a plain text box. So an admin
 * defining a checkbox got a text box, silently, which is worse than not offering the
 * choice. This handles all of them, in one place, because the finding editor and the
 * engagement details had drifted apart already.
 *
 * @param {{definition: object, value: any, onChange: (value: any) => void,
 *   disabled?: boolean}} props
 */
export default function CustomFieldInput({ definition, value, onChange, disabled }) {
  const options = (definition.options ?? [])
    .map((option) => (typeof option === 'string' ? option : option?.value))
    .filter(Boolean);

  const common = {
    label: definition.label,
    hint: definition.description,
    required: definition.required,
    disabled,
  };

  switch (definition.fieldType) {
    /* A deliberate gap in the layout, for grouping fields visually. */
    case 'space':
      return <div aria-hidden className="hidden sm:block" />;

    case 'textarea':
      return (
        <Textarea
          {...common}
          rows={4}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    /* Rich text. Templates reach the formatted version as {{@rich.custom.KEY}}. */
    case 'editor':
      return (
        <Field label={definition.label} hint={definition.description} required={definition.required}>
          <RichTextEditor
            value={value ?? ''}
            onChange={onChange}
            editable={!disabled}
            minHeight={140}
            compact
          />
        </Field>
      );

    case 'date':
      return (
        <Input
          {...common}
          type="date"
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'select':
      return (
        <Select
          {...common}
          placeholder="Not set"
          value={value ?? ''}
          options={options}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'radio':
      return (
        <Field label={definition.label} hint={definition.description} required={definition.required}>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 py-1">
            {options.length === 0 ? (
              <p className="text-xs text-fg-subtle">No options defined for this field yet.</p>
            ) : (
              options.map((option) => (
                <label
                  key={option}
                  className={cn(
                    'flex items-center gap-2 text-xs text-fg',
                    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                  )}
                >
                  <input
                    type="radio"
                    name={`custom-${definition.key}`}
                    checked={value === option}
                    disabled={disabled}
                    onChange={() => onChange(option)}
                    className="size-3.5 border-line bg-canvas accent-brand-500"
                  />
                  {option}
                </label>
              ))
            )}
          </div>
        </Field>
      );

    case 'multiselect': {
      // Stored as an array; the report joins it with commas.
      const selected = Array.isArray(value) ? value : value ? [value] : [];
      return (
        <Field label={definition.label} hint={definition.description} required={definition.required}>
          <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-lg bg-canvas/60 p-1.5 ring-1 ring-line">
            {options.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-fg-subtle">
                No options defined for this field yet.
              </p>
            ) : (
              options.map((option) => {
                const checked = selected.includes(option);
                return (
                  <label
                    key={option}
                    className={cn(
                      'flex items-center gap-2.5 rounded px-2 py-1.5 text-xs text-fg transition',
                      disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-white/5'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() =>
                        onChange(
                          checked ? selected.filter((v) => v !== option) : [...selected, option]
                        )
                      }
                      className="size-3.5 rounded border-line bg-canvas accent-brand-500"
                    />
                    {option}
                  </label>
                );
              })
            )}
          </div>
        </Field>
      );
    }

    case 'checkbox':
      // Stored as a boolean; the report prints it as Yes or No.
      return (
        <Field hint={definition.description}>
          <label
            className={cn(
              'flex items-center gap-2.5 py-1.5 text-sm text-fg',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
            )}
          >
            <input
              type="checkbox"
              checked={Boolean(value)}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked)}
              className="size-4 rounded border-line bg-canvas accent-brand-500"
            />
            {definition.label}
          </label>
        </Field>
      );

    default:
      return (
        <Input {...common} value={value ?? ''} onChange={(event) => onChange(event.target.value)} />
      );
  }
}

/**
 * Whether a field wants the full width of a two-column grid.
 *
 * Honours the `size` a field was defined with (1–12, so 7 and up means "more than
 * half"), and forces it for the types that are unusable in a narrow column.
 */
export const isWideField = (definition) =>
  ['textarea', 'editor', 'multiselect'].includes(definition.fieldType) ||
  (definition.size ?? 12) >= 7;
