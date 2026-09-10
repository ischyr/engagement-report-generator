import { useMemo, useState } from 'react';
import {
  Award,
  Grid3x3,
  GraduationCap,
  Languages,
  Pencil,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  Wrench,
} from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { cn, formatDate } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput, Avatar, Stat, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Select } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import SkillsEditor from '../components/team/SkillsEditor.jsx';
import SkillPips, { DepthBar } from '../components/team/SkillPips.jsx';
import SkillMatrix from '../components/team/SkillMatrix.jsx';
import PersonProfile from '../components/team/PersonProfile.jsx';
import CertificationWall from '../components/team/CertificationWall.jsx';
import {
  LEVELS,
  byStrength,
  expiryState,
  hasProfile,
  isDeep,
  levelOf,
} from '../components/team/skills-meta.js';

const VIEWS = [
  { value: 'people', label: 'People', icon: Users },
  { value: 'skills', label: 'Skills', icon: Wrench },
  { value: 'matrix', label: 'Coverage', icon: Grid3x3 },
  { value: 'certifications', label: 'Certifications', icon: Award },
];

const SORTS = [
  { value: 'depth', label: 'Deepest first' },
  { value: 'name', label: 'Name' },
  { value: 'skills', label: 'Most skills' },
  { value: 'experience', label: 'Most experience' },
];

/**
 * Who can do what — and, more to the point, what happens when one of them is unavailable.
 *
 * Assigning work used to be tribal knowledge: who has done Android, who knows Active
 * Directory, whose certification lapses in March. Readable by everyone signed in on purpose —
 * a tester asks "who should I ask about this" as often as a lead asks "who can take this job".
 *
 * Four views of one dataset rather than four pages, because they answer four different
 * questions about the same twelve profiles: who is here, what the team can do, where it is
 * one deep, and what lapses next. The filters scope all of them.
 */
export default function SkillsPage() {
  const { user, isAdmin } = useAuth();
  const { data, error, loading, reload } = useResource('/users/skills', { initial: null });

  const [view, setView] = useState('people');
  const [search, setSearch] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [sort, setSort] = useState('depth');
  const [editing, setEditing] = useState(null);
  const [inspecting, setInspecting] = useState(null);

  const me = String(user?.id ?? user?._id ?? '');
  const people = data?.people ?? [];
  const skills = data?.skills ?? [];
  const coverage = data?.coverage ?? null;

  const needle = search.trim().toLowerCase();

  /**
   * The people a reader is currently asking about.
   *
   * Every filter narrows the same set, and every view reads it — a search that only worked
   * on one tab would be a search somebody stops trusting.
   */
  const shown = useMemo(() => {
    const matches = people.filter((person) => {
      if (skillFilter) {
        const held = person.skills.find(
          (skill) => skill.name.toLowerCase() === skillFilter.toLowerCase()
        );
        if (!held) return false;
        if (levelFilter === 'deep' && !isDeep(held.level)) return false;
      } else if (levelFilter === 'deep' && !person.skills.some((skill) => isDeep(skill.level))) {
        return false;
      }
      if (!needle) return true;
      return [
        person.fullname,
        person.username,
        person.title,
        person.headline,
        person.bio,
        ...person.skills.map((skill) => skill.name),
        ...person.certifications.map((entry) => `${entry.name} ${entry.issuer}`),
        ...person.languages,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });

    const deepest = (person) => person.skills.filter((skill) => isDeep(skill.level)).length;
    return matches.sort((a, b) => {
      // Anybody who has written something down comes first whatever the sort: the server
      // returns username order, which is right for a roster and wrong for an answer.
      const filled = Number(hasProfile(b)) - Number(hasProfile(a));
      if (filled) return filled;
      if (sort === 'name') return a.fullname.localeCompare(b.fullname);
      if (sort === 'skills') return b.skills.length - a.skills.length || a.fullname.localeCompare(b.fullname);
      if (sort === 'experience') {
        return (b.yearsExperience ?? -1) - (a.yearsExperience ?? -1) || a.fullname.localeCompare(b.fullname);
      }
      return deepest(b) - deepest(a) || b.skills.length - a.skills.length || a.fullname.localeCompare(b.fullname);
    });
  }, [people, needle, skillFilter, levelFilter, sort]);

  /** The skill rows, scoped by the same search so the Skills and Coverage views agree. */
  const shownSkills = useMemo(() => {
    const scoped = skills.filter((skill) => {
      if (skillFilter && skill.name.toLowerCase() !== skillFilter.toLowerCase()) return false;
      if (levelFilter === 'deep' && skill.depth === 0) return false;
      if (!needle) return true;
      return (
        skill.name.toLowerCase().includes(needle) ||
        skill.holders.some((holder) => holder.fullname.toLowerCase().includes(needle))
      );
    });
    return sort === 'name'
      ? [...scoped].sort((a, b) => a.name.localeCompare(b.name))
      : [...scoped].sort((a, b) => b.depth - a.depth || b.people - a.people || a.name.localeCompare(b.name));
  }, [skills, needle, skillFilter, levelFilter, sort]);

  /** Certifications that have lapsed or are about to, across everybody. */
  const lapsing = useMemo(
    () =>
      people
        .flatMap((person) =>
          person.certifications
            .map((entry) => ({ person, entry, state: expiryState(entry.expiresAt) }))
            .filter((row) => row.state.key === 'expired' || row.state.key === 'expiring')
        )
        .sort((a, b) => a.entry.expiresAt.localeCompare(b.entry.expiresAt)),
    [people]
  );

  if (loading && !data) return <LoadingBlock label="Reading the team…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const mayEdit = (person) => isAdmin || person.id === me;
  const filtered = Boolean(needle || skillFilter || levelFilter);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Skills"
        description="What everyone can do, what they hold, and where the team is one deep — so assigning work is not a matter of asking around."
        actions={
          <Button variant="primary" icon={Pencil} onClick={() => setEditing({ id: me, name: 'you' })}>
            Edit yours
          </Button>
        }
      />

      {/* The numbers a lead actually asks for, before any list. */}
      {coverage ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Recorded"
            value={`${coverage.recorded}/${coverage.people}`}
            sub={
              coverage.recorded < coverage.people
                ? `${coverage.people - coverage.recorded} still blank`
                : 'everybody has written something'
            }
            tone={coverage.recorded < coverage.people ? 'med' : 'low'}
            icon={Users}
          />
          <Stat
            label="Distinct skills"
            value={coverage.distinctSkills}
            sub={`${coverage.holdings} holdings · ${coverage.experts} at expert`}
            icon={Wrench}
          />
          <Stat
            label="One deep or none"
            value={coverage.oneDeep.length + coverage.noneDeep.length}
            sub={
              coverage.oneDeep.length + coverage.noneDeep.length
                ? 'skills nobody could cover'
                : 'every skill has cover'
            }
            tone={coverage.oneDeep.length + coverage.noneDeep.length ? 'med' : 'low'}
            icon={ShieldCheck}
          />
          <Stat
            label="Certifications"
            value={coverage.certifications.total}
            sub={
              coverage.certifications.expiring + coverage.certifications.expired
                ? `${coverage.certifications.expired} expired · ${coverage.certifications.expiring} expiring`
                : 'all in date'
            }
            tone={
              coverage.certifications.expired
                ? 'crit'
                : coverage.certifications.expiring
                  ? 'med'
                  : 'low'
            }
            icon={Award}
          />
        </div>
      ) : null}

      {/* A certification nobody notices lapsing is the failure this page prevents. */}
      {lapsing.length ? (
        <Card className="border-med/25 bg-med/[0.05]">
          <CardBody className="flex flex-col gap-1.5">
            <p className="flex items-center gap-2 text-xs font-semibold text-fg">
              <TriangleAlert size={14} className="shrink-0 text-med" />
              {lapsing.length} certification{lapsing.length === 1 ? '' : 's'} expired or expiring
              within 90 days
            </p>
            {lapsing.map(({ person, entry, state }) => (
              <button
                key={`${person.id}-${entry.name}`}
                type="button"
                onClick={() => setInspecting(person)}
                className="flex flex-wrap items-center gap-x-2 text-left text-xs text-fg-muted transition hover:text-fg"
              >
                <span className="font-medium text-fg">{person.fullname}</span>
                <span>{entry.name}</span>
                {entry.issuer ? <span className="text-fg-subtle">{entry.issuer}</span> : null}
                <Badge tone={state.tone}>
                  {state.label} {formatDate(entry.expiresAt)}
                </Badge>
              </button>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {/*
        Where the team is one deep.
        Two different problems, worded as two: a skill one person can carry is a risk to plan
        around, and a skill nobody holds above learning is work the team cannot take on.
      */}
      {coverage && (coverage.oneDeep.length || coverage.noneDeep.length) ? (
        <Card>
          <CardHeader
            icon={ShieldCheck}
            title="Where the team is thin"
            description="Counted on strong and expert only — somebody learning a thing cannot be handed the job. This is the question a list of profiles could never answer."
          />
          <CardBody className="flex flex-col gap-3">
            {coverage.oneDeep.length ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                  Only one person could take it on
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {coverage.oneDeep.map((row) => (
                    <button
                      key={row.name}
                      type="button"
                      onClick={() => setSkillFilter(row.name === skillFilter ? '' : row.name)}
                      className="flex items-center gap-2 rounded-lg bg-med/[0.08] px-2 py-1 text-xs text-fg ring-1 ring-med/25 transition hover:bg-med/[0.14]"
                      title={
                        row.learners
                          ? `${row.learners} other(s) are learning it`
                          : 'Nobody else has recorded it at all'
                      }
                    >
                      {row.name}
                      <span className="text-fg-subtle">{row.person?.fullname ?? 'somebody'}</span>
                      {row.learners ? (
                        <span className="font-mono text-[0.625rem] text-fg-subtle">
                          +{row.learners} learning
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {coverage.noneDeep.length ? (
              <div className="flex flex-col gap-1.5 border-t border-line-soft pt-3">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                  Recorded, but nobody above working knowledge
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {coverage.noneDeep.map((row) => (
                    <button
                      key={row.name}
                      type="button"
                      onClick={() => setSkillFilter(row.name === skillFilter ? '' : row.name)}
                      className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1 text-xs text-fg-muted ring-1 ring-line-soft transition hover:text-fg"
                    >
                      {row.name}
                      <span className="font-mono text-[0.625rem] text-fg-subtle">{row.people}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* One row of controls above everything they scope. */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs options={VIEWS} value={view} onChange={setView} size="sm" />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search a person, skill or certification…"
          className="w-full sm:w-72"
        />
        <Select
          value={levelFilter}
          onChange={(event) => setLevelFilter(event.target.value)}
          wrapperClassName="w-auto"
          options={[
            { value: '', label: 'Any level' },
            { value: 'deep', label: 'Strong or expert only' },
          ]}
        />
        {view === 'people' || view === 'skills' ? (
          <Select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            wrapperClassName="w-auto"
            options={SORTS}
          />
        ) : null}
        {skillFilter ? (
          <Button variant="ghost" size="sm" onClick={() => setSkillFilter('')}>
            Clear “{skillFilter}”
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-fg-muted">
          {view === 'skills' || view === 'matrix'
            ? `${shownSkills.length} of ${skills.length} skill${skills.length === 1 ? '' : 's'}`
            : `${shown.length} of ${people.length} ${people.length === 1 ? 'person' : 'people'}`}
        </span>
      </div>

      {/* ------------------------------------------------------------- coverage */}
      {view === 'matrix' ? (
        shownSkills.length ? (
          <Card>
            <CardHeader
              icon={Grid3x3}
              title="Coverage"
              description="Skills down, people across. A thin row is a skill one absence would cost you; click any cell to hold that skill in the filter."
            />
            <CardBody>
              <SkillMatrix
                skills={shownSkills}
                people={shown}
                activeSkill={skillFilter}
                onPick={(name) => setSkillFilter(name === skillFilter ? '' : name)}
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon={Grid3x3}
              title="Nothing to plot"
              description="No skill matches the filters, so there is no grid to draw."
            />
          </Card>
        )
      ) : null}

      {/* --------------------------------------------------------------- skills */}
      {view === 'skills' ? (
        shownSkills.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {shownSkills.map((skill) => (
              <Card key={skill.name}>
                <CardBody className="flex flex-col gap-2.5">
                  <div className="flex items-start gap-3">
                    <span className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setSkillFilter(skill.name === skillFilter ? '' : skill.name)}
                        className={cn(
                          'truncate text-left text-sm font-semibold transition hover:text-brand-300',
                          skill.name === skillFilter ? 'text-brand-300' : 'text-fg'
                        )}
                      >
                        {skill.name}
                      </button>
                      <span className="mt-0.5 block text-[0.625rem] text-fg-subtle">
                        {skill.people} {skill.people === 1 ? 'person has' : 'people have'} it ·{' '}
                        {skill.depth} could take the work today
                      </span>
                    </span>
                    {skill.depth <= 1 ? (
                      <Badge
                        tone="warning"
                        icon={TriangleAlert}
                        title="Nobody, or only one person, could be handed this work"
                      >
                        {skill.depth === 0 ? 'no cover' : 'one deep'}
                      </Badge>
                    ) : null}
                  </div>

                  <DepthBar levels={skill.levels} total={skill.people} />

                  {/* Holders strongest first: this list is read to pick somebody. */}
                  <div className="flex flex-wrap gap-1.5">
                    {skill.holders.map((holder) => {
                      const person = people.find((entry) => entry.id === holder.id);
                      return (
                        <button
                          key={holder.id}
                          type="button"
                          onClick={() => person && setInspecting(person)}
                          className="flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-1.5 py-1 text-xs text-fg-muted ring-1 ring-line-soft transition hover:text-fg"
                          title={`${holder.fullname} — ${levelOf(holder.level).label}`}
                        >
                          {person ? <Avatar user={person} size={18} /> : null}
                          <span className="max-w-32 truncate">{holder.fullname}</span>
                          <SkillPips level={holder.level} />
                        </button>
                      );
                    })}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              icon={Wrench}
              title="No skill matches that"
              description="Try a different term, or clear the filters."
            />
          </Card>
        )
      ) : null}

      {/* ------------------------------------------------------ certifications */}
      {view === 'certifications' ? (
        <CertificationWall people={shown} onPick={setInspecting} />
      ) : null}

      {/* --------------------------------------------------------------- people */}
      {view === 'people' ? (
        shown.length === 0 ? (
          <Card>
            <EmptyState
              icon={GraduationCap}
              title={people.length ? 'Nobody matches that' : 'Nothing recorded yet'}
              description={
                people.length
                  ? 'Try a different term, or clear the filters.'
                  : 'Start with your own: what you would be given work for, and anything you hold that expires.'
              }
              actionLabel={people.length ? undefined : 'Edit yours'}
              actionIcon={Pencil}
              onAction={people.length ? undefined : () => setEditing({ id: me, name: 'you' })}
            />
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {shown.map((person) => {
              const deep = person.skills.filter((skill) => isDeep(skill.level));
              const attention = person.certifications.filter((entry) => {
                const state = expiryState(entry.expiresAt);
                return state.key === 'expired' || state.key === 'expiring';
              }).length;
              const levels = LEVELS.reduce(
                (acc, level) => ({
                  ...acc,
                  [level.value]: person.skills.filter((skill) => skill.level === level.value).length,
                }),
                {}
              );

              return (
                <Card
                  key={person.id}
                  className="group/person transition hover:border-line hover:shadow-pop"
                >
                  <CardBody className="flex flex-col gap-3">
                    <div className="flex items-start gap-3">
                      <Avatar user={person} size={34} className="mt-0.5" />
                      <button
                        type="button"
                        onClick={() => setInspecting(person)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-fg transition group-hover/person:text-brand-300">
                            {person.fullname}
                          </span>
                          {person.id === me ? <Badge tone="brand">you</Badge> : null}
                          {attention ? (
                            <Badge tone="warning" title="A certification of theirs needs renewing">
                              {attention} lapsing
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-fg-muted">
                          {person.headline || person.title || 'No headline yet'}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-3 text-[0.625rem] text-fg-subtle">
                          {person.yearsExperience !== null ? (
                            <span>
                              {person.yearsExperience} year
                              {person.yearsExperience === 1 ? '' : 's'}
                            </span>
                          ) : null}
                          {person.languages.length ? (
                            <span className="flex items-center gap-1">
                              <Languages size={11} />
                              {person.languages.join(', ')}
                            </span>
                          ) : null}
                          {person.certifications.length ? (
                            <span className="flex items-center gap-1">
                              <Award size={11} />
                              {person.certifications.length}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {mayEdit(person) ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Pencil}
                          title={person.id === me ? 'Edit yours' : `Edit ${person.fullname}`}
                          onClick={() => setEditing({ id: person.id, name: person.fullname })}
                        />
                      ) : null}
                    </div>

                    {person.skills.length ? (
                      <>
                        {/* The shape of somebody's record in one line: how much of it is
                            work they could be handed rather than work they are learning. */}
                        <span className="flex items-center gap-2">
                          <DepthBar levels={levels} total={person.skills.length} />
                          <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-fg-subtle">
                            {deep.length}/{person.skills.length}
                          </span>
                        </span>

                        <div className="flex flex-wrap gap-1.5">
                          {[...person.skills]
                            .sort(byStrength)
                            .slice(0, 8)
                            .map((skill) => (
                              <button
                                key={skill.name}
                                type="button"
                                onClick={() =>
                                  setSkillFilter(skill.name === skillFilter ? '' : skill.name)
                                }
                                className={cn(
                                  'flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition ring-1',
                                  skill.name.toLowerCase() === skillFilter.toLowerCase()
                                    ? 'bg-brand-500/15 text-brand-300 ring-brand-500/30'
                                    : 'bg-white/[0.03] text-fg ring-line-soft hover:ring-line'
                                )}
                              >
                                {skill.name}
                                <SkillPips level={skill.level} />
                              </button>
                            ))}
                          {person.skills.length > 8 ? (
                            <button
                              type="button"
                              onClick={() => setInspecting(person)}
                              className="rounded-lg px-2 py-1 text-xs text-fg-subtle transition hover:text-fg"
                            >
                              +{person.skills.length - 8} more
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <p className="text-[0.6875rem] text-fg-subtle">No skills recorded.</p>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )
      ) : null}

      {/* Languages, small and last: it decides who can run a workshop, not who can test. */}
      {coverage?.languages?.length && view === 'people' ? (
        <Card>
          <CardHeader
            icon={Languages}
            title="Languages the team speaks"
            description="Which decides who can run a workshop or a debrief with a client, rather than who can do the testing."
          />
          <CardBody className="flex flex-wrap gap-1.5">
            {coverage.languages.map((language) => (
              <button
                key={language.name}
                type="button"
                onClick={() => setSearch(language.name)}
                className="flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1 text-xs text-fg-muted ring-1 ring-line-soft transition hover:text-fg"
              >
                {language.name}
                <span className="font-mono text-[0.625rem] text-fg-subtle">{language.people}</span>
              </button>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {filtered && view === 'people' && shown.length ? (
        <p className="flex items-center gap-2 text-[0.6875rem] text-fg-subtle">
          <Sparkles size={12} />
          Filters scope every view — switch to Coverage to see the same people as a grid.
        </p>
      ) : null}

      <PersonProfile
        person={inspecting}
        skills={skills}
        open={Boolean(inspecting)}
        onClose={() => setInspecting(null)}
        canEdit={inspecting ? mayEdit(inspecting) : false}
        isMe={inspecting?.id === me}
        onEdit={() => {
          setEditing({ id: inspecting.id, name: inspecting.fullname });
          setInspecting(null);
        }}
      />

      <SkillsEditor
        open={Boolean(editing)}
        userId={editing?.id}
        name={editing?.name}
        onClose={() => setEditing(null)}
        onSaved={() => reload({ quiet: true })}
      />
    </div>
  );
}
