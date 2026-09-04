import mongoose from 'mongoose';

/**
 * Single-document collection holding app-wide preferences. `getSettings()`
 * creates it on first read so callers never deal with a missing doc.
 */
const settingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'settings', unique: true, immutable: true },

    /**
     * What the instance calls itself.
     *
     * A consultancy deploying this wants its own name above the sidebar, not the
     * name of the tool. Exposed through the public `/auth/status` endpoint rather
     * than the admin-only settings read, because the sign-in screen has to show it
     * before anybody is authenticated.
     */
    branding: {
      appName: { type: String, default: 'Engy Report', trim: true, maxlength: 60 },
      tagline: { type: String, default: 'Engagement Reporting', trim: true, maxlength: 80 },
      /** Data URI, shown in place of the monogram. Kept small — it loads every page. */
      logo: { type: String, default: '', maxlength: 400_000 },
    },
    /**
     * Who we are, legally.
     *
     * Distinct from `branding`, which is what the app calls itself on screen. An NDA needs a
     * party, and "Engy Report" is not one — a contract names a registered entity at an address.
     * Kept here rather than on each proposal because it is the same on every one of them, and
     * retyping it per document is how two contracts end up naming two different companies.
     */
    firm: {
      legalName: { type: String, default: '', trim: true, maxlength: 200 },
      address: { type: String, default: '', maxlength: 500 },
      registration: { type: String, default: '', trim: true, maxlength: 80 },
      vat: { type: String, default: '', trim: true, maxlength: 80 },
      email: { type: String, default: '', trim: true, maxlength: 200 },
      phone: { type: String, default: '', trim: true, maxlength: 60 },
      /** Who signs on our behalf, for the signature block. */
      signatoryName: { type: String, default: '', trim: true, maxlength: 160 },
      signatoryTitle: { type: String, default: '', trim: true, maxlength: 120 },
      /** Governing law and venue, which every one of these documents has a clause for. */
      jurisdiction: { type: String, default: '', trim: true, maxlength: 160 },
    },

    report: {
      enabled: { type: Boolean, default: true },
      public: {
        cvssColors: {
          noneColor: { type: String, default: '4A86E8' },
          lowColor: { type: String, default: '008000' },
          mediumColor: { type: String, default: 'F9A009' },
          highColor: { type: String, default: 'FE6C00' },
          criticalColor: { type: String, default: 'D02D2D' },
        },
        remediationColorsComplexity: {
          lowColor: { type: String, default: '008000' },
          mediumColor: { type: String, default: 'F9A009' },
          highColor: { type: String, default: 'FE6C00' },
        },
        remediationColorsPriority: {
          lowColor: { type: String, default: '008000' },
          mediumColor: { type: String, default: 'F9A009' },
          highColor: { type: String, default: 'FE6C00' },
          urgentColor: { type: String, default: 'D02D2D' },
        },
        captionStyle: { type: String, default: 'Caption' },
        /**
         * Whether captions are numbered, and what the number is called.
         *
         * "Figure 7 — The request", with the prose able to say "Figure 7" and mean it. On by
         * default: an unnumbered figure cannot be referred to, and a forty-page report with eleven
         * screenshots in it needs to refer to them. Off for a house whose template numbers them
         * some other way — the setting exists because turning this on changes what every existing
         * report looks like, and that should be somebody's decision rather than ours.
         */
        figureNumbering: { type: Boolean, default: true },
        /** The word in front of the number. "Figure", "Screenshot", "Fig.", or another language. */
        figureLabel: { type: String, default: 'Figure', trim: true, maxlength: 30 },
        /**
         * How code blocks are drawn: `terminal` a dark console pane, `light` a
         * pale box, `template` the document's own CodeBlock style if it has one.
         */
        codeBlockTheme: {
          type: String,
          enum: ['terminal', 'light', 'template'],
          default: 'terminal',
        },
        dateFormat: { type: String, default: 'yyyy-MM-dd' },
        /** Prefix used when auto-numbering findings, e.g. VULN-01. */
        findingIdPrefix: { type: String, default: '' },
        extendCvssTemporalEnvironment: { type: Boolean, default: false },
      },
      private: {
        imageBorder: { type: Boolean, default: false },
        imageBorderColor: { type: String, default: '000000' },
        /**
         * Whether the document asks Word to refresh its fields when it opens.
         *
         * On by default, because a table of contents is a field: without it the client's first
         * page reads "Right-click to update field". Off is for a firm that wants the numbering
         * frozen exactly as generated.
         */
        updateFieldsOnOpen: { type: Boolean, default: true },
      },
    },
    reviews: {
      enabled: { type: Boolean, default: false },
      public: {
        mandatoryReview: { type: Boolean, default: false },
        minReviewers: { type: Number, default: 1, min: 1 },
      },
      private: {
        removeApprovalsUponUpdate: { type: Boolean, default: false },
      },
    },
    /**
     * Time off, for the Schedule.
     *
     * One allowance for the whole firm rather than a contract per person: that is true of
     * most teams this is built for, and a per-person field nobody maintained would give a
     * balance that reads as authoritative and is not. Zero means "do not show a balance".
     */
    /**
     * The rate card, which is the smallest thing that makes a proposal have a price.
     *
     * Everything on the Sales dashboard used to apologise for counting proposals rather than money,
     * and the apology was honest: with no rate anywhere, a value on a proposal would have been a
     * number somebody typed rather than one the app could check. One standard day rate, a floor
     * below which a price needs a manager, and a discount cap — deliberately not a matrix of rates
     * per role and grade, because the work here is quoted in days by type and a matrix would be
     * three screens of admin for the same answer.
     *
     * `dayRate: null` means the rate card has not been filled in, which is different from a rate of
     * zero. Everything downstream treats it as "no price yet" rather than "free".
     */
    sales: {
      /** ISO 4217, used as a label rather than for conversion. There is one currency here. */
      currency: { type: String, default: 'EUR', trim: true, uppercase: true, maxlength: 3 },
      /** The standard day rate. A client can be given its own; a proposal can quote another. */
      dayRate: { type: Number, default: null, min: 0, max: 1_000_000 },
      /** Below this, after discount, the price needs signing off. Null switches the gate off. */
      floorDayRate: { type: Number, default: null, min: 0, max: 1_000_000 },
      /** Above this, the discount needs signing off. Zero means any discount does. */
      maxDiscountPercent: { type: Number, default: 0, min: 0, max: 100 },
      /** What tax is called here, and how much of it. Printed on the offer, never computed away. */
      taxLabel: { type: String, default: 'VAT', trim: true, maxlength: 20 },
      taxPercent: { type: Number, default: 0, min: 0, max: 100 },
      /** Days to pay, unless the client has its own terms. */
      paymentTermsDays: { type: Number, default: 30, min: 0, max: 365 },
    },

    /**
     * How this instance sends mail.
     *
     * Off until somebody fills it in, and everything that sends checks first — an instance with no
     * mail server carries on exactly as it did before, with notifications in the inbox only.
     *
     * The password is the one field here that is not ordinary configuration. It is stored under the
     * credential vault's key, in the same shape as a client credential, and it is stripped from
     * every read of this document. `SMTP_PASSWORD` in the environment overrides it, which is how a
     * container should be given a secret — then nothing sensitive is in the database at all.
     */
    email: {
      enabled: { type: Boolean, default: false },
      /** One of the presets in `mail/index.js`, or 'custom'. Only ever a hint for the form. */
      provider: { type: String, default: 'custom', trim: true, maxlength: 30 },
      host: { type: String, default: '', trim: true, maxlength: 200 },
      port: { type: Number, default: 587, min: 1, max: 65535 },
      /** 'tls' is 465 and direct, 'starttls' is 587 and an upgrade, 'none' is a trusted relay. */
      security: { type: String, enum: ['tls', 'starttls', 'none'], default: 'starttls' },
      username: { type: String, default: '', trim: true, maxlength: 200 },
      /** AES-256-GCM under VAULT_KEY, like a client credential. Never leaves the server. */
      secret: {
        iv: { type: String, default: '' },
        tag: { type: String, default: '' },
        data: { type: String, default: '' },
      },
      fromName: { type: String, default: '', trim: true, maxlength: 120 },
      fromAddress: { type: String, default: '', trim: true, maxlength: 200 },
      replyTo: { type: String, default: '', trim: true, maxlength: 200 },
      /** For a relay with a certificate from an internal CA this machine does not know. */
      allowInvalidCertificates: { type: Boolean, default: false },
      /** Only ever for a relay on this machine. Guarded again in the SMTP client. */
      allowPlaintextAuth: { type: Boolean, default: false },
      /** Whether inbox notifications also go out as mail, for people who opted in. */
      notifications: { type: Boolean, default: true },
    },

    /**
     * The optional assistant, configured exactly like the mail server above.
     *
     * Off until somebody fills it in, and everything that would use it checks first — an instance
     * with no assistant behaves precisely as it did before the feature existed, down to the buttons
     * not being drawn.
     *
     * The key is the one field here that is not ordinary configuration. It is stored under the
     * credential vault's key, in the same shape as an SMTP password, and stripped from every read
     * of this document. `ASSISTANT_API_KEY` in the environment overrides it, which is how a
     * container should be given a secret — then nothing sensitive is in the database at all.
     */
    assistant: {
      enabled: { type: Boolean, default: false },
      /** One of the presets in `assistant/index.js`, or 'custom'. Only ever a hint for the form. */
      provider: { type: String, default: 'anthropic', trim: true, maxlength: 30 },
      /**
       * Which shape the request takes: the Messages API, or chat-completions.
       *
       * Beside the endpoint rather than derived from it, because a base URL alone cannot say
       * which protocol answers there — and the whole point of the endpoint being configurable is
       * that a model running on this machine should work, which speaks the second shape.
       */
      wire: { type: String, enum: ['anthropic', 'openai'], default: 'anthropic' },
      /** Empty means the provider's own default. Any gateway or local runtime goes here. */
      endpoint: { type: String, default: '', trim: true, maxlength: 300 },
      model: { type: String, default: '', trim: true, maxlength: 120 },
      /** AES-256-GCM under VAULT_KEY, like an SMTP password. Never leaves the server. */
      secret: {
        iv: { type: String, default: '' },
        tag: { type: String, default: '' },
        data: { type: String, default: '' },
      },
      /** A model on somebody's own hardware can be slow, and being cut off at 30s is not helpful. */
      timeoutSeconds: { type: Number, default: 60, min: 5, max: 300 },
      /**
       * The team's own conventions, put in front of every prompt.
       *
       * "We write in the third person", "never say 'malicious actor'", "remediation is numbered
       * steps". Every report writing team has half a page of these and they are the difference
       * between a draft that saves time and one that has to be rewritten anyway.
       */
      houseStyle: { type: String, default: '', maxlength: 2000 },
      /**
       * Which of the four jobs are switched on. Absent reads as on, so a job added later is not
       * silently off on every instance that upgrades.
       */
      jobs: {
        summary: { type: Boolean, default: true },
        rewrite: { type: Boolean, default: true },
        enumeration: { type: Boolean, default: true },
        library: { type: Boolean, default: true },
      },
      /**
       * Whether a restricted engagement may be sent at all. Off, and separate from everything else.
       *
       * Marking an engagement restricted already means its material is handled more carefully than
       * the rest; posting its findings to a third party because a general setting happened to be on
       * would make that marking a lie.
       */
      allowRestricted: { type: Boolean, default: false },
    },

    leave: {
      allowanceDays: { type: Number, default: 25, min: 0, max: 365 },
      /** Whether somebody's own request needs approving, or simply lands on the calendar. */
      requireApproval: { type: Boolean, default: true },
    },
    danger: {
      enabled: { type: Boolean, default: false },
      public: {
        nbdaydelete: { type: Number, default: 15 },
        /**
         * The same window for engagements marked restricted, which is the material you least
         * want sitting in a trash nobody looks at. Clamped to the ordinary window at read time:
         * a setting that let restricted work outlive everything else would invert the point.
         */
        nbdaydeleteRestricted: { type: Number, default: 3 },
      },
    },
  },
  { timestamps: true }
);

settingsSchema.statics.getSettings = async function getSettings() {
  let doc = await this.findOne({ singleton: 'settings' });
  if (!doc) doc = await this.create({ singleton: 'settings' });
  return doc;
};

export const Settings = mongoose.model('Settings', settingsSchema);
export default Settings;
