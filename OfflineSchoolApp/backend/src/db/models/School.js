// backend/src/db/models/School.js
"use strict";

/**
 * School.js
 *
 * Mongoose model for a School document.
 *
 * Fixed issues:
 *  #M1  — No soft-delete field (deletedAt) — public.routes.js queries
 *          for it but the schema never defined it, so every document
 *          implicitly had deletedAt: undefined which the NOT_DELETED
 *          clause handled, but Mongoose would warn on unknown paths
 *  #M2  — No verified / isVerified field — select-school.js displays
 *          a "Verified" badge but the schema never persisted it
 *  #M3  — No indexes — name, email, isActive, deletedAt are all
 *          queried frequently; without indexes every query is a
 *          full collection scan
 *  #M4  — email uniqueness not enforced at the schema level —
 *          duplicate school emails could be inserted silently
 *  #M5  — code uniqueness not enforced — two schools could get the
 *          same enrollment-number prefix causing collisions
 *  #M6  — No sanitisation on free-text fields (name, address etc.) —
 *          leading/trailing whitespace stored in DB
 *  #M7  — settings sub-document had no validation on known values
 *          (e.g. currency was a free-text string, any garbage accepted)
 *  #M8  — No virtual for a clean public-safe representation — callers
 *          had to manually shape the object on every API response
 *  #M9  — applicationsOpen had no paired closedAt timestamp, making
 *          it impossible to know when applications were last closed
 *  #M10 — mongoose.model() called without checking for existing
 *          registration — causes "Cannot overwrite model" errors in
 *          test environments and hot-reload scenarios
 */

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ISO 4217 currency codes we actively support.
 * Extend as needed — validation is case-insensitive (see setter below).
 */
const SUPPORTED_CURRENCIES = [
  "USD", "EUR", "GBP", "NGN", "GHS", "KES", "ZAR",
  "UGX", "TZS", "RWF", "ETB", "XOF", "XAF", "MAD",
  "EGP", "INR", "CAD", "AUD", "SGD", "AED",
];

/**
 * IANA timezone identifiers we validate against.
 * We use a runtime check via Intl so we don't need a static list.
 */
const isValidTimezone = (tz) => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — SUB-SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIXED (#M7):
 * settings.currency is now validated against SUPPORTED_CURRENCIES.
 * settings.timezone is validated via Intl.DateTimeFormat at save time.
 * Both have sensible defaults and setters that normalise input.
 */
const settingsSchema = new mongoose.Schema(
  {
    academicYear: {
      type:    String,
      default: null,
      trim:    true,
      // e.g. "2024/2025" or "2024-2025"
      match:   [
        /^\d{4}[\/\-]\d{4}$|^$/,
        "academicYear must be in the format YYYY/YYYY or YYYY-YYYY",
      ],
    },

    currentTerm: {
      type:    String,
      default: null,
      trim:    true,
      enum:    {
        values:  [null, "", "First Term", "Second Term", "Third Term",
                  "Term 1", "Term 2", "Term 3",
                  "Semester 1", "Semester 2"],
        message: "currentTerm '{VALUE}' is not a recognised term label",
      },
    },

    /**
     * How chatty the gate is.
     *
     * "exceptions" by default, and that default is the whole point. A school of
     * 500 scanning twice a day generates 20,000 messages a month, and after the
     * first week "arrived 07:42" is noise a parent stops reading — which is
     * worse than silence, because the one message that mattered is now buried
     * in it. On a paid channel it is also the single largest line on the bill.
     *
     *   off        — record the scan, tell nobody
     *   exceptions — only a late arrival or an early departure
     *   all        — every scan, for a school that wants it and will pay for it
     */
    gateNotify: {
      type:    String,
      enum:    ["off", "exceptions", "all"],
      default: "exceptions",
    },

    /** After this, an arrival is late. 24-hour clock, school-local. */
    gateLateAfter: {
      type:    String,
      default: "07:45",
      match:   [/^([01]\d|2[0-3]):[0-5]\d$|^$/, "gateLateAfter must look like 07:45"],
    },

    /** Before this, a departure is early — a child leaving mid-day. */
    gateEarlyBefore: {
      type:    String,
      default: "14:00",
      match:   [/^([01]\d|2[0-3]):[0-5]\d$|^$/, "gateEarlyBefore must look like 14:00"],
    },

    /**
     * The expiry date printed on student ID cards, as YYYY-MM-DD.
     *
     * Left empty, cards expire at the end of the academic year the school is
     * currently in — which is the right default, because a card printed in
     * October and one printed the following May then carry the same date
     * instead of expiring seven months apart.
     *
     * A school sets this when its own calendar disagrees: cards that must last
     * until an exam session in September, or a term-by-term card. Changing it
     * only affects cards printed afterwards; the date is ink on a card already
     * in a child's pocket, not a value looked up at the gate. Nothing checks
     * this date when a card is scanned — it is there for the human reading the
     * card, and expiry is enforced by a student leaving the register.
     *
     * A plain date string rather than a Date: this is a calendar day with no
     * time in it, and storing it as a timestamp makes it land on the previous
     * day for anyone west of UTC.
     */
    idCardValidUntil: {
      type:    String,
      default: "",
      trim:    true,
      match:   [/^\d{4}-\d{2}-\d{2}$|^$/, "idCardValidUntil must look like 2026-08-31"],
    },

    /**
     * Who may message whom inside this school.
     *
     * Read through communication/policy.service.js resolveSettings(), which
     * supplies the defaults — so a school created before these existed
     * behaves identically to one that accepted the defaults.
     *
     * studentToStudent is ON by default — pupils talking to each other is
     * normal school life — but stays a switch so a school that would rather
     * keep peer messaging closed can turn it off without a code change.
     * adminAudit is on alongside it: peer messaging a school cannot review
     * is a safeguarding problem, and the two belong together.
     */
    communication: {
      studentToStudent:  { type: Boolean, default: true  },
      studentToAdmin:    { type: Boolean, default: true  },
      guardianToTeacher: { type: Boolean, default: true  },
      guardianToAdmin:   { type: Boolean, default: true  },
      /** Whether admins may read conversation bodies during an audit. */
      adminAudit:        { type: Boolean, default: true  },
    },

    /**
     * Per-school permission overrides, for the bursar and teacher roles.
     *
     * Read through permissions.service.js effectiveFor(), which supplies the
     * defaults from config/permissions.js — so a school created before this
     * existed behaves exactly like one that accepted every default, which is
     * the same contract settings.communication above has.
     *
     * Stored as two lists per role rather than one resolved list, and that
     * matters: a school that has granted the bursar gate.scan should keep
     * tracking every OTHER capability as the product changes. Storing the
     * resolved set would freeze the bursar as they were on the day somebody
     * opened this screen, and a permission added in a later release would
     * silently never reach them.
     *
     * Nothing here can widen a locked permission or reach super_admin,
     * school_admin or student — the service filters both, so a hand-edited
     * database row cannot grant results.edit to the fee desk.
     */
    permissions: {
      bursar: {
        granted: { type: [String], default: undefined },
        revoked: { type: [String], default: undefined },
      },
      teacher: {
        granted: { type: [String], default: undefined },
        revoked: { type: [String], default: undefined },
      },
    },

    /**
     * When a second signature is required.
     *
     * Each threshold is a whole XAF amount: an action at or above it has to be
     * approved by somebody who did not raise it. Null means never — which is
     * the default, and the only safe one. Turning approvals on for every school
     * at once would mean that on the morning after an upgrade no bursar could
     * record the day's cash expenses until a head teacher signed in, and a
     * safeguard that stops the school working gets switched off within a week.
     *
     * A threshold of 0 means "always", which is a real setting: a school that
     * wants every refund countersigned, however small, sets 0 rather than 1.
     *
     * Read through approvals.service.js resolveThresholds(), which supplies the
     * defaults — the same contract settings.communication and
     * settings.permissions already have.
     */
    approvals: {
      /** Expenses at or above this need approval before they count. */
      expenseThreshold: { type: Number, default: null, min: 0 },
      /** Refunds at or above this need approval before money goes back. */
      refundThreshold:  { type: Number, default: null, min: 0 },
      /** Fee waivers at or above this need approval before they reduce a bill. */
      waiverThreshold:  { type: Number, default: null, min: 0 },
      /**
       * Whether a payroll run needs a second signature between preparing it and
       * paying it. A switch rather than a threshold: the amount is whatever the
       * month costs, and a school either wants the step or does not.
       */
      payrollRequired:  { type: Boolean, default: false },
    },

    currency: {
      type:    String,
      default: "USD",
      // Normalise to uppercase before validation
      set:     (v) => (v ? String(v).toUpperCase().trim() : "USD"),
      enum:    {
        values:  SUPPORTED_CURRENCIES,
        message: `currency '{{VALUE}}' is not supported. ` +
                 `Supported: ${SUPPORTED_CURRENCIES.join(", ")}`,
      },
    },

    timezone: {
      type:      String,
      default:   "UTC",
      trim:      true,
      validate: {
        validator: (v) => !v || isValidTimezone(v),
        message:   "timezone '{VALUE}' is not a valid IANA timezone identifier",
      },
    },

    // Grading system — e.g. "percentage", "letter", "gpa"
    gradingSystem: {
      type:    String,
      default: "percentage",
      trim:    true,
      enum:    {
        values:  ["percentage", "letter", "gpa", "custom"],
        message: "gradingSystem '{VALUE}' is not recognised",
      },
    },
  },
  { _id: false }   // embedded — no separate _id needed
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — MAIN SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const schoolSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    name: {
      type:     String,
      required: [true, "School name is required"],
      trim:     true,
      minlength: [2,   "School name must be at least 2 characters"],
      maxlength: [200, "School name must not exceed 200 characters"],
    },

    /**
     * FIXED (#M5):
     * code is now sparse-unique — two schools cannot share a code, but
     * a school may have code: null (sparse allows multiple nulls).
     * Index defined below in SECTION 5.
     */
    code: {
      type:      String,
      default:   null,
      trim:      true,
      uppercase: true,
      maxlength: [10, "School code must not exceed 10 characters"],
      // Only allow alphanumeric + hyphens
      match: [
        /^[A-Z0-9\-]*$/,
        "code may only contain letters, numbers and hyphens",
      ],
      set: (v) => (v ? String(v).toUpperCase().trim() : null),
    },

    // ── Location ──────────────────────────────────────────────────────────────
    /**
     * FIXED (#M6):
     * All free-text fields now have trim: true so whitespace is
     * normalised before storage.
     */
    address: { type: String, default: null, trim: true },
    city:    { type: String, default: null, trim: true },
    state:   { type: String, default: null, trim: true },
    country: { type: String, default: null, trim: true },

    // ── Contact ───────────────────────────────────────────────────────────────
    phone: {
      type:  String,
      default: null,
      trim:  true,
    },

    /**
     * FIXED (#M4):
     * email is sparse-unique — two schools cannot share an email, but
     * multiple schools may have email: null.
     * Index defined below in SECTION 5.
     */
    email: {
      type:      String,
      default:   null,
      lowercase: true,
      trim:      true,
      match: [
        /^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "email must be a valid email address",
      ],
    },

    website: {
      type:    String,
      default: null,
      trim:    true,
      match: [
        /^$|^https?:\/\/.+/,
        "website must start with http:// or https://",
      ],
    },

    logo:  { type: String, default: null, trim: true },
    motto: { type: String, default: null, trim: true, maxlength: 300 },

    /**
     * Extended school profile — written by the settings screens (web, mobile,
     * desktop). Kept at the top level of the document rather than inside
     * `settings` because nothing reads them as operational settings: they are
     * printed on letters, report cards and the public profile.
     */
    postalCode:         { type: String,  default: null,  trim: true },

    /*
     * The delegations named in the official header.
     *
     * Every Cameroonian report card carries the ministry, the regional
     * delegation and the divisional delegation down its left and right margins,
     * in English and in French. They are the school's own administrative
     * placement, not something that can be derived: two schools in the same
     * city can sit under different sub-divisional delegations.
     *
     * Separate from `state` and `city`, which are a postal address. The header
     * falls back to them when these are blank — a card with "Regional
     * Delegation of ..." on it is worse than one naming the region the address
     * already gives — but a school that fills these in gets what it typed.
     */
    region:   { type: String, default: null, trim: true, maxlength: 120 },
    division: { type: String, default: null, trim: true, maxlength: 120 },

    schoolType:         { type: String,  default: "primary",
                          enum: ["primary", "jhs", "shs", "combined",
                                 "vocational", "university", "other"] },
    termSystem:         { type: String,  default: "trimester",
                          enum: ["trimester", "semester", "quarter"] },
    registrationNumber: { type: String,  default: null,  trim: true },
    foundedYear:        { type: Number,  default: null,  min: 1000, max: 2100 },
    principalName:      { type: String,  default: null,  trim: true },
    description:        { type: String,  default: null,  trim: true },
    academicYearStart:  { type: String,  default: null,  trim: true,
                          match: [/^\d{4}-\d{2}-\d{2}$|^$/,
                                  "academicYearStart must look like 2026-09-01"] },
    academicYearEnd:    { type: String,  default: null,  trim: true,
                          match: [/^\d{4}-\d{2}-\d{2}$|^$/,
                                  "academicYearEnd must look like 2027-06-30"] },
    schoolDays:         { type: [String], default: ["Monday", "Tuesday", "Wednesday",
                                                    "Thursday", "Friday"],
                          enum: ["Monday", "Tuesday", "Wednesday", "Thursday",
                                 "Friday", "Saturday", "Sunday"] },
    schoolStartTime:    { type: String,  default: "07:30", trim: true,
                          match: [/^([01]\d|2[0-3]):[0-5]\d$|^$/,
                                  "schoolStartTime must look like 07:30"] },
    schoolEndTime:      { type: String,  default: "15:30", trim: true,
                          match: [/^([01]\d|2[0-3]):[0-5]\d$|^$/,
                                  "schoolEndTime must look like 15:30"] },

    /**
     * The school's working language — the default for anyone who has not
     * chosen one, and the language a report card is printed in unless the
     * template says otherwise.
     *
     * Cameroon runs both an anglophone and a francophone subsystem, so this
     * is a property of the institution, not of the country.
     */
    defaultLanguage: {
      type:    String,
      enum:    ["en", "fr"],
      default: "en",
    },

    // ── Status flags ──────────────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
    },

    /**
     * FIXED (#M2):
     * verified / isVerified — the mobile app (select-school.js) displays
     * a "Verified" badge based on this field, but it was never in the
     * schema. Added as a single canonical field `verified` with a
     * backward-compat virtual `isVerified`.
     */
    verified: {
      type:    Boolean,
      default: false,
    },

    verifiedAt: {
      type:    Date,
      default: null,
    },

    verifiedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },

    // ── Applications ──────────────────────────────────────────────────────────
    applicationsOpen: {
      type:    Boolean,
      default: true,
    },

    /**
     * FIXED (#M9):
     * Tracks when applications were last closed so admins can see the
     * history and reports can filter by application window.
     */
    applicationClosedAt: {
      type:    Date,
      default: null,
    },

    applicationOpenedAt: {
      type:    Date,
      default: null,
    },

    // ── Soft delete ───────────────────────────────────────────────────────────
    /**
     * FIXED (#M1):
     * public.routes.js queries NOT_DELETED which checks for
     * deletedAt: null | false | "" | 0 | {$exists:false}.
     * Without this field in the schema Mongoose emits path warnings
     * and the field is never indexed.
     *
     * Coerce boolean false → null on set (fixes the data-corruption bug
     * that caused the original 500 errors).
     */
    deletedAt: {
      type:    Date,
      default: null,
      set:     (v) => {
        if (v === false || v === 0 || v === "") return null;
        return v;
      },
    },

    deletedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },

    // ── Settings ──────────────────────────────────────────────────────────────
    settings: {
      type:    settingsSchema,
      default: () => ({}),
    },

    // ── Contact person ────────────────────────────────────────────────────────
    contactPerson: {
      name:  { type: String, default: null, trim: true },
      email: { type: String, default: null, trim: true, lowercase: true },
      phone: { type: String, default: null, trim: true },
    },
  },
  {
    timestamps: true,                  // createdAt + updatedAt
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIXED (#M2):
 * Backward-compat alias so existing code that reads `isVerified` keeps
 * working without a migration.
 */
schoolSchema.virtual("isVerified").get(function () {
  return this.verified;
});

/**
 * FIXED (#M8):
 * publicProfile virtual returns a safe, shaped object for API responses.
 * Callers can do  school.publicProfile  instead of manually picking fields.
 */
schoolSchema.virtual("publicProfile").get(function () {
  return {
    id:               String(this._id),
    name:             this.name             || "",
    code:             this.code             || null,
    address:          this.address          || "",
    city:             this.city             || "",
    state:            this.state            || "",
    country:          this.country          || "",
    phone:            this.phone            || "",
    email:            this.email            || "",
    website:          this.website          || null,
    logo:             this.logo             || null,
    motto:            this.motto            || null,
    verified:         this.verified         ?? false,
    isVerified:       this.verified         ?? false,
    applicationsOpen: this.applicationsOpen ?? true,
    isActive:         this.isActive         ?? true,
    settings: {
      academicYear:  this.settings?.academicYear  || null,
      currentTerm:   this.settings?.currentTerm   || null,
      currency:      this.settings?.currency      || "USD",
      timezone:      this.settings?.timezone      || "UTC",
      gradingSystem: this.settings?.gradingSystem || "percentage",
    },
    createdAt: this.createdAt || null,
    updatedAt: this.updatedAt || null,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — INDEXES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIXED (#M3):
 * All frequently-queried paths are now indexed.
 *
 * FIXED (#M4 + #M5):
 * email and code use sparse unique indexes — allows multiple null values
 * while preventing two schools from sharing the same non-null value.
 */

// Fast lookup by name (search bar)
schoolSchema.index({ name: "text" });

// Filter active / non-deleted schools (the most common query pattern)
schoolSchema.index({ isActive: 1, deletedAt: 1 });

// Public school listing  (active + not deleted + applications open)
schoolSchema.index({ isActive: 1, deletedAt: 1, applicationsOpen: 1 });

// Verified badge queries
schoolSchema.index({ verified: 1, isActive: 1 });

// Sparse unique — allows null but prevents duplicate non-null values
schoolSchema.index(
  { email: 1 },
  { unique: true, sparse: true, name: "schools_email_unique" }
);

schoolSchema.index(
  { code: 1 },
  { unique: true, sparse: true, name: "schools_code_unique" }
);

// Soft-delete audit trail
schoolSchema.index({ deletedAt: 1 });
schoolSchema.index({ deletedBy: 1 });

// createdAt for chronological admin lists
schoolSchema.index({ createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — PRE-SAVE HOOKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-generate a school code from the name if one is not provided.
 * e.g. "Green Hill School" → "GHS"
 */
// Async, not callback-style: Mongoose 9 does not pass a next callback to
// document middleware, so `function (next)` left `next` undefined and every
// school save threw "next is not a function". See the note on the equivalent
// hook in Announcement.js.
schoolSchema.pre("save", async function () {
  // ── Auto-generate code ─────────────────────────────────────────────────────
  if (!this.code && this.name) {
    const initials = this.name
      .split(/\s+/)
      .filter((word) => /^[A-Za-z]/.test(word))   // skip numbers / symbols
      .map((word) => word[0].toUpperCase())
      .join("");

    this.code = initials.slice(0, 6) || null;
  }

  // ── Stamp applicationClosedAt / applicationOpenedAt ────────────────────────
  if (this.isModified("applicationsOpen")) {
    const ts = new Date();
    if (this.applicationsOpen) {
      this.applicationOpenedAt = ts;
    } else {
      this.applicationClosedAt = ts;
    }
  }

  // ── Stamp verifiedAt ───────────────────────────────────────────────────────
  if (this.isModified("verified") && this.verified && !this.verifiedAt) {
    this.verifiedAt = new Date();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — STATIC METHODS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Mongoose query clause that excludes soft-deleted schools.
 * Use this instead of duplicating the NOT_DELETED logic everywhere.
 *
 * @returns {object} Mongoose $or clause
 */
schoolSchema.statics.notDeletedClause = function () {
  return {
    $or: [
      { deletedAt: { $exists: false } },
      { deletedAt: null               },
      { deletedAt: ""                 },
      { deletedAt: 0                  },
      { deletedAt: false              },
    ],
  };
};

/**
 * Soft-deletes a school by setting deletedAt to now.
 * Never removes the document from the database.
 *
 * @param {string|ObjectId} schoolId
 * @param {string|ObjectId} [deletedByUserId]
 * @returns {Promise<object|null>}
 */
schoolSchema.statics.softDelete = async function (schoolId, deletedByUserId = null) {
  return this.findByIdAndUpdate(
    schoolId,
    {
      deletedAt: new Date(),
      deletedBy: deletedByUserId || null,
      isActive:  false,
    },
    { returnDocument: 'after' }
  );
};

/**
 * Restores a soft-deleted school.
 *
 * @param {string|ObjectId} schoolId
 * @returns {Promise<object|null>}
 */
schoolSchema.statics.restore = async function (schoolId) {
  return this.findByIdAndUpdate(
    schoolId,
    {
      deletedAt: null,
      deletedBy: null,
      isActive:  true,
    },
    { returnDocument: 'after' }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — INSTANCE METHODS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if this school has been soft-deleted.
 * @returns {boolean}
 */
schoolSchema.methods.isDeleted = function () {
  return Boolean(
    this.deletedAt &&
    this.deletedAt !== false &&
    this.deletedAt !== 0 &&
    this.deletedAt !== ""
  );
};

/**
 * Opens or closes the application window.
 * Saves the document and returns the updated instance.
 *
 * @param {boolean} open
 * @returns {Promise<this>}
 */
schoolSchema.methods.setApplicationsOpen = async function (open) {
  this.applicationsOpen = Boolean(open);
  return this.save();
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — MODEL REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIXED (#M10):
 * Calling mongoose.model("School", schema) a second time (e.g. during
 * Jest test runs or Next.js hot-reload) throws:
 *   "Cannot overwrite `School` model once compiled."
 *
 * Guard with mongoose.models.School check so the model is only compiled
 * once per process lifetime.
 */
const School = mongoose.models.School
  ? mongoose.model("School")
  : mongoose.model("School", schoolSchema);

module.exports = School;