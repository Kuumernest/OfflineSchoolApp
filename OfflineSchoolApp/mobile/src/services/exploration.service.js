// mobile/src/services/exploration.service.js
"use strict";

/**
 * The pupil's side of the exploration loop, with or without a connection.
 *
 * ── Reads: fetched when online, kept in SQLite, shown from SQLite ─────────
 *
 * The catalog, the suggestions and the pupil's own explorations are fetched
 * from the server when the phone can reach it and cached locally, so a pupil
 * can open Explore in a classroom with no signal and still see the activity
 * they started yesterday, its task, its expected outputs and its reflection
 * prompts. The catalog is small (thirty activities) and versioned; a fetch
 * replaces the cache whole.
 *
 * ── Writes: the outbox, always ────────────────────────────────────────────
 *
 * Every mutation goes through MutationQueue, as every mutation in this
 * application does. The row is updated in SQLite first, so the screen shows
 * the move at once, and the server hears about it when the phone next has a
 * connection. Creates carry a UUID the server keeps, and the server's state
 * moves are no-ops when already made, so a retry after a dropped connection
 * lands on the same exploration and records nothing twice.
 *
 * ── "me" ──────────────────────────────────────────────────────────────────
 *
 * A pupil's phone does not know the Student record id; the server resolves
 * "me" to the record the signed-in account owns and refuses any other pupil.
 */

import api from "./api";
import { getDatabase } from "../db/database";
import { generateUUID } from "../utils/idHelpers";
import { getCurrentAuth } from "../utils/authHelpers";
import { MutationQueue } from "./mutationQueue.service";

const ACTIVITIES = "exploration_activities";
const SUGGESTIONS = "exploration_suggestions";
const EXPLORATIONS = "student_explorations";

const ensureSchema = async (db) => {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS ${ACTIVITIES} (
    id TEXT PRIMARY KEY, lang TEXT NOT NULL, json TEXT NOT NULL, fetchedAt TEXT NOT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS ${SUGGESTIONS} (
    id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, json TEXT NOT NULL, fetchedAt TEXT NOT NULL
  );`);
  await db.execAsync(`CREATE TABLE IF NOT EXISTS ${EXPLORATIONS} (
    id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, updatedAt TEXT NOT NULL
  );`);
};

const ownerOf = () => {
  const { user } = getCurrentAuth();
  return String(user?._id ?? user?.id ?? "");
};

const parseRows = (rows) => rows.map((r) => JSON.parse(r.json));

// ─────────────────────────────────────────────────────────────────────────────
// CATALOG
// ─────────────────────────────────────────────────────────────────────────────

export const refreshCatalog = async (lang = "en") => {
  const db = await getDatabase();
  await ensureSchema(db);
  const { data } = await api.get("/explorations/activities", { params: { lang } });
  const activities = data?.data?.activities ?? [];
  const now = new Date().toISOString();
  await db.runAsync(`DELETE FROM ${ACTIVITIES} WHERE lang = ?`, [lang]);
  for (const a of activities) {
    await db.runAsync(`INSERT OR REPLACE INTO ${ACTIVITIES} (id, lang, json, fetchedAt) VALUES (?, ?, ?, ?)`,
      [`${a.activityId}:${lang}`, lang, JSON.stringify(a), now]);
  }
  return activities;
};

export const getCatalog = async (lang = "en") => {
  const db = await getDatabase();
  await ensureSchema(db);
  return parseRows(await db.getAllAsync(`SELECT json FROM ${ACTIVITIES} WHERE lang = ? ORDER BY id`, [lang]));
};

export const getActivity = async (activityId, lang = "en") => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(`SELECT json FROM ${ACTIVITIES} WHERE id = ?`, [`${activityId}:${lang}`]);
  return row ? JSON.parse(row.json) : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUGGESTIONS AND MY EXPLORATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const refreshSuggestions = async (lang = "en") => {
  const db = await getDatabase();
  await ensureSchema(db);
  const { data } = await api.get("/insights/student/me/explorations/recommended", { params: { lang } });
  const payload = data?.data ?? { suggestions: [] };
  await db.runAsync(`INSERT OR REPLACE INTO ${SUGGESTIONS} (id, ownerId, json, fetchedAt) VALUES (?, ?, ?, ?)`,
    [`me:${ownerOf()}`, ownerOf(), JSON.stringify(payload), new Date().toISOString()]);
  return payload;
};

export const getSuggestions = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(`SELECT json FROM ${SUGGESTIONS} WHERE id = ?`, [`me:${ownerOf()}`]);
  return row ? JSON.parse(row.json) : { suggestions: [], breadth: null };
};

/** The pupil's concise learning lines — facts, no labels. Online only; [] offline. */
export const fetchLearningConcise = async () => {
  try {
    const { data } = await api.get("/insights/student/me/learning-patterns");
    return data?.data?.concise ?? [];
  } catch { return []; }
};

/**
 * The pupil's own strengths reading (Strength Reading 1.2.0): established and
 * emerging dimensions with how each is known, what supports it, what is still
 * unclear, and the areas it opens. Online only; null offline. No score.
 */
export const fetchMyStrengths = async () => {
  try {
    const { data } = await api.get("/insights/student/me/strengths");
    const p = data?.data?.profile ?? null;
    if (!p) return null;
    const pick = (d) => ({
      dimension: d.dimension, state: d.state, relationship: d.learningEvidence?.relationship ?? null,
      events: d.learningEvidence?.independentEventCount ?? 0, families: d.learningEvidence?.sourceFamilies ?? [],
      missing: d.context?.missingModalities ?? [], attendanceLimited: Boolean(d.context?.attendanceLimited),
      quality: (d.interpretation?.quality ?? []).filter((q) => q !== "SOURCE_MODALITY_UNAVAILABLE"),
      areas: (p.explorationAreas ?? []).filter((a) => (a.because ?? []).some((b) => b.dimension === d.dimension)).map((a) => a.area),
    });
    return { versions: { strengths: p.strengthEngineVersion, integration: p.learningIntegrationVersion ?? null }, dimensions: [...(p.strengths ?? []), ...(p.emergingAreas ?? [])].map(pick) };
  } catch { return null; }
};

/**
 * The pupil's own development history (Development Engine 1.0.0): per
 * strength, the observations over time, the trajectory, why it changed, what
 * is unclear. Derived on the server from immutable snapshots; nothing is
 * scored. Online only; null offline.
 */
export const fetchMyDevelopment = async () => {
  try {
    const { data } = await api.get("/insights/student/me/development");
    return data?.data ?? null;
  } catch { return null; }
};

/** The pupil's own development guidance: bounded options with what was noticed, why, what to try, what to watch. Informs; never instructs. Online only. */
export const fetchMyGuidance = async () => {
  try { const { data } = await api.get("/insights/student/me/development/guidance"); return data?.data ?? null; } catch { return null; }
};

/** The pupil's own support: proposed and agreed interventions with their observed outcome. Online only. */
export const fetchMyInterventions = async () => {
  try { const { data } = await api.get("/insights/student/me/interventions"); return data?.data ?? null; } catch { return null; }
};

/** Accept or decline a proposal made to the pupil. The pupil decides; the server enforces which moves a pupil may make. */
export const actOnMyIntervention = async (interventionId, action) => {
  const { data } = await api.patch(`/insights/student/me/interventions/${interventionId}`, { action });
  return data?.data ?? null;
};

/** What changed since the last profile snapshot, in the words the pupil sees. Online only; null offline. */
export const fetchProfileChanges = async () => {
  try {
    const { data } = await api.get("/insights/student/me/profile/changes");
    return data?.data ?? null;
  } catch { return null; }
};

export const refreshExplorations = async (lang = "en") => {
  const db = await getDatabase();
  await ensureSchema(db);
  const { data } = await api.get("/insights/student/me/explorations", { params: { lang } });
  const rows = data?.data?.explorations ?? [];
  const owner = ownerOf();
  for (const e of rows) {
    // A row the outbox is still carrying keeps its local state until the server answers.
    const pending = await db.getFirstAsync(`SELECT updatedAt FROM ${EXPLORATIONS} WHERE id = ? AND status <> ?`, [e.explorationId, e.status]);
    if (pending && pending.updatedAt > (e.updatedAt ?? "")) continue;
    await db.runAsync(`INSERT OR REPLACE INTO ${EXPLORATIONS} (id, ownerId, status, json, updatedAt) VALUES (?, ?, ?, ?, ?)`,
      [e.explorationId, owner, e.status, JSON.stringify(e), new Date().toISOString()]);
  }
  return rows;
};

export const getExplorations = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  return parseRows(await db.getAllAsync(`SELECT json FROM ${EXPLORATIONS} WHERE ownerId = ? ORDER BY updatedAt DESC`, [ownerOf()]));
};

export const getExploration = async (explorationId) => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(`SELECT json FROM ${EXPLORATIONS} WHERE id = ?`, [explorationId]);
  return row ? JSON.parse(row.json) : null;
};

const saveLocal = async (e) => {
  const db = await getDatabase();
  await ensureSchema(db);
  await db.runAsync(`INSERT OR REPLACE INTO ${EXPLORATIONS} (id, ownerId, status, json, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    [e.explorationId, ownerOf(), e.status, JSON.stringify(e), new Date().toISOString()]);
  return e;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE PUPIL'S MOVES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take an activity from the list: start, save, skip or not_interested. The
 * exploration id is minted here and kept by the server for ever.
 */
export const chooseActivity = async ({ activity, suggestion = null, action = "start" }) => {
  const id = generateUUID();
  const now = new Date().toISOString();
  const status = { start: "STARTED", save: "SAVED", skip: "SKIPPED", not_interested: "NOT_INTERESTED" }[action] ?? "STARTED";
  const local = {
    explorationId: id, activityId: activity.activityId, activityVersion: activity.version, area: activity.area, level: activity.level,
    title: activity.title, status, relevance: suggestion?.relevance ?? null, suggestedBecause: suggestion?.reasons ?? [],
    discoveredAt: now, startedAt: status === "STARTED" ? now : null, submittedAt: null, completedAt: null,
    closedAt: ["SKIPPED", "NOT_INTERESTED"].includes(status) ? now : null,
    outputs: [], reflection: null, observations: [], evidence: [], pattern: { interest: null, performance: null, pattern: null },
    version: 1, explorationEngineVersion: activity.engineVersion ?? null, pendingSync: true,
  };
  await saveLocal(local);
  await MutationQueue.enqueue({
    entityKey: `exploration:${id}:create`, method: "POST", endpoint: "/insights/student/me/explorations",
    payload: { _id: id, activityId: activity.activityId, action, reasons: suggestion?.reasons ?? [], relevance: suggestion?.relevance ?? null },
  });
  return local;
};

const post = async (explorationId, path, payload, next) => {
  const e = await getExploration(explorationId);
  if (!e) throw new Error("Exploration not found");
  const updated = { ...e, ...next(e), pendingSync: true };
  await saveLocal(updated);
  await MutationQueue.enqueue({ entityKey: `exploration:${explorationId}:${path}`, method: "POST", endpoint: `/explorations/${explorationId}/${path}`, payload: { version: e.version, ...payload }, baseVersion: e.version });
  return updated;
};

export const startExploration   = (id) => post(id, "start", {}, () => ({ status: "STARTED", startedAt: new Date().toISOString() }));
export const abandonExploration = (id) => post(id, "abandon", {}, () => ({ status: "ABANDONED", closedAt: new Date().toISOString() }));
export const skipExploration    = (id) => post(id, "skip", {}, () => ({ status: "SKIPPED", closedAt: new Date().toISOString() }));

/**
 * Submit: what was produced, how it went. The screen shows "recorded" at once;
 * whether the exploration then completes or waits for a teacher's rating is
 * the server's answer, mirrored on the next refresh.
 */
export const submitExploration = (id, { outputs, completionMode = null, reflection = null }) =>
  post(id, "submit", { outputs, completionMode, reflection }, (e) => ({
    status: "SUBMITTED", submittedAt: new Date().toISOString(), outputs,
    reflection: reflection ? { ...reflection, version: 1 } : e.reflection,
  }));

export const reviseReflection = (id, reflection) =>
  post(id, "reflection", reflection, (e) => ({ reflection: { ...(e.reflection ?? {}), ...reflection } }));
