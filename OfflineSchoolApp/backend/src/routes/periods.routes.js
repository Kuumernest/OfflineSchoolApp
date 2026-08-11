// backend/src/routes/periods.routes.js
'use strict';

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/periods.controller');
const { authenticate } = require('../../middleware/auth');

router.use(authenticate);

router.get(    '/',            controller.getAll);
router.get(    '/:id',         controller.getById);
router.post(   '/',            controller.create);
router.put(    '/:id',         controller.update);
router.patch(  '/:id/toggle',  controller.toggleActive);
router.post(   '/:id/reorder', controller.reorder);
router.delete( '/:id',         controller.remove);

router.use((err, req, res, next) => {
  console.error('periods.routes error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

module.exports = router;
