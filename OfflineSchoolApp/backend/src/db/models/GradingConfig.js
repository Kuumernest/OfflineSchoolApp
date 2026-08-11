// backend/src/db/models/GradingConfig.js
"use strict";

const mongoose = require("mongoose");

const gradeBandSchema = new mongoose.Schema(
  {
    grade:     { type: String, required: true },
    minMark:   { type: Number, required: true },
    maxMark:   { type: Number, required: true },
    gpaPoints: { type: Number, default: 0     },
    remark:    { type: String, default: ""    },
  },
  { _id: false }
);

const gradingConfigSchema = new mongoose.Schema(
  {
    schoolId:    { type: String, required: true, unique: true, index: true },
    grades:      { type: [gradeBandSchema], default: []         },
    passMark:    { type: Number,  default: 50                   },
    useGpa:      { type: Boolean, default: false                },
    gpaScale:    { type: Number,  default: 4.0                  },
    gradingType: {
      type:    String,
      enum:    ["percentage", "gpa", "points"],
      default: "percentage",
    },
    updatedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

module.exports = mongoose.model("GradingConfig", gradingConfigSchema);