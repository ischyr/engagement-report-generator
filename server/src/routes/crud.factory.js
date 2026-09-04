import { Router } from 'express';
import asyncHandler from '../utils/async-handler.js';
import { notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireWrite, requireRole } from '../middleware/auth.js';

/**
 * Builds a conventional CRUD router for a Mongoose model. Every simple
 * reference collection (companies, clients, languages, …) uses this so the
 * behaviour — sorting, population, role checks — stays identical across them.
 *
 * @param {object} options
 * @param {import('mongoose').Model} options.model
 * @param {import('zod').ZodTypeAny} options.createSchema
 * @param {import('zod').ZodTypeAny} [options.updateSchema] defaults to a partial create schema
 * @param {string|object} [options.sort]
 * @param {string|Array} [options.populate]
 * @param {string[]} [options.adminOnly] verbs restricted to admins: 'create'|'update'|'delete'
 * @param {(req)=>object|Promise<object>} [options.scopeQuery] extra filter applied to
 *   every verb. May be async — client visibility has to query engagements to work out
 *   which companies the caller is involved with.
 * @param {string} [options.ownerField] stamped with the caller's id on create, so a
 *   record stays visible to whoever added it before it is referenced elsewhere.
 */
export function crudRouter(options) {
  const {
    model,
    createSchema,
    updateSchema = createSchema.partial ? createSchema.partial() : createSchema,
    sort = { createdAt: -1 },
    populate = null,
    adminOnly = [],
    scopeQuery = null,
    ownerField = null,
    /**
     * Asked before a delete goes through, and free to throw.
     *
     * Exists because two of these collections — companies and contacts — are also reachable from
     * the Sales section, which refuses to delete one that anything still points at. Without a
     * hook here the two doors would disagree, and this one was the looser: a bare
     * `findOneAndDelete` that left engagements pointing at a client which no longer existed.
     */
    beforeDelete = null,
  } = options;

  const router = Router();
  const guard = (verb) => (adminOnly.includes(verb) ? [requireRole('admin')] : [requireWrite]);

  const withPopulate = (query) => (populate ? query.populate(populate) : query);

  /** The caller's visibility filter, awaited because it may need a query of its own. */
  const scope = async (req) => (scopeQuery ? await scopeQuery(req) : {});

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const docs = await withPopulate(model.find(await scope(req)).sort(sort));
      res.json(docs);
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const filter = { _id: req.params.id, ...(await scope(req)) };
      const doc = await withPopulate(model.findOne(filter));
      if (!doc) throw notFound(`${model.modelName} not found`);
      res.json(doc);
    })
  );

  router.post(
    '/',
    ...guard('create'),
    validate(createSchema),
    asyncHandler(async (req, res) => {
      const payload = ownerField ? { ...req.body, [ownerField]: req.user._id } : req.body;
      const created = await model.create(payload);
      const doc = await withPopulate(model.findById(created._id));
      res.status(201).json(doc);
    })
  );

  /*
   * Writes are scoped too, not just reads. Otherwise a caller who cannot see a record
   * could still edit or delete it by guessing its id — the list being filtered would
   * be the only thing standing in the way, which is not a control.
   */
  router.put(
    '/:id',
    ...guard('update'),
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const filter = { _id: req.params.id, ...(await scope(req)) };
      const doc = await withPopulate(
        model.findOneAndUpdate(filter, req.body, { new: true, runValidators: true })
      );
      if (!doc) throw notFound(`${model.modelName} not found`);
      res.json(doc);
    })
  );

  router.delete(
    '/:id',
    ...guard('delete'),
    asyncHandler(async (req, res) => {
      const filter = { _id: req.params.id, ...(await scope(req)) };
      // Found first, so the hook can be asked about something that exists and the caller gets a
      // 404 for a wrong id rather than a confusing "nothing refers to this".
      const existing = await model.findOne(filter);
      if (!existing) throw notFound(`${model.modelName} not found`);
      if (beforeDelete) await beforeDelete(existing, req);

      await existing.deleteOne();
      res.json({ ok: true, id: req.params.id });
    })
  );

  return router;
}

export default crudRouter;
