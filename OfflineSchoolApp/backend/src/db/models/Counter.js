// backend/src/db/models/Counter.js
"use strict";

const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema({
  _id:      { type: String, required: true },
  seq:      { type: Number, default: 0     },
  schoolId: { type: String, default: null  },
});

module.exports =
  mongoose.models.Counter ||
  mongoose.model("Counter", counterSchema);