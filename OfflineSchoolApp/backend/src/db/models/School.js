// backend/src/db/models/School.js
"use strict";

const mongoose = require("mongoose");

const schoolSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    code:    { type: String, trim: true, default: null  },

    address: { type: String, default: null },
    city:    { type: String, default: null },
    state:   { type: String, default: null },
    country: { type: String, default: null },

    phone:   { type: String, default: null },
    email:   { type: String, default: null, lowercase: true, trim: true },
    website: { type: String, default: null },
    logo:    { type: String, default: null },
    motto:   { type: String, default: null },

    applicationsOpen: { type: Boolean, default: true  },
    isActive:         { type: Boolean, default: true  },

    settings: {
      academicYear: { type: String, default: null  },
      currentTerm:  { type: String, default: null  },
      currency:     { type: String, default: "USD" },
      timezone:     { type: String, default: "UTC" },
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

module.exports = mongoose.model("School", schoolSchema);