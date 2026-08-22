"use strict";

const router = require("express").Router();
const controller = require("../controllers/homework.controller");

router.get("/", controller.list);
router.post("/", controller.upsert);
router.put("/:id", (req, _res, next) => { req.body.id = req.params.id; next(); }, controller.upsert);
router.delete("/:id", controller.remove);
router.post("/:id/submissions", controller.submit);
router.patch("/:id/submissions/:submissionId/grade", controller.grade);

module.exports = router;
