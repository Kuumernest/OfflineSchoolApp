// backend/routes/sync.routes.js
"use strict";

const express    = require("express");
const router     = express.Router();
const syncCtrl   = require("../controllers/sync.controller");
const { authenticate } = require("../../middleware/auth");

router.get( "/pull", authenticate, syncCtrl.pullChanges);
router.post("/push", authenticate, syncCtrl.pushChanges);

module.exports = router;