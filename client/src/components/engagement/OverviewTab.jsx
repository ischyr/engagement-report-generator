import { useEffect, useMemo, useState } from 'react';
import { Lock, Save, Users } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { useUnsavedWork } from '../../context/UnsavedContext.jsx';
import { cn, displayName } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Checkbox, Field } from '../ui/Field.jsx';
import { Avatar } from '../ui/Misc.jsx';
import ConflictDialog from '../ui/ConflictDialog.jsx';
import CustomFieldInput, { isWideField } from './CustomFieldInput.jsx';
import SignOffCard from './SignOffCard.jsx';
import RepeatCard from './RepeatCard.jsx';
import ClassificationCard from './ClassificationCard.jsx';
import TagEditor from './TagEditor.jsx';

const idOf = (value) => (value && typeof value === 'object' ? value._id : value) ?? '';

/**
 * What a recipient can be to the report.
 *
 * Mirrors `RECIPIENT_ROLES` on the server, which validates them — the labels live here
 * because they are wording rather than data.
 */
const RECIPIENT_ROLES = [
  { value: 'technical', label: 'Technical contact' },
  { value: 'management', label: 'Management' },
  { value: 'signatory', label: 'Signs off' },
  { value: 'cc', label: 'Copied in' },
];

/** Today, as the `yyyy-mm-dd` the server stores and compares. */
const todayIso = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/**
 * When somebody's access to this engagement ends.
 *
 * Deliberately quiet until it is set: most members are permanent, and a row of empty date
 * fields would make the exception look like the rule. Once a date is there it says so plainly,
 * and an expired one says that.
 */
function MemberUntil({ value, disabled, onChange }) {
  const expired = value && value < todayIso();
  return (
    <span className="flex shrink-0 items-center gap-1">
      {value ? (
        <span
          className={cn('text-[0.625rem]', expired ? 'text-crit' : 'text-fg-subtle')}
          title={expired ? 'Their access has ended' : 'Their access ends on this day'}
        >
          {expired ? 'ended' : 'until'}
        </span>
      ) : null}
      <input
        type="date"
        value={value}
        disabled={disabled}
        title="Leave empty for a permanent member"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-6 rounded bg-canvas/60 px-1 text-[0.625rem] ring-1 ring-line-soft focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:opacity-40',
          value ? 'text-fg' : 'w-8 text-fg-subtle opacity-40 hover:w-auto hover:opacity-100'
        )}
      />
    </span>
  );
}

export default function OverviewTab({ audit, editable, onPatch, onReload }) {
  const toast = useToast();
  const { isAdmin, user } = useAuth();

  /**
   * Who is on an engagement is the creator's decision, or an admin's — a
   * collaborator should not be able to remove the people reviewing their work.
   */
  /** When this person's access ends, or '' for a permanent member. */
  const untilFor = (id) =>
    (form.memberUntil ?? []).find((entry) => entry.user === id)?.until ?? '';

  /**
   * Sets or clears an access limit.
   *
   * Clearing removes the entry rather than storing an empty date: absent means permanent, and
   * a row with no date in it would be a third state nobody asked for.
   */
  const setMemberUntil = (id, until) => {
    const others = (form.memberUntil ?? []).filter((entry) => entry.user !== id);
    set({ memberUntil: until ? [...others, { user: id, until }] : others });
  };

  const canManageTeam =
    isAdmin || String(audit.creator?._id ?? audit.creator ?? '') === String(user?.id ?? user?._id);
  const creatorName = audit.creator ? displayName(audit.creator) : '';

  const companies = useResource('/data/companies', { initial: [] });
  const clients = useResource('/data/clients', { initial: [] });
  const auditTypes = useResource('/data/audit-types', { initial: [] });
  const languages = useResource('/data/languages', { initial: [] });
  const templates = useResource('/templates?purpose=report', { initial: [] });
  const users = useResource('/users?active=true', { initial: [] });
  const customFields = useResource('/data/custom-fields', { initial: [] });

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  /**
   * The form as it arrived, so "has anything been typed" is answerable.
   *
   * Compared rather than tracked with a flag: this form has fifteen inputs plus three
   * member lists, and a flag set by each of them is a flag one of them forgets.
   */
  const [pristine, setPristine] = useState(null);

  // Re-seed the form whenever a different engagement (or a reload) arrives.
  useEffect(() => {
    const seeded = {
      name: audit.name ?? '',
      reference: audit.reference ?? '',
      auditType: audit.auditType ?? '',
      kind: audit.kind ?? 'standard',
      language: audit.language ?? 'en',
      company: idOf(audit.company),
      client: idOf(audit.client),
      template: idOf(audit.template),
      date: audit.date ?? '',
      date_start: audit.date_start ?? '',
      date_end: audit.date_end ?? '',
      sortFindings: audit.sortFindings !== false,
      collaborators: (audit.collaborators ?? []).map(idOf),
      reviewers: (audit.reviewers ?? []).map(idOf),
      memberUntil: (audit.memberUntil ?? []).map((entry) => ({
        user: idOf(entry.user),
        until: entry.until ?? '',
      })),
      recipients: (audit.recipients ?? []).map(idOf),
      recipientRoles: (audit.recipientRoles ?? []).map((entry) => ({
        client: idOf(entry.client),
        role: entry.role ?? 'technical',
      })),
      customFields: audit.customFields ?? [],
    };
    setForm(seeded);
    setPristine(JSON.stringify(seeded));
  }, [audit]);

  useUnsavedWork(Boolean(form) && pristine !== null && JSON.stringify(form) !== pristine, 'The engagement details');

  const auditCustomFields = useMemo(
    () => (customFields.data ?? []).filter((f) => f.display === 'audit'),
    [customFields.data]
  );

  if (!form) return null;

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const clientOptions = (clients.data ?? [])
    .filter((c) => !form.company || idOf(c.company) === form.company)
    .map((c) => ({
      value: c._id,
      label: [c.firstname, c.lastname].filter(Boolean).join(' ') || c.email,
    }));

  const setCustomField = (definition, value) => {
    const next = [...form.customFields];
    const index = next.findIndex((f) => f.key === definition.key);
    const entry = {
      key: definition.key,
      label: definition.label,
      fieldType: definition.fieldType,
      value,
    };
    if (index === -1) next.push(entry);
    else next[index] = entry;
    set({ customFields: next });
  };

  const customValue = (key) => form.customFields.find((f) => f.key === key)?.value ?? '';

  const toggleMember = (field, userId) => {
    const current = new Set(form[field]);
    if (current.has(userId)) current.delete(userId);
    else current.add(userId);
    set({ [field]: [...current] });
  };

  const save = async ({ force = false } = {}) => {
    setSaving(true);
    try {
      const payload = { ...form };
      for (const key of ['company', 'client', 'template']) if (!payload[key]) payload[key] = null;
      // The details marker, not `updatedAt` — see the server route for why.
      if (audit.detailsUpdatedAt && !force) payload.expectedUpdatedAt = audit.detailsUpdatedAt;

      const updated = await api.put(`/audits/${audit._id}`, payload);
      setConflict(null);
      onPatch(updated);
      toast.success('Engagement saved');
    } catch (error) {
      if (error?.isConflict) setConflict(error.current ?? {});
      else toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader
            title="Engagement details"
            description="These values feed the cover page and document control table of the report."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Engagement name"
              required
              wrapperClassName="sm:col-span-2"
              value={form.name}
              disabled={!editable}
              onChange={(e) => set({ name: e.target.value })}
            />
            <Input
              label="Reference"
              value={form.reference}
              disabled={!editable}
              onChange={(e) => set({ reference: e.target.value })}
            />
            <Select
              label="Engagement type"
              placeholder="Not set"
              value={form.auditType}
              disabled={!editable}
              onChange={(e) => {
                /*
                 * Picking a type that knows its shape sets the shape too.
                 *
                 * The type is a blueprint everywhere else — sections, reviewers, scope groups —
                 * and having to tell the app twice that "Phishing Campaign" is a phishing
                 * campaign is exactly the sort of thing people forget once and then wonder why
                 * the tab is missing. Still a form, so it can be overridden before saving.
                 */
                const chosen = (auditTypes.data ?? []).find((t) => t.name === e.target.value);
                set({
                  auditType: e.target.value,
                  ...(chosen?.kind ? { kind: chosen.kind } : {}),
                });
              }}
              options={(auditTypes.data ?? []).map((t) => ({ value: t.name, label: t.name }))}
            />
            {/*
              Distinct from the type above, which is the firm's own taxonomy for the report. This
              decides which parts of the app the engagement has — a campaign has a mailing list
              rather than a scope of hosts.
            */}
            <Select
              label="What shape of work"
              hint="A phishing campaign gets a sending list instead of a scope of assets."
              value={form.kind}
              disabled={!editable}
              onChange={(e) => set({ kind: e.target.value })}
              options={[
                { value: 'standard', label: 'Standard — assets and findings' },
                { value: 'phishing', label: 'Phishing campaign' },
              ]}
            />
            <Select
              label="Client company"
              placeholder="Not set"
              value={form.company}
              disabled={!editable}
              onChange={(e) => set({ company: e.target.value, client: '' })}
              options={(companies.data ?? []).map((c) => ({ value: c._id, label: c.name }))}
            />
            <Select
              label="Client contact"
              hint="The report is addressed to this person."
              placeholder="Not set"
              value={form.client}
              disabled={!editable}
              onChange={(e) => set({ client: e.target.value })}
              options={clientOptions}
            />

            {/* Everyone else it goes to. A report usually has more than one reader —
                the technical contact who commissioned it, plus whoever signs off.
                What each of them *is* to the report is set below. */}
            {clientOptions.length > 1 ? (
              <Field
                label="Also send to"
                hint="Available to templates as the recipients loop, and as recipientNames."
                className="sm:col-span-2"
              >
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 py-1">
                  {clientOptions
                    .filter((option) => option.value !== form.client)
                    .map((option) => {
                      const checked = (form.recipients ?? []).includes(option.value);
                      return (
                        <label
                          key={option.value}
                          className={cn(
                            'flex items-center gap-2 text-xs text-fg',
                            editable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!editable}
                            onChange={() => {
                              const current = new Set(form.recipients ?? []);
                              if (current.has(option.value)) current.delete(option.value);
                              else current.add(option.value);
                              set({ recipients: [...current] });
                            }}
                            className="size-3.5 rounded border-line bg-canvas accent-brand-500"
                          />
                          {option.label}
                        </label>
                      );
                    })}
                </div>
              </Field>
            ) : null}

            {/*
              What each recipient is to this report.
              Only shown once there is a list to describe — a single contact with a role picker
              beside them is a question nobody asked.
            */}
            {(form.recipients ?? []).length ? (
              <Field
                label="Who each of them is"
                hint="Templates read role and roleLabel on the recipients loop, and signatories on its own. Everybody starts as a technical contact."
                className="sm:col-span-2"
              >
                <div className="flex flex-col gap-1.5 py-1">
                  {(form.recipients ?? []).map((id) => {
                    const label =
                      clientOptions.find((option) => option.value === id)?.label ?? 'A contact';
                    const role =
                      (form.recipientRoles ?? []).find((entry) => entry.client === id)?.role ??
                      'technical';
                    return (
                      <div key={id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-fg">
                          {label}
                          {id === form.client ? (
                            <span className="ml-1.5 text-[0.625rem] text-fg-subtle">primary</span>
                          ) : null}
                        </span>
                        <select
                          value={role}
                          disabled={!editable}
                          onChange={(event) => {
                            const others = (form.recipientRoles ?? []).filter(
                              (entry) => entry.client !== id
                            );
                            set({
                              recipientRoles: [...others, { client: id, role: event.target.value }],
                            });
                          }}
                          className="h-8 rounded-lg bg-canvas/60 px-2 text-xs text-fg ring-1 ring-line focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:opacity-60"
                        >
                          {RECIPIENT_ROLES.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </Field>
            ) : null}

            <Input
              label="Report date"
              type="date"
              value={form.date}
              disabled={!editable}
              onChange={(e) => set({ date: e.target.value })}
            />
            <Select
              label="Report language"
              value={form.language}
              disabled={!editable}
              onChange={(e) => set({ language: e.target.value })}
              options={(languages.data ?? []).map((l) => ({ value: l.locale, label: l.language }))}
            />
            <Input
              label="Testing starts"
              type="date"
              value={form.date_start}
              disabled={!editable}
              onChange={(e) => set({ date_start: e.target.value })}
            />
            <Input
              label="Testing ends"
              type="date"
              value={form.date_end}
              disabled={!editable}
              onChange={(e) => set({ date_end: e.target.value })}
            />
          </CardBody>
        </Card>

        {auditCustomFields.length ? (
          <Card>
            <CardHeader
              title="Custom fields"
              description="Defined under Clients & Data. Each one is available in templates as {{ .custom.KEY }}."
            />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              {auditCustomFields.map((definition) => (
                <div
                  key={definition.key}
                  className={isWideField(definition) ? 'sm:col-span-2' : undefined}
                >
                  <CustomFieldInput
                    definition={definition}
                    value={customValue(definition.key)}
                    disabled={!editable}
                    onChange={(value) => setCustomField(definition, value)}
                  />
                </div>
              ))}
            </CardBody>
          </Card>
        ) : null}
      </div>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Report output" description="Which template this engagement renders with." />
          <CardBody className="flex flex-col gap-4">
            <Select
              label="Template"
              placeholder="Not assigned"
              value={form.template}
              disabled={!editable}
              onChange={(e) => set({ template: e.target.value })}
              options={(templates.data ?? []).map((t) => ({ value: t._id, label: t.name }))}
              hint={
                (templates.data?.length ?? 0) === 0
                  ? 'No templates uploaded yet — add one on the Templates page.'
                  : 'Reports are rendered from this .docx.'
              }
            />
            <Field label="Finding order">
              <Checkbox
                label="Order findings by CVSS score automatically"
                checked={form.sortFindings}
                disabled={!editable}
                onChange={(checked) => set({ sortFindings: checked })}
              />
              <p className="mt-1.5 text-xs leading-relaxed text-fg-subtle">
                Turn this off to keep the manual order you set by dragging findings.
              </p>
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Team"
            icon={Users}
            description={
              canManageTeam
                ? 'Collaborators can edit. Reviewers can approve.'
                : 'Collaborators can edit. Reviewers can approve. Only the person who created this engagement, or an admin, can change who is on it.'
            }
            actions={
              canManageTeam ? null : (
                <span
                  title="The server enforces this too — it is not only the checkboxes"
                  className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-[0.625rem] text-fg-subtle"
                >
                  <Lock size={11} />
                  {creatorName ? `${creatorName}'s call` : 'creator only'}
                </span>
              )
            }
          />
          <CardBody className="flex flex-col gap-4">
            {['collaborators', 'reviewers'].map((field) => (
              <div key={field}>
                <p className="mb-2 text-xs font-medium capitalize text-fg-muted">{field}</p>
                <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
                  {(users.data ?? []).map((member) => {
                    const checked = form[field].includes(member.id);
                    // Locked for everyone but the creator and admins, so the reason is
                    // visible here rather than arriving as an error on save.
                    const locked = !editable || !canManageTeam;
                    return (
                      <label
                        key={member.id}
                        title={locked && checked ? `On the team as a ${field.slice(0, -1)}` : undefined}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition',
                          locked ? 'cursor-default' : 'cursor-pointer hover:bg-white/5'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
                          onChange={() => toggleMember(field, member.id)}
                          className="size-3.5 rounded border-line bg-canvas accent-brand-500 disabled:opacity-40"
                        />
                        <Avatar user={member} size={22} />
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-xs',
                            locked && !checked ? 'text-fg-muted' : 'text-fg'
                          )}
                        >
                          {displayName(member)}
                        </span>
                        {/*
                          When their access ends, for the people it does.
                          On the row rather than in a separate list, because "who is on this"
                          and "until when" are one question — and only for somebody already
                          ticked, since a date for a non-member describes nothing.
                        */}
                        {checked && member.id !== idOf(audit.creator) ? (
                          <MemberUntil
                            value={untilFor(member.id)}
                            disabled={locked}
                            onChange={(until) => setMemberUntil(member.id, until)}
                          />
                        ) : null}
                        <span className="text-[0.625rem] capitalize text-fg-subtle">
                          {member.role}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>

        {/* Under the team, because who may sign off is decided by who is on it. */}
        <SignOffCard audit={audit} onReload={onReload} />

        <TagEditor audit={audit} editable={editable} onPatch={onPatch} />

        <ClassificationCard audit={audit} editable={editable} onPatch={onPatch} />

        {/* Last, because it is about the next engagement rather than this one. */}
        <RepeatCard audit={audit} editable={editable} onPatch={onPatch} />
      </div>

      {editable ? (
        <div className="sticky bottom-4 z-20 lg:col-span-2">
          <div className="flex items-center justify-end gap-3 rounded-card border border-line bg-overlay/95 px-4 py-3 shadow-pop backdrop-blur">
            <p className="mr-auto text-xs text-fg-muted">
              Findings and sections save on their own — this button saves the fields above.
            </p>
            <Button variant="primary" icon={Save} loading={saving} onClick={() => save()}>
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <ConflictDialog
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        onDiscard={() => {
          setConflict(null);
          onReload?.({ quiet: true });
        }}
        onOverwrite={() => save({ force: true })}
        label="these engagement details"
        current={conflict}
        loading={saving}
      />
    </div>
  );
}
