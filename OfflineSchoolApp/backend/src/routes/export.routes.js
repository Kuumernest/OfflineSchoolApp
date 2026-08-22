// backend/src/routes/export.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { authorize } = require("../../middleware/auth");
const { kindsFor, buildExport } = require("../export/exports");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

// Teachers reach only the student roster; every other export checks its own
// roles inside buildExport, so a teacher asking for payroll gets 403 rather
// than an empty file that looks like the school has no staff.
router.use(authorize("admin", "school_admin", "super_admin", "teacher"));

/** What THIS user may export — the client builds its menu from this. */
router.get("/", asyncHandler(async (req, res) => {
  return res.json({ success: true, data: kindsFor(req.user?.role) });
}));

/**
 * GET /api/exports/:kind?lang=&from=&to=&classId=&academicYear=&periodMonth=
 *
 * Answers with the .xlsx itself. Content-Disposition carries the filename so a
 * browser download and a phone's share sheet both name the file the same way.
 */
router.get("/:kind", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) {
    return res.status(400).json({
      success: false, code: "BAD_REQUEST", message: "schoolId is required",
    });
  }

  try {
    const { buffer, fileName, rowCount } = await buildExport({
      kind:     req.params.kind,
      schoolId,
      query:    req.query,
      lang:     req.query.lang,
      role:     req.user?.role,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", buffer.length);
    // The row count rides in a header so a client can say "142 rows exported"
    // without opening the file it just received.
    res.setHeader("X-Export-Rows", String(rowCount));
    // Exposed explicitly: a cross-origin fetch cannot read either header
    // otherwise, and the browser download would fall back to a random name.
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, X-Export-Rows"
    );

    return res.send(buffer);
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false,
      code:    err.code ?? "EXPORT_FAILED",
      message: err.message,
    });
  }
}));

module.exports = router;
