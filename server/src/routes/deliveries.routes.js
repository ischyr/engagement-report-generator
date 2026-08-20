/**
 * The delivery register: every report that has left the building, across every engagement.
 *
 * Its own route file rather than another branch of `/audits/:id/...`, because the whole point is
 * that it is not about one engagement. Read-only — recording, correcting and removing a delivery
 * stay on the engagement that owns it, where the activity log is.
 */

import { Router } from 'express';

import asyncHandler from '../utils/async-handler.js';
import { deliveryRegister } from '../services/delivery-register.service.js';
import { Company } from '../models/company.model.js';
import { Audit } from '../models/audit.model.js';
import { visibleAuditFilter } from '../utils/audit-scope.js';

const router = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const truthy = (value) => value === '1' || value === 'true';

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(
      await deliveryRegister(req.user, {
        client: OBJECT_ID.test(req.query.client ?? '') ? req.query.client : undefined,
        audit: OBJECT_ID.test(req.query.audit ?? '') ? req.query.audit : undefined,
        q: req.query.q,
        hash: req.query.hash,
        from: DAY.test(req.query.from ?? '') ? req.query.from : undefined,
        to: DAY.test(req.query.to ?? '') ? req.query.to : undefined,
        latestOnly: truthy(req.query.latestOnly),
        unhashedOnly: truthy(req.query.unhashedOnly),
        before: req.query.before,
        limit: req.query.limit,
      })
    );
  })
);

/**
 * The clients that actually appear in the register, for the filter.
 *
 * Derived from the engagements this person can see rather than from the client list: offering a
 * filter for a client whose engagements are all invisible to you would produce an empty page and
 * leak that they exist.
 */
router.get(
  '/filters',
  asyncHandler(async (req, res) => {
    const audits = await Audit.find(visibleAuditFilter(req.user))
      .select('company')
      .lean();

    const ids = [...new Set(audits.map((row) => String(row.company ?? '')).filter(Boolean))];
    const clients = ids.length
      ? await Company.find({ _id: { $in: ids } })
          .select('name')
          .sort({ name: 1 })
      : [];

    res.json({ clients: clients.map((row) => ({ _id: row._id, name: row.name })) });
  })
);

export default router;
