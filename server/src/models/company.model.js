import mongoose from 'mongoose';

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    shortName: { type: String, trim: true, default: '' },
    /** Data URI, embedded in reports when the template uses {{ .company.logo }}. */
    logo: { type: String, default: '' },
    address: { type: String, default: '' },
    website: { type: String, default: '' },

    /**
     * Presentation overrides for this client's reports.
     *
     * The instance settings are one date format, one finding prefix and one caption style for
     * every client you have — which is fine until a German client wants `dd.MM.yyyy` and an
     * ISO-only client wants what the standard says. An empty value means "use the instance
     * default", so a client with nothing set behaves exactly as before.
     */
    report: {
      dateFormat: { type: String, default: '' },
      findingIdPrefix: { type: String, default: '' },
      captionStyle: { type: String, default: '' },
      /** Deliberately not a colour palette: severity colours are the firm's, not the client's. */

      /**
       * What this client calls each severity in their own reports.
       *
       * Plenty of organisations run their own scale — P1 to P4, or Severe/Major/Minor — and
       * mapping CVSS onto it in a template is impossible, because the template language has no
       * comparison operator. Empty means the standard word, so a client who has never asked
       * reads exactly as before.
       *
       * Only the *report* changes. The app itself keeps one vocabulary, because a team that
       * says "high" to each other and reads "P2" on screen has to translate every time.
       */
      severityLabels: {
        critical: { type: String, default: '' },
        high: { type: String, default: '' },
        medium: { type: String, default: '' },
        low: { type: String, default: '' },
        none: { type: String, default: '' },
      },
    },

    /**
     * Who added it. Non-admins see a client through an engagement they are on — this
     * is what additionally keeps a client you have just created visible to you, in
     * the moment between adding them and creating their first engagement.
     */
    /**
     * What this client pays, and where the invoice goes.
     *
     * Separate from `report`, which is about what their documents look like. A client that
     * negotiated a rate two years ago should not have that rate retyped onto every proposal — and
     * `poRequired` exists because the commonest reason an invoice is refused is a missing purchase
     * order number, which is knowable months in advance and asked for by nobody.
     */
    billing: {
      /** This client's agreed day rate, overriding the standard one. Null means the standard. */
      dayRate: { type: Number, default: null, min: 0, max: 1_000_000 },
      /** Their tax registration, for the invoice and for a reverse-charge clause on the offer. */
      vat: { type: String, default: '', trim: true, maxlength: 80 },
      /** Whether they will refuse an invoice that does not quote a purchase order. */
      poRequired: { type: Boolean, default: false },
      invoiceEmail: { type: String, default: '', trim: true, lowercase: true, maxlength: 200 },
      invoiceAddress: { type: String, default: '', maxlength: 500 },
      /** Their own payment terms, if they are not the firm's. */
      paymentTermsDays: { type: Number, default: null, min: 0, max: 365 },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

export const Company = mongoose.model('Company', companySchema);
export default Company;
