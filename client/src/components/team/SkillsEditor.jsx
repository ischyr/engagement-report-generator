import { useEffect, useState } from 'react';
import { Award, Plus, Trash2, Wrench } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';

/**
 * Four steps, not five stars.
 *
 * A scale with a middle invites everybody to sit in it. These four each say something a
 * lead can act on: who to give the work to, and who to pair them with.
 */
export const LEVELS = [
  { value: 'learning', label: 'Learning', pips: 1 },
  { value: 'working', label: 'Working knowledge', pips: 2 },
  { value: 'strong', label: 'Strong', pips: 3 },
  { value: 'expert', label: 'Expert', pips: 4 },
];

const BLANK = {
  headline: '',
  bio: '',
  yearsExperience: '',
  languages: '',
  skills: [],
  certifications: [],
};

/**
 * The one form for skills and experience, used from the Skills page and from your own
 * profile — the same fields either way, so the two can never drift apart.
 */
export default function SkillsEditor({ userId, name, open, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !userId) return;
    setForm(null);
    api
      .get(`/users/${userId}/profile`)
      .then((profile) =>
        setForm({
          ...BLANK,
          headline: profile.headline ?? '',
          bio: profile.bio ?? '',
          yearsExperience: profile.yearsExperience ?? '',
          languages: (profile.languages ?? []).join(', '),
          skills: profile.skills ?? [],
          certifications: profile.certifications ?? [],
        })
      )
      .catch((error) => toast.fromError(error));
  }, [open, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.put(`/users/${userId}/profile`, {
        headline: form.headline,
        bio: form.bio,
        // An empty field means "not stated", which is not the same as zero years.
        yearsExperience: form.yearsExperience === '' ? null : Number(form.yearsExperience),
        languages: form.languages
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        // Rows somebody started and abandoned are dropped rather than saved blank.
        skills: form.skills.filter((skill) => skill.name.trim()),
        certifications: form.certifications.filter((entry) => entry.name.trim()),
      });
      toast.success('Saved');
      onSaved?.(saved);
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const rows = (key) => form?.[key] ?? [];
  const setRow = (key, index, patch) =>
    set({ [key]: rows(key).map((row, at) => (at === index ? { ...row, ...patch } : row)) });
  const addRow = (key, row) => set({ [key]: [...rows(key), row] });
  const dropRow = (key, index) => set({ [key]: rows(key).filter((_row, at) => at !== index) });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={name ? `Skills — ${name}` : 'Skills and experience'}
      description="What you can do, and what you hold. Everyone signed in can read this; only you or an admin can change it."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!form} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {!form ? (
        <p className="text-xs text-fg-subtle">Loading…</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Headline"
              placeholder="Lead tester — web, cloud, mobile"
              wrapperClassName="sm:col-span-2"
              value={form.headline}
              onChange={(event) => set({ headline: event.target.value })}
            />
            <Input
              label="Years in the trade"
              type="number"
              min="0"
              max="60"
              placeholder="Not stated"
              value={form.yearsExperience}
              onChange={(event) => set({ yearsExperience: event.target.value })}
            />
            <Input
              label="Languages"
              hint="Comma separated. Who can run a workshop in Romanian."
              placeholder="English, Romanian"
              value={form.languages}
              onChange={(event) => set({ languages: event.target.value })}
            />
            <Textarea
              label="About"
              rows={3}
              wrapperClassName="sm:col-span-2"
              placeholder="The work you like, the systems you know, anything a colleague would want to know before asking you."
              value={form.bio}
              onChange={(event) => set({ bio: event.target.value })}
            />
          </div>

          {/* ------------------------------------------------------------ skills */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <Wrench size={13} className="text-fg-subtle" />
                Skills
              </p>
              <Button
                variant="ghost"
                size="sm"
                icon={Plus}
                onClick={() => addRow('skills', { name: '', level: 'working' })}
              >
                Add a skill
              </Button>
            </div>
            {form.skills.length === 0 ? (
              <p className="text-[0.6875rem] text-fg-subtle">
                Nothing yet. Name the things you would be given work for — "Web application
                testing", "Active Directory", "Burp extensions".
              </p>
            ) : (
              form.skills.map((skill, index) => (
                <div key={index} className="flex items-end gap-2">
                  <Input
                    placeholder="Web application testing"
                    wrapperClassName="flex-1"
                    value={skill.name}
                    onChange={(event) => setRow('skills', index, { name: event.target.value })}
                  />
                  <Select
                    value={skill.level}
                    wrapperClassName="w-48"
                    onChange={(event) => setRow('skills', index, { level: event.target.value })}
                    options={LEVELS.map((level) => ({ value: level.value, label: level.label }))}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    aria-label="Remove"
                    className="mb-1 hover:text-crit"
                    onClick={() => dropRow('skills', index)}
                  />
                </div>
              ))
            )}
          </div>

          {/* ---------------------------------------------------- certifications */}
          <div className="flex flex-col gap-2 border-t border-line-soft pt-4">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <Award size={13} className="text-fg-subtle" />
                Certifications
              </p>
              <Button
                variant="ghost"
                size="sm"
                icon={Plus}
                onClick={() =>
                  addRow('certifications', { name: '', issuer: '', obtainedAt: '', expiresAt: '' })
                }
              >
                Add a certification
              </Button>
            </div>
            {form.certifications.length === 0 ? (
              <p className="text-[0.6875rem] text-fg-subtle">
                An expiry date is optional, and worth adding — the page warns before one lapses,
                which is the failure this exists to prevent.
              </p>
            ) : (
              form.certifications.map((entry, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto_auto]">
                  <Input
                    placeholder="OSCP"
                    value={entry.name}
                    onChange={(event) =>
                      setRow('certifications', index, { name: event.target.value })
                    }
                  />
                  <Input
                    placeholder="Offensive Security"
                    value={entry.issuer}
                    onChange={(event) =>
                      setRow('certifications', index, { issuer: event.target.value })
                    }
                  />
                  <Input
                    type="date"
                    title="Obtained"
                    value={entry.obtainedAt}
                    onChange={(event) =>
                      setRow('certifications', index, { obtainedAt: event.target.value })
                    }
                  />
                  <Input
                    type="date"
                    title="Expires"
                    value={entry.expiresAt}
                    onChange={(event) =>
                      setRow('certifications', index, { expiresAt: event.target.value })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    aria-label="Remove"
                    className="hover:text-crit"
                    onClick={() => dropRow('certifications', index)}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
