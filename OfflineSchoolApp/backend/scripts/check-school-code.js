// backend/scripts/check-school-code.js
"use strict";

/**
 * A school code generated from the name is unique; a typed one is not altered.
 *
 * The code is the name's initials, and initials collide: "Government Bilingual
 * High School Bamenda" and "… Buea" are both GBHSB. With the unique index on
 * code (schools_code_unique_present) built, the second school could not be
 * created without someone typing a code. A generated code now takes the next
 * free number. In-memory MongoDB, with the real index.
 *
 *   node scripts/check-school-code.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  const School = require("../src/db/models/School");
  await School.createIndexes();

  const make = async (name, extra = {}) => {
    try { return (await School.create({ name, ...extra })).code; }
    catch (e) { return e.code === 11000 ? "E11000" : `error: ${e.message}`; }
  };

  check("schools whose names share initials: GBHSB, GBHSB2, GBHSB3 (Molyko is GBHSM)",
    [await make("Government Bilingual High School Molyko"),
     await make("Government Bilingual High School Bamenda"),
     await make("Government Bilingual High School Buea"),
     await make("Government Bilingual High School Bafut")],
    ["GBHSM", "GBHSB", "GBHSB2", "GBHSB3"]);

  check("a TYPED code that is taken is refused, not renumbered",
    await make("Some Other School", { code: "GBHSM" }), "E11000");
  check("  a typed free code is kept exactly", await make("Lycée de Bonamoussadi", { code: "LYBON" }), "LYBON");

  await School.updateOne({ code: "GBHSB2" }, { $set: { deletedAt: new Date(), isActive: false } });
  check("a deleted school's code stays reserved: the next one is GBHSB4",
    await make("Government Bilingual High School Bali"), "GBHSB4");

  check("names with no letters to take initials from: no code, and two such schools both fit",
    [await make("123 456"), await make("789")], [null, null]);

  const long = await make("Alpha Beta Gamma Delta Epsilon Zeta Eta");
  const long2 = await make("Alpha Beta Gamma Delta Epsilon Zeta Theta");
  check("six-letter initials take a number too and stay within 10 characters",
    [long, long2, long2.length <= 10], ["ABGDEZ", "ABGDEZ2", true]);

  const s = await School.findOne({ code: "GBHSB" });
  s.motto = "Knowledge and Service";
  await s.save();
  check("saving an existing school does not change its code", (await School.findById(s._id)).code, "GBHSB");

  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
