/**
 * The data a proposal template renders against.
 *
 * Deliberately shaped like the report's data rather than like the proposal document, because
 * whoever writes these templates has already learned one vocabulary: `{{ company.name }}`
 * means the client here exactly as it does in a report, `{{ firm.legalName }}` means us,
 * dates go through the same `date` filter, and rich text goes through `{{@rich.* }}`. A
 * second set of conventions for the same firm's paperwork would be a second thing to look up.
 *
 * Synchronous, for the same reason `buildReportData` is: docxtemplater renders synchronously,
 * so anything that needs a query is done by the caller and passed in.
 */

import { formatDate } from './template-parser.js';
import { htmlToOoxml } from './ooxml/html2ooxml.js';
import { PROPOSAL_STATUS_LABELS } from '../models/proposal.model.js';
import { PROPOSAL_DOC_LABELS } from '../models/template.model.js';
import { priceOf, formatMoney } from './pricing.service.js';

const dayOrEmpty = (day, format) => (day ? formatDate(day, format) : '');

const personSummary = (person) =>
  person
    ? {
        email: person.email ?? '',
        firstname: person.firstname ?? '',
        lastname: person.lastname ?? '',
        fullname: [person.firstname, person.lastname].filter(Boolean).join(' ') || person.email || '',
        phone: person.phone ?? '',
        cell: person.cell ?? '',
        title: person.title ?? '',
      }
    : { email: '', firstname: '', lastname: '', fullname: '', phone: '', cell: '', title: '' };

/**
 * Days as a phrase as well as a number.
 *
 * Both, because a template sentence reads "an estimated 8 days" and a table column reads "8",
 * and asking a template language with no arithmetic to pluralise is asking for "1 days".
 */
function effortBlock(proposal) {
  const agreed = proposal.estimate?.days ?? null;
  const sales = proposal.estimate?.salesDays ?? null;
  const days = agreed ?? sales;
  return {
    days: days ?? '',
    daysLabel: days === null || days === undefined ? '' : `${days} day${days === 1 ? '' : 's'}`,
    /** What sales first thought, and what was agreed — see the model on why both are kept. */
    salesDays: sales ?? '',
    agreedDays: agreed ?? '',
    /**
     * Whether anybody who would do the work has confirmed it. A template that quotes a figure
     * nobody has checked should be able to say so, or to leave the sentence out.
     */
    agreed: agreed !== null && agreed !== undefined,
    revised: agreed !== null && sales !== null && agreed !== sales,
    note: proposal.estimate?.note ?? '',
  };
}

/**
 * @param {object} proposal        a populated Proposal (company, contacts, owner)
 * @param {object} settings        the Settings document, for the firm block and date format
 * @param {object} ooxmlOptions    from `ooxmlOptionsFor`, for the rich-text tags
 * @param {object} [options]       `{ user, templateName, docType }`
 */
export function buildProposalData(proposal, settings, ooxmlOptions, options = {}) {
  const pub = settings?.report?.public ?? {};
  const dateFormat = pub.dateFormat ?? 'yyyy-MM-dd';
  const firm = settings?.firm ?? {};
  const company = proposal.company ?? null;
  const contacts = (proposal.contacts ?? []).map(personSummary);

  const rich = (html) => (html ? htmlToOoxml(String(html), ooxmlOptions) : '<w:p/>');
  /* Once, not once per tag that mentions it: `priceOf` reads the rate card and the client's rate. */
  const price = priceOf(proposal, proposal.company, settings);
  const moneyText = (amount) => formatMoney(amount, price.currency);

  return {
    /* ------------------------------------------------------------- the proposal */
    reference: proposal.reference ?? '',
    title: proposal.title ?? '',
    /** Also as `name`, because half the report templates say `{{ name }}` for the same idea. */
    name: proposal.title ?? '',
    auditType: proposal.auditType ?? '',
    engagementType: proposal.auditType ?? '',
    status: proposal.status ?? '',
    statusLabel: PROPOSAL_STATUS_LABELS[proposal.status] ?? '',
    /** Which document this render is, for a template that serves more than one purpose. */
    docType: options.docType ?? '',
    docTypeLabel: PROPOSAL_DOC_LABELS[options.docType] ?? '',

    summary: proposal.summary ?? '',
    constraints: proposal.constraints ?? '',
    /** The same two as OOXML, for a template that wants formatting rather than a line of text. */
    'rich.summary': rich(proposal.summary),
    'rich.constraints': rich(proposal.constraints),
    'rich.evaluationNotes': rich(proposal.evaluation?.notes),

    /* ------------------------------------------------------------------- dates */
    requestedOn: dayOrEmpty(proposal.requestedOn, dateFormat),
    expectedStart: dayOrEmpty(proposal.expectedStart, dateFormat),
    expectedEnd: dayOrEmpty(proposal.expectedEnd, dateFormat),
    validUntil: dayOrEmpty(proposal.validUntil, dateFormat),
    // Raw ISO-ish values, so a template can impose its own format with the `date` filter.
    requestedOnRaw: proposal.requestedOn ?? '',
    expectedStartRaw: proposal.expectedStart ?? '',
    expectedEndRaw: proposal.expectedEnd ?? '',
    validUntilRaw: proposal.validUntil ?? '',
    dateRange:
      proposal.expectedStart && proposal.expectedEnd
        ? `${dayOrEmpty(proposal.expectedStart, dateFormat)} – ${dayOrEmpty(proposal.expectedEnd, dateFormat)}`
        : dayOrEmpty(proposal.expectedStart, dateFormat) ||
          dayOrEmpty(proposal.expectedEnd, dateFormat) ||
          '',

    /* ---------------------------------------------------------------- retainer */
    /*
     * Only meaningful when several engagements were sold as one agreement. Written as a sentence as
     * well as as numbers, because that is what an offer prints: a template author should not have to
     * assemble "four engagements, one every three months" out of two integers and a conditional.
     */
    retainer: {
      engagements: proposal.retainer?.engagements || '',
      everyMonths: proposal.retainer?.everyMonths || '',
      /** "four engagements, one every 3 months" — empty for an ordinary one-off. */
      summary:
        proposal.retainer?.engagements > 1 && proposal.retainer?.everyMonths
          ? `${proposal.retainer.engagements} engagements, one every ${proposal.retainer.everyMonths} month${
              proposal.retainer.everyMonths === 1 ? '' : 's'
            }`
          : '',
    },
    isRetainer: Boolean(proposal.retainer?.engagements > 1 && proposal.retainer?.everyMonths),

    now: formatDate(new Date(), dateFormat),
    generatedAt: formatDate(new Date(), dateFormat),
    generatedAtRaw: new Date().toISOString(),
    generatedBy:
      [options.user?.firstname, options.user?.lastname].filter(Boolean).join(' ') ||
      options.user?.username ||
      '',
    templateName: options.templateName ?? '',
    year: new Date().getFullYear(),

    /* ----------------------------------------------------------------- parties */
    /**
     * Us. A contract needs a legal entity at an address, which is why this is its own block
     * in Settings and not the app's display name.
     */
    firm: {
      legalName: firm.legalName ?? '',
      address: firm.address ?? '',
      registration: firm.registration ?? '',
      vat: firm.vat ?? '',
      email: firm.email ?? '',
      phone: firm.phone ?? '',
      signatoryName: firm.signatoryName ?? '',
      signatoryTitle: firm.signatoryTitle ?? '',
      jurisdiction: firm.jurisdiction ?? '',
    },
    /** Them. Same key and same fields as a report, so one habit covers both. */
    company: company
      ? {
          name: company.name ?? '',
          shortName: company.shortName ?? '',
          logo: company.logo ?? '',
          address: company.address ?? '',
          website: company.website ?? '',
        }
      : { name: '', shortName: '', logo: '', address: '', website: '' },
    /** The primary contact, as `client`, matching the report's word for the same person. */
    client: personSummary(proposal.contacts?.[0]),
    contacts,
    hasContacts: contacts.length > 0,

    /** Whose deal it is, for a "your contact at us is" line. */
    owner: {
      fullname:
        [proposal.owner?.firstname, proposal.owner?.lastname].filter(Boolean).join(' ') ||
        proposal.owner?.username ||
        '',
      email: proposal.owner?.email ?? '',
      phone: proposal.owner?.phone ?? '',
      title: proposal.owner?.title ?? '',
    },

    /* ----------------------------------------------------------------- effort */
    effort: effortBlock(proposal),

    /* -------------------------------------------------------------------- price */
    /*
     * The figure the offer is actually about.
     *
     * Every amount comes in two forms: a number for a template doing arithmetic or its own
     * formatting, and a `*Text` string already grouped and suffixed with the currency. The second
     * is what a document nearly always wants, and leaving it out meant every template author had to
     * reinvent thousands separators in a `{{ }}` tag, which cannot be done.
     *
     * `isPriced` is the guard: a firm with no rate card filled in should print an offer with no
     * price section rather than one that says "0.00 EUR", which reads as free work.
     */
    price: (() => {
      const text = moneyText;
      return {
        currency: price.currency,
        days: price.days ?? '',
        dayRate: price.dayRate ?? '',
        dayRateText: text(price.dayRate),
        discountPercent: price.discountPercent || '',
        discount: price.discount ?? '',
        discountText: text(price.discount),
        /** Before discount. Only worth printing when there is one. */
        gross: price.gross ?? '',
        grossText: text(price.gross),
        /** What they are being asked for, before tax. The headline figure on most offers. */
        net: price.net ?? '',
        netText: text(price.net),
        taxLabel: price.taxLabel,
        taxPercent: price.taxPercent || '',
        tax: price.tax ?? '',
        taxText: text(price.tax),
        total: price.total ?? '',
        totalText: text(price.total),
        paymentTermsDays: price.paymentTermsDays ?? '',
      };
    })(),
    isPriced: price.priced,
    isDiscounted: Boolean(price.discountPercent),

    /* ------------------------------------------------------------------ billing */
    /*
     * The client's side of the paperwork. `poNumber` on an offer looks odd until you have had an
     * invoice refused for the want of it: quoting it on the offer is how it ends up on the invoice.
     */
    billing: {
      poNumber: proposal.billing?.poNumber ?? '',
      /** Their tax registration, which a reverse-charge clause has to name. */
      clientVat: proposal.company?.billing?.vat ?? '',
      invoiceEmail: proposal.company?.billing?.invoiceEmail ?? '',
      invoiceAddress: proposal.company?.billing?.invoiceAddress ?? '',
    },

    /* ----------------------------------------------------------------- kickoff */
    /**
     * What the permission to attack is written from.
     *
     * `held` so a template can leave the whole section out rather than print a signature block
     * over an empty date — a document asserting a meeting that has not happened is worse than
     * one that does not mention it.
     */
    kickoff: {
      held: Boolean(proposal.kickoff?.heldOn),
      heldOn: dayOrEmpty(proposal.kickoff?.heldOn, dateFormat),
      heldOnRaw: proposal.kickoff?.heldOn ?? '',
      attendeesOurs: proposal.kickoff?.attendeesOurs ?? '',
      attendeesTheirs: proposal.kickoff?.attendeesTheirs ?? '',
      /** Who to ring while testing is under way. */
      emergencyContact: proposal.kickoff?.emergencyContact ?? '',
      notes: proposal.kickoff?.notes ?? '',
    },
    'rich.kickoffNotes': rich(proposal.kickoff?.notes),

    /* -------------------------------------------------------------- evaluation */
    evaluation: {
      notes: proposal.evaluation?.notes ?? '',
      verdict: proposal.evaluation?.verdict ?? '',
      at: proposal.evaluation?.at ? formatDate(proposal.evaluation.at, dateFormat) : '',
      by:
        [proposal.evaluation?.by?.firstname, proposal.evaluation?.by?.lastname]
          .filter(Boolean)
          .join(' ') || '',
    },
  };
}

export default buildProposalData;
