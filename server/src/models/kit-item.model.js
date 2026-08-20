import mongoose from 'mongoose';

/**
 * A thing this engagement needs, and where it has got to.
 *
 * The drop box, the loaner laptop, the 4G SIM, the site badge, the Wi-Fi adapter that only one
 * person owns. Every firm tracks these in somebody's head or a spreadsheet, and the failure is
 * always one of two: turning up on site without the thing, or finishing the job and never getting
 * it back.
 *
 * Recorded per engagement, because that is how the list is written — "what do we need for
 * Northwind next week" — rather than as a central inventory somebody has to maintain before it is
 * useful. `assetTag` is the bridge: give a real item a tag and the app can answer "which
 * engagement has DB-02 right now" by looking across engagements, which is the inventory question
 * without the inventory.
 */

const DAY = /^(\d{4}-\d{2}-\d{2})?$/;

export const KIT_KINDS = ['hardware', 'connectivity', 'access', 'consumable', 'other'];

export const KIT_KIND_LABELS = {
  hardware: 'Hardware',
  connectivity: 'Connectivity',
  access: 'Access',
  consumable: 'Consumable',
  other: 'Other',
};

/**
 * Where the item has got to.
 *
 * A single ordered life rather than separate flags, because unlike a check being blocked these
 * genuinely are one question with one answer: a laptop cannot be both packed and returned.
 *
 * `missing` is the reason this exists. Everything else is admin; a thing that never came back is
 * the fact somebody needs to see.
 */
export const KIT_STATUSES = ['needed', 'requested', 'ready', 'out', 'returned', 'missing'];

export const KIT_STATUS_LABELS = {
  needed: 'Needed',
  requested: 'Asked for',
  ready: 'Ready to go',
  out: 'Out with us',
  returned: 'Back',
  missing: 'Not come back',
};

/** Still ours to worry about — the states where the item is somewhere other than on the shelf. */
export const KIT_OPEN_STATUSES = ['needed', 'requested', 'ready', 'out', 'missing'];

const kitItemSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },

    /** What it is, in the words the team uses. */
    label: { type: String, required: true, trim: true, maxlength: 160 },
    kind: { type: String, enum: KIT_KINDS, default: 'hardware' },
    /**
     * The firm's own label for a specific item — "DB-02", a serial, an asset sticker.
     *
     * Optional, and the only thing that makes two engagements' rows refer to the same physical
     * object. Where it is set, the app can say "this is already out on another engagement", which
     * is the double-booking that leaves somebody on site without a box.
     */
    assetTag: { type: String, default: '', trim: true, maxlength: 60 },

    status: { type: String, enum: KIT_STATUSES, default: 'needed' },
    /** Consumables come in numbers; everything else is one thing. */
    quantity: { type: Number, default: 1, min: 1, max: 999 },

    /** Whoever has it. The answer to "who has the box", which is usually the whole question. */
    heldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /** Days, like every other day in this app. */
    neededBy: { type: String, default: '', match: DAY },
    dueBack: { type: String, default: '', match: DAY },

    note: { type: String, default: '', trim: true, maxlength: 500 },

    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

kitItemSchema.index({ audit: 1, createdAt: 1 });
/** Answering "where is DB-02" reads by tag across engagements, so it is worth an index. */
kitItemSchema.index({ assetTag: 1, status: 1 });

/** Out, and past the day it should have come back. */
export const isOverdue = (item, today) =>
  Boolean(item.dueBack) && item.dueBack < today && item.status !== 'returned';

export const KitItem = mongoose.model('KitItem', kitItemSchema);
export default KitItem;
