// backend/src/utils/uuid.js
const { v4: uuidv4 } = require("uuid");

/**
 * Generates a UUID v4 string
 * @returns {string}
 */
const generateUUID = () => uuidv4();

/**
 * Mongoose schema definition for UUID _id fields.
 * Usage:  _id: uuidSchema
 */
const uuidSchema = {
  type:    String,
  default: uuidv4,
};

module.exports = {
  generateUUID,
  uuidSchema,
};