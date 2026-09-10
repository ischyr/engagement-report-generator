/**
 * What a proposal costs, in one place.
 *
 * Every screen, every generated document and every total on the dashboard reads the price from here.
 * That is the whole design: the proposal stores a day rate and a discount, never a total, so there
 * is no second number to fall out of step with the days the work side agreed. Change the agreed
 * effort from nine days to ten and the price moves, because it always did — it just used to move in
 * somebody's spreadsheet.
 *
 * Three fallbacks, in order: what this proposal quotes, what this client pays, what the rate card
 * says. A firm that has not filled the rate card in gets `priced: false` and every figure null,
 * which is the honest answer and the one the UI is built to show.
 */

/** Rounded to cents, then back to a number. Money in floats is fine at this scale; drift is not. */
const money = (value) => Math.round(value * 100) / 100;

/**
 * The price of one proposal.
 *
 * @param {object} proposal a Proposal document (needs `pricing`, `estimate`)
 * @param {object} [company] its client, populated or not — `billing.dayRate` is read if present
 * @param {object} [settings] the Settings document, for the rate card
 */
export function priceOf(proposal, company = null, settings = null) {
  const card = settings?.sales ?? {};
  const clientBilling = company?.billing ?? {};

  const currency = card.currency || 'EUR';
  const standardRate = Number.isFinite(card.dayRate) ? card.dayRate : null;
  const clientRate = Number.isFinite(clientBilling.dayRate) ? clientBilling.dayRate : null;
  const quoted = Number.isFinite(proposal?.pricing?.dayRate) ? proposal.pricing.dayRate : null;

  /** Which of the three is in force, and where it came from — the UI says which, so it must know. */
  const dayRate = quoted ?? clientRate ?? standardRate;
  const rateFrom = quoted !== null ? 'proposal' : clientRate !== null ? 'client' : 'card';

  const days = typeof proposal?.effortDays === 'function' ? proposal.effortDays() : null;
  const discountPercent = Number(proposal?.pricing?.discountPercent ?? 0) || 0;

  const floorDayRate = Number.isFinite(card.floorDayRate) ? card.floorDayRate : null;
  const maxDiscountPercent = Number.isFinite(card.maxDiscountPercent) ? card.maxDiscountPercent : null;

  /*
   * The gates, which are about the *effective* rate rather than the headline one.
   *
   * A 1,200 rate discounted 40% is 720, and if the floor is 900 that is the deal a manager has to
   * see — whereas checking the headline rate against the floor would have waved it through. Both
   * gates are evaluated even when the proposal is not priced, so a UI can explain what is missing.
   */
  const effectiveRate = dayRate === null ? null : money(dayRate * (1 - discountPercent / 100));
  const belowFloor = effectiveRate !== null && floorDayRate !== null && effectiveRate < floorDayRate;
  const overDiscount = maxDiscountPercent !== null && discountPercent > maxDiscountPercent;
  const needsApproval = Boolean(belowFloor || overDiscount);

  const approval = proposal?.pricing?.approval ?? {};
  /*
   * An approval is for a *price*, not for a proposal.
   *
   * Getting 20% signed off and then typing 45% must not keep the signature. The figures the manager
   * saw are stored with it, so a later change makes the approval stale rather than silently valid —
   * and stale is treated exactly like never-approved by the gate below.
   */
  const approvalStale =
    approval.state === 'approved' &&
    (Number(approval.forRate ?? NaN) !== Number(dayRate ?? NaN) ||
      Number(approval.forDiscount ?? NaN) !== Number(discountPercent));

  const priced = dayRate !== null && dayRate > 0 && days !== null && days > 0;

  const gross = priced ? money(dayRate * days) : null;
  const discount = priced ? money(gross * (discountPercent / 100)) : null;
  const net = priced ? money(gross - discount) : null;

  const taxPercent = Number(card.taxPercent ?? 0) || 0;
  const tax = priced ? money(net * (taxPercent / 100)) : null;
  const total = priced ? money(net + tax) : null;

  const paymentTermsDays = Number.isFinite(clientBilling.paymentTermsDays)
    ? clientBilling.paymentTermsDays
    : (card.paymentTermsDays ?? null);

  return {
    /** Whether there is a real figure here, or the rate card has simply not been filled in. */
    priced,
    currency,
    days,
    dayRate,
    rateFrom,
    standardRate,
    clientRate,
    discountPercent,
    effectiveRate,
    gross,
    discount,
    net,
    taxLabel: card.taxLabel || 'VAT',
    taxPercent,
    tax,
    total,
    paymentTermsDays,
    /* The gate, and everything a page needs to explain it without repeating the rules. */
    floorDayRate,
    maxDiscountPercent,
    belowFloor,
    overDiscount,
    needsApproval,
    approvalState: needsApproval ? (approvalStale ? 'pending' : approval.state || 'pending') : 'not-needed',
    approvalStale,
    /** True while the price is not cleared to go out. Read by the transition gate. */
    approvalOutstanding: needsApproval && (approvalStale || approval.state !== 'approved'),
    approvedBy: approval.by ?? null,
    approvedAt: approval.at ?? null,
    approvalNote: approval.note ?? '',
  };
}

/**
 * The sentence explaining why a price cannot go out yet, or null.
 *
 * Written here rather than in the transition table so that the page, the route and the offer
 * generator all say the same thing — a gate whose reason is phrased differently in three places
 * reads as three different rules.
 */
export function priceProblem(price) {
  if (!price?.approvalOutstanding) return null;
  if (price.approvalState === 'rejected') {
    return 'The price was rejected. Change it, or ask again with a reason.';
  }
  if (price.approvalStale) {
    return 'The price changed after it was approved, so it needs signing off again.';
  }
  const reasons = [];
  if (price.belowFloor) {
    reasons.push(
      `${price.effectiveRate} ${price.currency} a day is below the floor of ${price.floorDayRate}`
    );
  }
  if (price.overDiscount) {
    reasons.push(
      `a ${price.discountPercent}% discount is over the ${price.maxDiscountPercent}% a salesperson can give`
    );
  }
  return `The price needs a manager’s sign-off — ${reasons.join(', and ')}.`;
}

/** Money as somebody would read it. Used by the offer data and the CSV, so both agree. */
export function formatMoney(amount, currency = 'EUR') {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '';
  const fixed = Number(amount).toFixed(2);
  /* Thousands separated with a space: it reads in every locale this is likely to be used in. */
  const [whole, cents] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped}.${cents} ${currency}`.trim();
}

export default priceOf;
