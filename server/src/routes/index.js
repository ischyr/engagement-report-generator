import { Router } from 'express';

import { requireAuth, confineSales } from '../middleware/auth.js';
import authRoutes from './auth.routes.js';
import usersRoutes from './users.routes.js';
import auditsRoutes from './audits.routes.js';
import vulnerabilitiesRoutes from './vulnerabilities.routes.js';
import templatesRoutes from './templates.routes.js';
import dataRoutes from './data.routes.js';
import settingsRoutes from './settings.routes.js';
import salesRoutes from './sales.routes.js';
import proposalsRoutes from './proposals.routes.js';
import presenceRoutes from './presence.routes.js';
import notificationsRoutes from './notifications.routes.js';
import mediaRoutes from './media.routes.js';
import inboxRoutes from './inbox.routes.js';
import scheduleRoutes from './schedule.routes.js';
import leaveRoutes from './leave.routes.js';
import timeRoutes from './time.routes.js';
import insightsRoutes from './insights.routes.js';
import findingsRoutes from './findings.routes.js';
import checklistsRoutes from './checklists.routes.js';
import searchRoutes from './search.routes.js';
import snippetsRoutes from './snippets.routes.js';
import deliveriesRoutes from './deliveries.routes.js';
import rendersRoutes from './renders.routes.js';
import intakeRoutes from './intake.routes.js';
import { dashboardFor } from '../services/dashboard.service.js';
import { CVSS_METRICS, CVSS4_METRICS } from '../services/cvss.js';
import { buildInfo } from '../utils/build-info.js';
import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Template } from '../models/template.model.js';
import { User } from '../models/user.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import asyncHandler from '../utils/async-handler.js';

const router = Router();

/*
 * For an uptime monitor, and nothing else.
 *
 * Public, so it stays answerable when the database is down — and deliberately says nothing about
 * the build. An unauthenticated endpoint that names its own version is a gift to anybody deciding
 * which exploits to try, and this instance holds other people's vulnerabilities. The build is on
 * `/version`, behind the token.
 */
router.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), now: new Date().toISOString() });
});

router.use('/auth', authRoutes);

// Media authenticates itself: <img> tags cannot send an Authorization header, so
// the GET route accepts the path-scoped media cookie instead. Mounted before the
// blanket gate for that reason.
router.use('/media', mediaRoutes);

/*
 * Pre-engagement questionnaires. Mounted before the gate because the client filling one in has
 * no account — the routes under `/intake/public/:token` authenticate by the token alone, and
 * the file applies `requireAuth` itself to everything else.
 */
router.use('/intake', intakeRoutes);

// Everything past this point requires a valid access token.
router.use(requireAuth);

/*
 * And, for a sales account, is refused unless it belongs to the Sales section.
 *
 * Here rather than on each router below: one rule in one place, applied before anything
 * has a chance to read an engagement. `/auth` is mounted above this line, so account
 * management still works for every role.
 */
router.use(confineSales);

/**
 * Which build this is: version, commit, branch, Node, and when the process started.
 *
 * Behind the token on purpose — see `/health`. Cheap enough to be polled: everything but the
 * uptime is read once at import.
 */
router.get('/version', (_req, res) => res.json(buildInfo()));

/**
 * How far a fresh instance has got.
 *
 * Counts only — six `countDocuments` rather than the five list endpoints a page would otherwise
 * fetch to work the same thing out, which on an instance with real data means megabytes to
 * answer "is there at least one".
 *
 * Unscoped by membership on purpose: this says whether the *instance* is set up, not what the
 * caller can see. A new joiner on no engagements is not looking at an empty instance.
 */
router.get(
  '/setup',
  asyncHandler(async (_req, res) => {
    const [companies, templates, engagements, library, users, htmlTemplates] = await Promise.all([
      Company.estimatedDocumentCount(),
      Template.countDocuments({ kind: 'docx' }),
      Audit.countDocuments({ deletedAt: null }),
      Vulnerability.estimatedDocumentCount(),
      User.countDocuments({ enabled: true, approvedAt: { $ne: null } }),
      Template.countDocuments({ kind: 'html' }),
    ]);
    res.json({ companies, templates, htmlTemplates, engagements, library, users });
  })
);

// Both supported versions; a finding carries whichever its vector declares.
router.get('/cvss/metrics', (_req, res) => res.json({ '3.1': CVSS_METRICS, '4.0': CVSS4_METRICS }));

/**
 * Everything the front page shows, for the person asking.
 *
 * One call rather than the five the page would otherwise make, and scoped to the reader
 * throughout: the totals are of what *they* can see, and the work queues are theirs.
 */
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => res.json(await dashboardFor(req.user)))
);

router.use('/presence', presenceRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/inbox', inboxRoutes);
router.use('/schedule', scheduleRoutes);
router.use('/leave', leaveRoutes);
router.use('/time', timeRoutes);
router.use('/insights', insightsRoutes);
router.use('/findings', findingsRoutes);
router.use('/checklists', checklistsRoutes);
router.use('/search', searchRoutes);
router.use('/snippets', snippetsRoutes);
// The register: the delivery record read across every engagement rather than within one.
router.use('/deliveries', deliveriesRoutes);
/*
 * How a generated document came to be. Its own path rather than under an engagement because the
 * useful lookup is by the render id stamped inside a file, when nobody knows which engagement it
 * belongs to — that being the whole reason the id is in the file.
 */
router.use('/renders', rendersRoutes);
router.use('/users', usersRoutes);
router.use('/audits', auditsRoutes);
router.use('/vulnerabilities', vulnerabilitiesRoutes);
router.use('/templates', templatesRoutes);
router.use('/settings', settingsRoutes);
/* Last, and on its own: the only router here whose audience cannot see any of the rest. */
router.use('/sales', salesRoutes);
/*
 * Reached by both audiences, which is why it is not under `/sales`: the people who evaluate a
 * proposal cannot pass that router's role check, and giving them a second set of endpoints
 * would be a second set of rules about who may do what.
 */
router.use('/proposals', proposalsRoutes);
router.use('/data', dataRoutes);

export default router;
