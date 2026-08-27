// backend/src/routes/periods.routes.js
'use strict';

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/periods.controller');
const { authenticate } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');

router.use(authenticate);

// This router carried NO authorisation at all: mounted behind authenticate
// only, so any signed-in account — a student's included — could add, reorder
// or delete the school's periods and pull every timetable apart with it. The
// bursar audit is what surfaced it; the hole predates the bursar.
//
// Reading is teaching work (a timetable is unreadable without the periods it
// is built from); changing the shape of the school day is the office's.
const readPeriods  = requirePermission('periods.view');
const writePeriods = requirePermission('periods.manage');

router.get(    '/',            readPeriods,  controller.getAll);
router.get(    '/:id',         readPeriods,  controller.getById);
router.post(   '/',            writePeriods, controller.create);
router.put(    '/:id',         writePeriods, controller.update);
router.patch(  '/:id/toggle',  writePeriods, controller.toggleActive);
router.post(   '/:id/reorder', writePeriods, controller.reorder);
router.delete( '/:id',         writePeriods, controller.remove);

router.use((err, req, res, next) => {
  console.error('periods.routes error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

module.exports = router;
