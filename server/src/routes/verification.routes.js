import { Router } from 'express';

import asyncHandler from '../utils/async-handler.js';
import { verificationQueue } from '../services/verification.service.js';

const router = Router();

/**
 * What the client has said that nobody has dealt with, across every engagement.
 *
 * A read, and only a read. Everything the page does about a row it does through the route that
 * already owns that change — `PUT /audits/:id/findings/:findingId` for a verification, which is
 * what clears the claim and appends to the status history, and `PUT /audits/:id/questions/:qid`
 * for an answer. A second way to make either change is how the two would drift apart.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await verificationQueue(req.user));
  })
);

export default router;
