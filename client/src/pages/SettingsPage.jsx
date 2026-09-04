import { useEffect, useState } from 'react';
import {
  FileCheck,
  Info,
  Palette,
  Palmtree,
  RotateCcw,
  Save,
  Sliders,
  Landmark,
  Sparkles,
  UserCheck,
} from 'lucide-react';

import { Banknote } from 'lucide-react';

import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { formatDateTime } from '../lib/utils.js';

/** Uptime in the largest unit that still says something useful. */
const uptimeLabel = (seconds) => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
};
import { cn } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input, Toggle, Field } from '../components/ui/Field.jsx';
import { ConfirmDialog } from '../components/ui/Modal.jsx';
import { ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import SettingsHistoryCard from '../components/settings/SettingsHistoryCard.jsx';
import EmailCard from '../components/settings/EmailCard.jsx';
import AssistantCard from '../components/settings/AssistantCard.jsx';

const CVSS_COLOR_FIELDS = [
  { key: 'criticalColor', label: 'Critical', severity: 'Critical' },
  { key: 'highColor', label: 'High', severity: 'High' },
  { key: 'mediumColor', label: 'Medium', severity: 'Medium' },
  { key: 'lowColor', label: 'Low', severity: 'Low' },
  { key: 'noneColor', label: 'Informational', severity: 'None' },
];

/** Swatches mirror the exact colours written into the .docx. */
const CODE_THEMES = [
  {
    value: 'terminal',
    label: 'Terminal',
    description: 'Dark console pane. Best for command output and payloads.',
    preview: { bg: '#0D1117', fg: '#E6EDF3', border: '#30363D' },
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Pale box. Easier on printed reports.',
    preview: { bg: '#F6F8FA', fg: '#24292F', border: '#D0D7DE' },
  },
  {
    value: 'template',
    label: "Template's own",
    description: 'Uses the CodeBlock style from your .docx, if it defines one.',
    preview: { bg: '#E6E6E6', fg: '#000000', border: '#AAAAAA' },
  },
];

const DATE_PRESETS = [
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'dd MMMM yyyy',
  'MMMM d, yyyy',
  'd MMM yyyy',
];

/** Colour swatch + hex field. Reports use hex without the leading #. */
function ColorField({ label, value, onChange }) {
  const hex = `#${String(value ?? '').replace('#', '')}`;
  return (
    <div className="flex items-center gap-2.5">
      <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-lg ring-1 ring-line">
        <span className="absolute inset-0" style={{ background: hex }} />
        <input
          type="color"
          value={hex}
          onChange={(event) => onChange(event.target.value.replace('#', '').toUpperCase())}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label={`${label} colour`}
        />
      </label>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-fg-muted">{label}</p>
        <input
          value={String(value ?? '')}
          onChange={(event) =>
            onChange(event.target.value.replace('#', '').toUpperCase().slice(0, 6))
          }
          className="w-full bg-transparent font-mono text-xs text-fg focus:outline-none"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useResource('/settings');

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  /**
   * Bumped after a save or a reset, so the history card below refetches.
   *
   * A key rather than a callback: the card owns its own request, and remounting it is both the
   * smallest change and the one that cannot leave it showing a list that is one save stale.
   */
  const [savedAt, setSavedAt] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** Read here as well as in the footer; the endpoint is cheap and the answer is per session. */
  const build = useResource('/version', { initial: null });

  useEffect(() => {
    if (!data) return;
    setForm({
      branding: {
        appName: data.branding?.appName ?? 'Engy Report',
        tagline: data.branding?.tagline ?? 'Engagement Reporting',
        logo: data.branding?.logo ?? '',
      },
      firm: {
        legalName: data.firm?.legalName ?? '',
        address: data.firm?.address ?? '',
        registration: data.firm?.registration ?? '',
        vat: data.firm?.vat ?? '',
        email: data.firm?.email ?? '',
        phone: data.firm?.phone ?? '',
        signatoryName: data.firm?.signatoryName ?? '',
        signatoryTitle: data.firm?.signatoryTitle ?? '',
        jurisdiction: data.firm?.jurisdiction ?? '',
      },
      report: {
        public: {
          cvssColors: { ...(data.report?.public?.cvssColors ?? {}) },
          captionStyle: data.report?.public?.captionStyle ?? 'Caption',
          figureNumbering: data.report?.public?.figureNumbering !== false,
          figureLabel: data.report?.public?.figureLabel ?? 'Figure',
          dateFormat: data.report?.public?.dateFormat ?? 'yyyy-MM-dd',
          findingIdPrefix: data.report?.public?.findingIdPrefix ?? '',
          codeBlockTheme: data.report?.public?.codeBlockTheme ?? 'terminal',
        },
        private: {
          imageBorder: Boolean(data.report?.private?.imageBorder),
          imageBorderColor: data.report?.private?.imageBorderColor ?? '000000',
          updateFieldsOnOpen: data.report?.private?.updateFieldsOnOpen !== false,
        },
      },
      reviews: {
        enabled: Boolean(data.reviews?.enabled),
        public: {
          mandatoryReview: Boolean(data.reviews?.public?.mandatoryReview),
          minReviewers: data.reviews?.public?.minReviewers ?? 1,
        },
      },
      /*
       * The rate card. `null` for a rate means "not filled in", which is why these are not
       * coerced to 0 here — a firm with no rate card should see empty boxes and a proposal with
       * no price, not a rate of nothing.
       */
      sales: {
        currency: data.sales?.currency ?? 'EUR',
        dayRate: data.sales?.dayRate ?? null,
        floorDayRate: data.sales?.floorDayRate ?? null,
        maxDiscountPercent: data.sales?.maxDiscountPercent ?? 0,
        taxLabel: data.sales?.taxLabel ?? 'VAT',
        taxPercent: data.sales?.taxPercent ?? 0,
        paymentTermsDays: data.sales?.paymentTermsDays ?? 30,
      },
      leave: {
        allowanceDays: data.leave?.allowanceDays ?? 25,
        requireApproval: data.leave?.requireApproval !== false,
      },
      /*
       * No `password` key, on purpose. The server never sends one back, and an absent key means
       * "leave the stored one alone" — so it appears here only once somebody types in the field.
       */
      email: {
        enabled: Boolean(data.email?.enabled),
        provider: data.email?.provider ?? 'custom',
        host: data.email?.host ?? '',
        port: data.email?.port ?? 587,
        security: data.email?.security ?? 'starttls',
        username: data.email?.username ?? '',
        fromName: data.email?.fromName ?? '',
        fromAddress: data.email?.fromAddress ?? '',
        replyTo: data.email?.replyTo ?? '',
        allowInvalidCertificates: Boolean(data.email?.allowInvalidCertificates),
        allowPlaintextAuth: Boolean(data.email?.allowPlaintextAuth),
        notifications: data.email?.notifications !== false,
      },
      /* No `key` either, and for exactly the same reason as the password above. */
      assistant: {
        enabled: Boolean(data.assistant?.enabled),
        provider: data.assistant?.provider ?? 'anthropic',
        wire: data.assistant?.wire ?? 'anthropic',
        endpoint: data.assistant?.endpoint ?? '',
        model: data.assistant?.model ?? '',
        timeoutSeconds: data.assistant?.timeoutSeconds ?? 60,
        houseStyle: data.assistant?.houseStyle ?? '',
        jobs: { ...(data.assistant?.jobs ?? {}) },
        allowRestricted: Boolean(data.assistant?.allowRestricted),
      },
    });
  }, [data]);

  if (loading) return <LoadingBlock label="Loading settings…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!form) return null;

  const setBranding = (patch) =>
    setForm((current) => ({ ...current, branding: { ...current.branding, ...patch } }));

  const setSales = (patch) =>
    setForm((current) => ({ ...current, sales: { ...current.sales, ...patch } }));

  /** An empty box means "no rate", not zero — see the note where this form is initialised. */
  const rateOrNull = (value) => (String(value).trim() === '' ? null : Math.max(0, Number(value) || 0));

  const setFirm = (patch) =>
    setForm((current) => ({ ...current, firm: { ...current.firm, ...patch } }));

  const setReport = (patch) =>
    setForm((current) => ({
      ...current,
      report: { ...current.report, public: { ...current.report.public, ...patch } },
    }));

  const setReportPrivate = (patch) =>
    setForm((current) => ({
      ...current,
      report: { ...current.report, private: { ...current.report.private, ...patch } },
    }));

  const setColor = (key, value) =>
    setReport({ cvssColors: { ...form.report.public.cvssColors, [key]: value } });

  /**
   * Reads the chosen file into a data URI.
   *
   * Bounded at 300 KB because this is served on every page load, including the
   * sign-in screen — a multi-megabyte logo would slow down the first paint for
   * everybody.
   */
  const readLogo = (file) => {
    if (!file) return;
    if (file.size > 300 * 1024) {
      toast.error('That logo is too large', 'Use an image under 300 KB — it loads on every page.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBranding({ logo: String(reader.result) });
    reader.onerror = () => toast.error('Could not read that image');
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.put('/settings', form);
      setData(updated);
      setSavedAt(Date.now());
      toast.success('Settings saved');
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      const fresh = await api.post('/settings/reset');
      setData(fresh);
      setSavedAt(Date.now());
      setResetOpen(false);
      toast.success('Settings restored to defaults');
    } catch (err) {
      toast.fromError(err);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Instance-wide preferences. These affect how every report is generated."
        actions={
          <>
            <Button variant="ghost" icon={RotateCcw} onClick={() => setResetOpen(true)}>
              Reset
            </Button>
            <Button variant="primary" icon={Save} loading={saving} onClick={save}>
              Save settings
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* First card, because it is the one thing that changes what everybody sees. */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Branding"
            icon={Sparkles}
            description="What this instance calls itself — in the sidebar, on the sign-in screen and in the browser tab."
          />
          <CardBody className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              label="Name"
              placeholder="Engy Report"
              value={form.branding.appName}
              onChange={(event) => setBranding({ appName: event.target.value })}
              hint="Shown above the sidebar and as the page title."
            />
            <Input
              label="Tagline"
              placeholder="Engagement Reporting"
              value={form.branding.tagline}
              onChange={(event) => setBranding({ tagline: event.target.value })}
              hint="The small line underneath. Leave empty to hide it."
            />
            <Field label="Logo" hint="Replaces the monogram and the tab icon.">
              <div className="flex items-center gap-3">
                {form.branding.logo ? (
                  <img
                    src={form.branding.logo}
                    alt=""
                    className="size-10 rounded-lg bg-white/5 object-contain p-1"
                  />
                ) : (
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 font-bold text-white">
                    {(form.branding.appName || 'E').trim().charAt(0).toUpperCase()}
                  </span>
                )}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  onChange={(event) => readLogo(event.target.files?.[0])}
                  className="w-44 text-xs text-fg-muted file:mr-2 file:rounded-md file:border-0 file:bg-white/8 file:px-2 file:py-1 file:text-xs file:text-fg hover:file:bg-white/12"
                />
                {form.branding.logo ? (
                  <Button variant="ghost" size="sm" onClick={() => setBranding({ logo: '' })}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </Field>
          </CardBody>
        </Card>

        {/*
          Directly under Branding, because they are the same question asked twice: what this
          instance is called on screen, and what the company is called on a contract. Only the
          proposal paperwork reads these — a report has never needed them.
        */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Your firm"
            icon={Landmark}
            description="The first party on every NDA and permission to attack the Sales section generates. Nothing here appears in an engagement report."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              label="Legal name"
              placeholder="Offensive Security Ltd"
              wrapperClassName="lg:col-span-2"
              hint="As registered. Not the trading name, unless they are the same."
              value={form.firm.legalName}
              onChange={(event) => setFirm({ legalName: event.target.value })}
            />
            <Input
              label="Company number"
              value={form.firm.registration}
              onChange={(event) => setFirm({ registration: event.target.value })}
            />
            <Input
              label="Registered address"
              wrapperClassName="lg:col-span-2"
              value={form.firm.address}
              onChange={(event) => setFirm({ address: event.target.value })}
            />
            <Input
              label="VAT number"
              value={form.firm.vat}
              onChange={(event) => setFirm({ vat: event.target.value })}
            />
            <Input
              label="Contact email"
              type="email"
              value={form.firm.email}
              onChange={(event) => setFirm({ email: event.target.value })}
            />
            <Input
              label="Phone"
              value={form.firm.phone}
              onChange={(event) => setFirm({ phone: event.target.value })}
            />
            <Input
              label="Governing law"
              placeholder="England and Wales"
              hint="Every one of these documents has a clause naming it."
              value={form.firm.jurisdiction}
              onChange={(event) => setFirm({ jurisdiction: event.target.value })}
            />
            <Input
              label="Who signs"
              placeholder="Alex Prine"
              value={form.firm.signatoryName}
              onChange={(event) => setFirm({ signatoryName: event.target.value })}
            />
            <Input
              label="Their title"
              placeholder="Director"
              value={form.firm.signatoryTitle}
              onChange={(event) => setFirm({ signatoryTitle: event.target.value })}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Severity colours"
            icon={Palette}
            description="Used wherever a template asks for a severity colour, for example a coloured finding header."
          />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            {CVSS_COLOR_FIELDS.map((field) => (
              <ColorField
                key={field.key}
                label={field.label}
                value={form.report.public.cvssColors[field.key]}
                onChange={(value) => setColor(field.key, value)}
              />
            ))}
          </CardBody>
          <CardBody className="border-t border-line-soft">
            <p className="text-xs leading-relaxed text-fg-subtle">
              These are the colours written into the generated .docx. The colours you see in this
              app are fixed and chosen for on-screen contrast, so they will not always match.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Report formatting"
            icon={Sliders}
            description="How dates and finding identifiers appear in generated documents."
          />
          <CardBody className="flex flex-col gap-4">
            <Field
              label="Date format"
              hint="Pattern letters: yyyy yy MMMM MMM MM M dd d EEEE EEE HH mm ss"
            >
              <input
                value={form.report.public.dateFormat}
                onChange={(event) => setReport({ dateFormat: event.target.value })}
                className="h-9.5 w-full rounded-lg bg-canvas/60 px-3 font-mono text-sm text-fg ring-1 ring-line focus:ring-2 focus:ring-brand-500 focus:outline-none"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {DATE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setReport({ dateFormat: preset })}
                    className="rounded-md bg-white/5 px-2 py-1 font-mono text-[0.6875rem] text-fg-muted transition hover:bg-white/10 hover:text-fg"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </Field>

            <Input
              label="Finding ID prefix"
              placeholder="VULN-"
              hint="Findings are numbered 01, 02, … With a prefix of VULN- the first becomes VULN-01."
              value={form.report.public.findingIdPrefix}
              onChange={(event) => setReport({ findingIdPrefix: event.target.value })}
            />

            <Input
              label="Caption style name"
              hint="The Word paragraph style applied to image captions. Must exist in your template."
              value={form.report.public.captionStyle}
              onChange={(event) => setReport({ captionStyle: event.target.value })}
            />

            <Toggle
              checked={form.report.public.figureNumbering !== false}
              onChange={(figureNumbering) => setReport({ figureNumbering })}
              label="Number the figures"
              hint="Captions become “Figure 7 — The request”, and a sentence can point at one. The number is a Word field, so it stays right if somebody edits the document afterwards."
            />

            {form.report.public.figureNumbering !== false ? (
              <Input
                label="What a figure is called"
                placeholder="Figure"
                hint="The word in front of the number, in your captions and in every reference to them."
                value={form.report.public.figureLabel}
                onChange={(event) => setReport({ figureLabel: event.target.value })}
              />
            ) : null}

            <Field
              label="Code block appearance"
              hint="How proof-of-concept commands and terminal output are drawn in the report."
            >
              <div className="grid gap-2 sm:grid-cols-3">
                {CODE_THEMES.map((theme) => {
                  const active = form.report.public.codeBlockTheme === theme.value;
                  return (
                    <button
                      key={theme.value}
                      type="button"
                      onClick={() => setReport({ codeBlockTheme: theme.value })}
                      aria-pressed={active}
                      className={cn(
                        'flex flex-col gap-2 rounded-lg p-2.5 text-left ring-1 transition',
                        active
                          ? 'ring-2 ring-brand-500 bg-brand-500/[0.06]'
                          : 'ring-line hover:bg-white/5'
                      )}
                    >
                      {/* Preview of the actual document colours, not the app's. */}
                      <span
                        className="block rounded px-2 py-1.5 font-mono text-[0.625rem] leading-relaxed"
                        style={{
                          background: theme.preview.bg,
                          color: theme.preview.fg,
                          border: `1px solid ${theme.preview.border}`,
                        }}
                      >
                        $ nmap -sV target
                        <br />
                        22/tcp open ssh
                      </span>
                      <span className="text-xs font-medium text-fg">{theme.label}</span>
                      <span className="text-[0.6875rem] leading-snug text-fg-subtle">
                        {theme.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Field>

            <div className="border-t border-line-soft pt-4">
              <Toggle
                checked={form.report.private.imageBorder}
                onChange={(checked) => setReportPrivate({ imageBorder: checked })}
                label="Draw a border around screenshots"
                hint="Helps screenshots stand out from the page in the generated document."
              />
              {form.report.private.imageBorder ? (
                <div className="mt-3 max-w-48">
                  <ColorField
                    label="Border colour"
                    value={form.report.private.imageBorderColor}
                    onChange={(value) => setReportPrivate({ imageBorderColor: value })}
                  />
                </div>
              ) : null}
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Review workflow"
            icon={UserCheck}
            description="Optional approval step before an engagement can be marked approved."
          />
          <CardBody className="flex flex-col gap-4">
            <Toggle
              checked={form.reviews.enabled}
              onChange={(checked) =>
                setForm((current) => ({
                  ...current,
                  reviews: { ...current.reviews, enabled: checked },
                }))
              }
              label="Enable reviews"
              hint="Reviewers assigned to an engagement can record their approval."
            />
            {form.reviews.enabled ? (
              <div className="flex flex-col gap-4 border-t border-line-soft pt-4">
                <Toggle
                  checked={form.reviews.public.mandatoryReview}
                  onChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      reviews: {
                        ...current.reviews,
                        public: { ...current.reviews.public, mandatoryReview: checked },
                      },
                    }))
                  }
                  label="Require approvals before an engagement can be approved"
                />
                <Input
                  label="Minimum approvals"
                  type="number"
                  min={1}
                  max={20}
                  wrapperClassName="max-w-40"
                  value={form.reviews.public.minReviewers}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      reviews: {
                        ...current.reviews,
                        public: {
                          ...current.reviews.public,
                          minReviewers: Math.max(1, Number(event.target.value) || 1),
                        },
                      },
                    }))
                  }
                />
              </div>
            ) : null}
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="The document Word opens"
            icon={FileCheck}
            description="Details of the file itself, rather than of what it says."
          />
          <CardBody className="flex flex-col gap-4">
            <Toggle
              checked={form.report.private.updateFieldsOnOpen}
              onChange={(checked) =>
                setForm((current) => ({
                  ...current,
                  report: {
                    ...current.report,
                    private: { ...current.report.private, updateFieldsOnOpen: checked },
                  },
                }))
              }
              label="Refresh fields when the report is opened"
              hint="A table of contents is a field: without this the client's first page reads “Right-click to update field”. Cross-references and page numbers are refreshed by the same flag. Turn it off to keep the numbering frozen exactly as generated."
            />
          </CardBody>
        </Card>

        <EmailCard
          value={form.email}
          meta={data.email}
          onChange={(email) => setForm((current) => ({ ...current, email }))}
        />

        <AssistantCard
          value={form.assistant}
          meta={data.assistant}
          onChange={(assistant) => setForm((current) => ({ ...current, assistant }))}
        />

        <Card className="lg:col-span-2">
          <CardHeader
            title="The rate card"
            icon={Banknote}
            description="What a day costs, and how far a salesperson may discount it without asking. Everything a proposal is worth is computed from here."
          />
          <CardBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                label="Standard day rate"
                type="number"
                min={0}
                step="10"
                placeholder="Not set"
                hint="Leave empty and proposals carry no price at all, which is what this app did before."
                value={form.sales.dayRate ?? ''}
                onChange={(event) => setSales({ dayRate: rateOrNull(event.target.value) })}
              />
              <Input
                label="Currency"
                maxLength={3}
                className="uppercase"
                hint="A label, not a conversion — there is one currency here."
                value={form.sales.currency}
                onChange={(event) => setSales({ currency: event.target.value.toUpperCase() })}
              />
              <Input
                label="Floor day rate"
                type="number"
                min={0}
                step="10"
                placeholder="No floor"
                hint="After discount. Below this, a price needs a manager’s sign-off before the offer can go out."
                value={form.sales.floorDayRate ?? ''}
                onChange={(event) => setSales({ floorDayRate: rateOrNull(event.target.value) })}
              />
              <Input
                label="Discount a salesperson may give, %"
                type="number"
                min={0}
                max={100}
                hint="Above this, the same sign-off. Zero means every discount is a decision."
                value={form.sales.maxDiscountPercent}
                onChange={(event) =>
                  setSales({
                    maxDiscountPercent: Math.min(100, Math.max(0, Number(event.target.value) || 0)),
                  })
                }
              />
            </div>
            <div className="grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-3">
              <Input
                label="What tax is called"
                maxLength={20}
                hint="Printed on the offer as you write it here."
                value={form.sales.taxLabel}
                onChange={(event) => setSales({ taxLabel: event.target.value })}
              />
              <Input
                label="Tax rate, %"
                type="number"
                min={0}
                max={100}
                step="0.5"
                value={form.sales.taxPercent}
                onChange={(event) =>
                  setSales({ taxPercent: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })
                }
              />
              <Input
                label="Days to pay"
                type="number"
                min={0}
                max={365}
                hint="A client with its own terms overrides this on its record."
                value={form.sales.paymentTermsDays}
                onChange={(event) =>
                  setSales({
                    paymentTermsDays: Math.min(365, Math.max(0, Number(event.target.value) || 0)),
                  })
                }
              />
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Time off"
            icon={Palmtree}
            description="Holiday, sickness and training on the Schedule — and what utilisation is measured against."
          />
          <CardBody className="flex flex-col gap-4">
            <Toggle
              checked={form.leave.requireApproval}
              onChange={(checked) =>
                setForm((current) => ({
                  ...current,
                  leave: { ...current.leave, requireApproval: checked },
                }))
              }
              label="Somebody's own request waits for an admin"
              hint="Off means time off lands on the calendar as soon as it is booked. An admin recording leave is always a decision, never a request."
            />
            <Input
              label="Holiday allowance, in days a year"
              type="number"
              min={0}
              max={365}
              wrapperClassName="max-w-56"
              hint="One allowance for the whole firm — per-person contracts are not modelled. Zero hides the balance rather than claiming everybody has none. Sickness and training never count against it."
              value={form.leave.allowanceDays}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  leave: {
                    ...current.leave,
                    allowanceDays: Math.min(365, Math.max(0, Number(event.target.value) || 0)),
                  },
                }))
              }
            />
          </CardBody>
        </Card>
      </div>

      {/* Last, because it is the record of everything above it. */}
      <SettingsHistoryCard key={savedAt} />

      {/*
        Which build this is.
        Here as well as in the footer because this is the page somebody opens when they are
        already trying to work out what is wrong.
      */}
      <Card>
        <CardHeader
          title="About this instance"
          icon={Info}
          description="What is running, and since when — the first question anybody asks about a problem."
        />
        <CardBody className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <span>
            <span className="block text-[0.625rem] uppercase tracking-wider text-fg-subtle">
              Version
            </span>
            <span className="font-mono text-fg">
              {build.data?.version ?? '—'}
              {build.data?.commit ? ` (${build.data.commit})` : ''}
            </span>
          </span>
          <span>
            <span className="block text-[0.625rem] uppercase tracking-wider text-fg-subtle">
              Branch
            </span>
            <span className="font-mono text-fg">{build.data?.branch ?? '—'}</span>
          </span>
          <span>
            <span className="block text-[0.625rem] uppercase tracking-wider text-fg-subtle">
              Node
            </span>
            <span className="font-mono text-fg">{build.data?.node ?? '—'}</span>
          </span>
          <span>
            <span className="block text-[0.625rem] uppercase tracking-wider text-fg-subtle">
              Running since
            </span>
            <span className="text-fg">
              {build.data?.startedAt ? formatDateTime(build.data.startedAt) : '—'}
              {build.data?.uptime ? (
                <span className="ml-1 text-fg-subtle">({uptimeLabel(build.data.uptime)})</span>
              ) : null}
            </span>
          </span>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={reset}
        loading={resetting}
        title="Restore default settings?"
        confirmLabel="Reset"
        message="Every preference on this page goes back to its shipped default. Engagements, findings and templates are untouched."
      />
    </div>
  );
}
