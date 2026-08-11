// src/utils/id.js
"use strict";

/**
 * id.js  —  Backwards-compatibility shim
 *
 * Before the refactor every service had its own copy of generateUniqueId().
 * Those files imported from here. Rather than updating every import site at
 * once, this file re-exports the canonical implementations from idHelpers.js
 * so old imports keep working without changes.
 *
 * Migration path:
 *   Old:  import { generateUniqueId } from "../utils/id";
 *   New:  import { generateLocalId }  from "../utils/idHelpers";
 *         import { generateUUID }     from "../utils/idHelpers";
 */

export {
  generateLocalId,
  generateUUID,
  isServerGeneratedId,
  isLocalId,
  isGhostId,
  needsServerSync,
  getIdSource,
} from "./idHelpers";

/**
 * generateUniqueId
 * @deprecated  Use generateLocalId() for offline-created records.
 *              Use generateUUID()    for records that will get a server ID.
 *
 * Kept as an alias so existing imports do not break during migration.
 */
export { generateLocalId as generateUniqueId } from "./idHelpers";