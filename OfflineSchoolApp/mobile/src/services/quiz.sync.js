// src/services/quiz.sync.js

import { getDb } from './db';
import { generateId } from './utils';
import { apiClient } from './api'; // your existing API client

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const SYNC_TABLES = [
  {
    table: 'question_categories',
    endpoint: '/quiz/categories',
    idField: 'id',
  },
  {
    table: 'questions',
    endpoint: '/quiz/questions',
    idField: 'id',
    children: [
      {
        table: 'question_options',
        parentKey: 'question_id',
        endpoint: '/quiz/questions/:parentId/options',
      },
    ],
  },
  {
    table: 'quizzes',
    endpoint: '/quiz/quizzes',
    idField: 'id',
    children: [
      {
        table: 'quiz_questions',
        parentKey: 'quiz_id',
        endpoint: '/quiz/quizzes/:parentId/questions',
      },
      {
        table: 'quiz_question_pools',
        parentKey: 'quiz_id',
        endpoint: '/quiz/quizzes/:parentId/pools',
      },
    ],
  },
  {
    table: 'quiz_attempts',
    endpoint: '/quiz/attempts',
    idField: 'id',
    children: [
      {
        table: 'attempt_answers',
        parentKey: 'attempt_id',
        endpoint: '/quiz/attempts/:parentId/answers',
        children: [
          {
            table: 'attempt_answer_selections',
            parentKey: 'attempt_answer_id',
            endpoint: '/quiz/attempts/:parentId/answers/:childId/selections',
          },
        ],
      },
    ],
  },
  {
    table: 'question_analytics',
    endpoint: '/quiz/analytics/questions',
    idField: 'id',
  },
  {
    table: 'quiz_analytics',
    endpoint: '/quiz/analytics/quizzes',
    idField: 'id',
  },
];

// ─────────────────────────────────────────────────────────────
// PUSH — Local → Server
// ─────────────────────────────────────────────────────────────

/**
 * Push all unsynced quiz data to the server.
 * Call this on save, on submit, or on a timer.
 */
export const pushQuizData = async (schoolId) => {
  const db = await getDb();
  const results = {
    pushed: 0,
    failed: 0,
    errors: [],
  };

  for (const config of SYNC_TABLES) {
    try {
      await _pushTable(db, config, schoolId, results);
    } catch (err) {
      results.failed++;
      results.errors.push({
        table: config.table,
        error: err.message,
      });
      console.warn(`❌ Push failed for ${config.table}:`, err.message);
    }
  }

  console.log(
    `📤 Quiz push complete: ${results.pushed} pushed, ${results.failed} failed`
  );
  return results;
};

const _pushTable = async (db, config, schoolId, results) => {
  // Get unsynced rows
  const rows = await db.getAllAsync(
    `SELECT * FROM ${config.table}
     WHERE _synced = 0`,
  );

  if (rows.length === 0) return;

  // Attach children if any
  if (config.children) {
    for (const row of rows) {
      for (const child of config.children) {
        row[`_${child.table}`] = await db.getAllAsync(
          `SELECT * FROM ${child.table} WHERE ${child.parentKey} = ?`,
          [row[config.idField]]
        );

        // Nested children (e.g., attempt_answer_selections under attempt_answers)
        if (child.children) {
          for (const childRow of row[`_${child.table}`]) {
            for (const grandchild of child.children) {
              childRow[`_${grandchild.table}`] = await db.getAllAsync(
                `SELECT * FROM ${grandchild.table}
                 WHERE ${grandchild.parentKey} = ?`,
                [childRow.id]
              );
            }
          }
        }
      }
    }
  }

  // Send to server in batches
  const BATCH_SIZE = 50;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    try {
      const response = await apiClient.post(config.endpoint + '/sync', {
        schoolId,
        records: batch,
      });

      if (response.success) {
        // Mark as synced
        const ids = batch.map((r) => r[config.idField]);
        await _markSynced(db, config.table, config.idField, ids);

        // Mark children as synced
        if (config.children) {
          for (const child of config.children) {
            for (const row of batch) {
              const childRows = row[`_${child.table}`] || [];
              const childIds  = childRows.map((r) => r.id);
              if (childIds.length > 0) {
                await _markSynced(db, child.table, 'id', childIds);
              }
            }
          }
        }

        results.pushed += batch.length;
      }
    } catch (err) {
      results.failed += batch.length;
      results.errors.push({
        table: config.table,
        batch: i,
        error: err.message,
      });
    }
  }
};

const _markSynced = async (db, table, idField, ids) => {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(',');
  const now          = new Date().toISOString();

  await db.runAsync(
    `UPDATE ${table}
     SET _synced    = 1,
         _synced_at = ?
     WHERE ${idField} IN (${placeholders})`,
    [now, ...ids]
  );
};

// ─────────────────────────────────────────────────────────────
// PULL — Server → Local
// ─────────────────────────────────────────────────────────────

/**
 * Pull quiz data from the server.
 * Uses last sync timestamp to only get changes.
 */
export const pullQuizData = async (schoolId) => {
  const db = await getDb();
  const results = {
    pulled: 0,
    failed: 0,
    errors: [],
  };

  // Get last sync time
  const lastSync = await _getLastSyncTime(db, 'quiz_sync');

  for (const config of SYNC_TABLES) {
    try {
      await _pullTable(db, config, schoolId, lastSync, results);
    } catch (err) {
      results.failed++;
      results.errors.push({
        table: config.table,
        error: err.message,
      });
      console.warn(`❌ Pull failed for ${config.table}:`, err.message);
    }
  }

  // Update last sync time
  await _setLastSyncTime(db, 'quiz_sync');

  console.log(
    `📥 Quiz pull complete: ${results.pulled} pulled, ${results.failed} failed`
  );
  return results;
};

const _pullTable = async (db, config, schoolId, lastSync, results) => {
  const response = await apiClient.get(config.endpoint + '/sync', {
    params: {
      schoolId,
      since: lastSync,
    },
  });

  if (!response.success || !response.data?.length) return;

  for (const record of response.data) {
    await _upsertRecord(db, config.table, config.idField, record);

    // Upsert children
    if (config.children) {
      for (const child of config.children) {
        const childRecords = record[`_${child.table}`] || record[child.table] || [];
        for (const childRecord of childRecords) {
          await _upsertRecord(db, child.table, 'id', childRecord);

          // Nested children
          if (child.children) {
            for (const grandchild of child.children) {
              const gcRecords =
                childRecord[`_${grandchild.table}`] ||
                childRecord[grandchild.table] || [];
              for (const gcRecord of gcRecords) {
                await _upsertRecord(db, grandchild.table, 'id', gcRecord);
              }
            }
          }
        }
      }
    }

    results.pulled++;
  }
};

const _upsertRecord = async (db, table, idField, record) => {
  const existing = await db.getFirstAsync(
    `SELECT ${idField}, version FROM ${table} WHERE ${idField} = ?`,
    [record[idField]]
  );

  if (existing) {
    // Only update if server version is newer
    if ((record.version ?? 1) <= (existing.version ?? 1)) return;

    const fields = Object.keys(record).filter((k) => k !== idField);
    if (fields.length === 0) return;

    const setClauses = fields.map((f) => `${f} = ?`).join(', ');
    const values     = fields.map((f) => record[f]);

    await db.runAsync(
      `UPDATE ${table}
       SET ${setClauses}, _synced = 1, _synced_at = datetime('now')
       WHERE ${idField} = ?`,
      [...values, record[idField]]
    );
  } else {
    // Insert new record
    const fields       = Object.keys(record);
    const placeholders = fields.map(() => '?').join(', ');
    const values       = fields.map((f) => record[f]);

    await db.runAsync(
      `INSERT OR IGNORE INTO ${table} (${fields.join(', ')}, _synced, _synced_at)
       VALUES (${placeholders}, 1, datetime('now'))`,
      values
    );
  }
};

// ─────────────────────────────────────────────────────────────
// CONFLICT RESOLUTION
// ─────────────────────────────────────────────────────────────

/**
 * Resolve conflicts between local and server data.
 * Strategy: Server wins for quiz config, Local wins for in-progress attempts.
 */
export const resolveConflicts = async (schoolId) => {
  const db = await getDb();

  // Find records that were modified both locally and on server
  const conflicts = await db.getAllAsync(
    `SELECT qa.id, qa.quiz_id, qa.status,
            qa.updated_at AS local_updated
     FROM quiz_attempts qa
     WHERE qa._synced = 0
       AND qa.status = 'in_progress'`
  );

  for (const conflict of conflicts) {
    try {
      const serverRecord = await apiClient.get(
        `/quiz/attempts/${conflict.id}`
      );

      if (!serverRecord.data) continue;

      // In-progress attempts: local always wins
      if (conflict.status === 'in_progress') {
        console.log(`🔀 Conflict: ${conflict.id} — keeping local (in-progress)`);
        continue;
      }

      // Submitted / graded: server wins
      if (serverRecord.data.status === 'submitted') {
        await _upsertRecord(db, 'quiz_attempts', 'id', serverRecord.data);
        console.log(`🔀 Conflict: ${conflict.id} — server wins (submitted)`);
      }
    } catch (err) {
      console.warn(`❌ Conflict resolution failed for ${conflict.id}:`, err.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────
// FULL SYNC (Push + Pull + Resolve)
// ─────────────────────────────────────────────────────────────

/**
 * Run a full quiz sync cycle.
 * Recommended: call this when the app regains connectivity.
 */
export const syncQuizData = async (schoolId) => {
  console.log('🔄 Quiz sync starting...');

  const pushResults = await pushQuizData(schoolId);
  const pullResults = await pullQuizData(schoolId);
  await resolveConflicts(schoolId);

  const summary = {
    pushed: pushResults.pushed,
    pulled: pullResults.pulled,
    errors: [...pushResults.errors, ...pullResults.errors],
    syncedAt: new Date().toISOString(),
  };

  console.log('✅ Quiz sync complete:', summary);
  return summary;
};

// ─────────────────────────────────────────────────────────────
// SELECTIVE SYNC — Attempt-level
// ─────────────────────────────────────────────────────────────

/**
 * Sync a single attempt with all its answers.
 * Useful: call after submitAttempt() for immediate sync.
 */
export const syncAttempt = async (attemptId) => {
  const db = await getDb();

  const attempt = await db.getFirstAsync(
    `SELECT * FROM quiz_attempts WHERE id = ?`,
    [attemptId]
  );

  if (!attempt) throw new Error('Attempt not found');

  // Gather all related data
  const answers = await db.getAllAsync(
    `SELECT * FROM attempt_answers WHERE attempt_id = ?`,
    [attemptId]
  );

  for (const answer of answers) {
    answer.selections = await db.getAllAsync(
      `SELECT * FROM attempt_answer_selections
       WHERE attempt_answer_id = ?`,
      [answer.id]
    );
  }

  const payload = {
    ...attempt,
    answers,
  };

  try {
    const response = await apiClient.post('/quiz/attempts/sync-one', payload);

    if (response.success) {
      // Mark attempt synced
      await _markSynced(db, 'quiz_attempts', 'id', [attemptId]);

      // Mark answers synced
      const answerIds = answers.map((a) => a.id);
      if (answerIds.length) {
        await _markSynced(db, 'attempt_answers', 'id', answerIds);
      }

      // Mark selections synced
      for (const answer of answers) {
        const selIds = answer.selections.map((s) => s.id);
        if (selIds.length) {
          await _markSynced(db, 'attempt_answer_selections', 'id', selIds);
        }
      }

      console.log(`✅ Attempt ${attemptId} synced`);
      return { success: true };
    }
  } catch (err) {
    console.warn(`❌ Attempt sync failed: ${err.message}`);

    // Queue for retry
    await db.runAsync(
      `INSERT INTO sync_queue (id, entity, operation, payload, created_at)
       VALUES (?, 'quiz_attempt', 'sync', ?, datetime('now'))`,
      [generateId(), JSON.stringify(payload)]
    );

    return { success: false, error: err.message, queued: true };
  }
};

// ─────────────────────────────────────────────────────────────
// SYNC QUEUE PROCESSOR — Retry failed syncs
// ─────────────────────────────────────────────────────────────

/**
 * Process any queued quiz syncs that previously failed.
 * Call this when connectivity is restored.
 */
export const processQuizSyncQueue = async () => {
  const db = await getDb();

  const queued = await db.getAllAsync(
    `SELECT * FROM sync_queue
     WHERE entity LIKE 'quiz%'
       AND synced = 0
     ORDER BY created_at ASC`
  );

  if (queued.length === 0) {
    console.log('📭 No queued quiz syncs');
    return { processed: 0 };
  }

  let processed = 0;

  for (const item of queued) {
    try {
      const payload = JSON.parse(item.payload);

      let endpoint;
      switch (item.entity) {
        case 'quiz_attempt':
          endpoint = '/quiz/attempts/sync-one';
          break;
        case 'quiz_question':
          endpoint = '/quiz/questions/sync';
          break;
        case 'quiz':
          endpoint = '/quiz/quizzes/sync';
          break;
        default:
          endpoint = `/quiz/${item.entity}/sync`;
      }

      const response = await apiClient.post(endpoint, payload);

      if (response.success) {
        await db.runAsync(
          `UPDATE sync_queue SET synced = 1 WHERE id = ?`,
          [item.id]
        );
        processed++;
      }
    } catch (err) {
      console.warn(`❌ Queue item ${item.id} still failing:`, err.message);
    }
  }

  console.log(`📬 Processed ${processed}/${queued.length} queued quiz syncs`);
  return { processed, total: queued.length };
};

// ─────────────────────────────────────────────────────────────
// SYNC TIMESTAMPS
// ─────────────────────────────────────────────────────────────

const _getLastSyncTime = async (db, key) => {
  const row = await db.getFirstAsync(
    `SELECT value FROM _sync_meta WHERE key = ?`,
    [key]
  );
  return row?.value ?? null;
};

const _setLastSyncTime = async (db, key) => {
  const now = new Date().toISOString();

  // Ensure the meta table exists
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS _sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await db.runAsync(
    `INSERT OR REPLACE INTO _sync_meta (key, value) VALUES (?, ?)`,
    [key, now]
  );
};

// ─────────────────────────────────────────────────────────────
// SYNC STATUS — For UI indicators
// ─────────────────────────────────────────────────────────────

/**
 * Get a quick summary of what needs syncing.
 * Useful for showing a badge or indicator in the UI.
 */
export const getQuizSyncStatus = async () => {
  const db = await getDb();

  const unsyncedQuizzes = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM quizzes WHERE _synced = 0 AND deleted_at IS NULL`
  );

  const unsyncedQuestions = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM questions WHERE _synced = 0 AND deleted_at IS NULL`
  );

  const unsyncedAttempts = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM quiz_attempts WHERE _synced = 0`
  );

  const queuedItems = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM sync_queue
     WHERE entity LIKE 'quiz%' AND synced = 0`
  );

  const lastSync = await _getLastSyncTime(db, 'quiz_sync');

  return {
    unsynced: {
      quizzes:   unsyncedQuizzes.count,
      questions: unsyncedQuestions.count,
      attempts:  unsyncedAttempts.count,
      queued:    queuedItems.count,
    },
    total: unsyncedQuizzes.count +
           unsyncedQuestions.count +
           unsyncedAttempts.count +
           queuedItems.count,
    lastSync,
    needsSync: (unsyncedQuizzes.count +
                unsyncedQuestions.count +
                unsyncedAttempts.count) > 0,
  };
};