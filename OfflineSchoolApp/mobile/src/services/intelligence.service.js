// mobile/src/services/intelligence.service.js
//
// The pupil's own intelligence summary and the questions about it
// (Advanced Intelligence 1.0.0, above the deterministic engines).
//
// ── Two different things ──────────────────────────────────────────────────
//
// The SUMMARY is deterministic: the engines' readings, lined up. It is read
// online and mirrored into SQLite, so a pupil with no signal still opens the
// last one taken, dated, and is told it is the last one. That is the same
// promise every other screen on this phone keeps.
//
// A QUESTION is answered on the server — deterministically always, and by
// a model when the school has one configured and reachable — and it is not
// mirrored and not queued. Not mirrored because an answer is about the
// evidence as of the day it was asked, and a stale answer read later would
// look current. Not queued because a question is not a write: nothing on
// the server changes when it is asked, so an outbox would replay it to no
// purpose and hand the pupil an answer hours after the asking. Offline, the
// screen says explanations need a connection, and the summary beneath is
// still there. The two conditions are different and are shown differently.
//
// "me" throughout: the phone does not know the Student record id; the
// server resolves the signed-in account to the one pupil it owns and
// refuses any other. Nothing here can name another pupil.

import api from "./api";
import { getDatabase } from "../db/database";
import { getCurrentAuth } from "../utils/authHelpers";

const TABLE = "intelligence_summary";

/** The server bounds a question at this many characters; the screen says so before the server has to. */
export const MAX_QUESTION = 1000;

const ensureSchema = async (db) => {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, json TEXT NOT NULL, fetchedAt TEXT NOT NULL);`);
};

const ownerOf = () => { const { user } = getCurrentAuth(); return String(user?._id ?? user?.id ?? ""); };
const langParam = (lang) => ({ params: { lang: String(lang ?? "en").startsWith("fr") ? "fr" : "en" } });

/**
 * Fetch the pupil's summary from the server and mirror it. Throws on failure
 * (offline, refused, server down): the screen decides what to say, and reads
 * the mirror.
 */
export const refreshMyIntelligenceSummary = async (lang = "en") => {
  const db = await getDatabase();
  await ensureSchema(db);
  const { data } = await api.get("/insights/student/me/intelligence-summary", langParam(lang));
  const payload = data?.data ?? null;
  if (payload) {
    await db.runAsync(`INSERT OR REPLACE INTO ${TABLE} (id, ownerId, json, fetchedAt) VALUES (?, ?, ?, ?)`,
      [`me:${ownerOf()}`, ownerOf(), JSON.stringify(payload), new Date().toISOString()]);
  }
  return payload;
};

/** The last summary mirrored for this account, with when it was taken; null when there is none. */
export const getCachedIntelligenceSummary = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(`SELECT json, fetchedAt FROM ${TABLE} WHERE id = ?`, [`me:${ownerOf()}`]);
  if (!row?.json) return null;
  try { return { summary: JSON.parse(row.json), fetchedAt: row.fetchedAt }; } catch { return null; }
};

/**
 * Ask about the pupil's own evidence. `operation` is "explain" (why is this
 * here, what changed, what supports it) or "answer" (an open question — a
 * career question comes back as exploration, a sensitive or unauthorised
 * one refused). Online only; throws so the screen can tell offline
 * (err.isOffline), a refusal of the question (400 with a code), a timeout
 * (err.code === "ECONNABORTED") and everything else apart.
 */
export const askAboutMyProfile = async (question, { operation = "explain", lang = "en" } = {}) => {
  const route = operation === "answer" ? "ask" : "explain";
  const { data } = await api.post(`/insights/student/me/${route}`, { question: String(question ?? "").slice(0, MAX_QUESTION) }, langParam(lang));
  return data?.data ?? null;
};

// ── The pilot's six questions (Stage 18) ──────────────────────────────────
//
// When the school runs a validation pilot, a pupil may answer six bounded
// questions about their own summary — did they understand what was observed,
// inferred, uncertain, supported, open to explore, and theirs to choose.
// Four words per question, no free text, nothing an engine reads; the pilot
// report counts the answers and never names a pupil. Online only, like a
// question: a pilot may close while the phone is away, and an answer queued
// for a closed pilot would be refused hours later to no purpose.

export const FEEDBACK_QUESTIONS = ["observedClear", "inferredClear", "uncertaintyClear", "evidenceClear", "explorationClear", "choiceClear"];
export const FEEDBACK_ANSWERS = ["YES", "PARTLY", "NO", "NOT_SHOWN"];

/** Is a pilot collecting answers at the school, and has this pupil answered? Throws offline (err.isOffline). */
export const getMyPilotFeedback = async () => {
  const { data } = await api.get("/insights/student/me/pilot-feedback");
  return data?.data ?? null;
};

/** Record the pupil's six answers; a second submission replaces the first. Throws offline, or 409 NO_PILOT_COLLECTING when none is. */
export const submitMyPilotFeedback = async (answers) => {
  const clean = Object.fromEntries(FEEDBACK_QUESTIONS.map((q) => [q, answers?.[q]]));
  const { data } = await api.post("/insights/student/me/pilot-feedback", { answers: clean });
  return data?.data ?? null;
};

/** The vocabulary a screen renders; kept beside the calls so the two cannot drift apart. */
export const CLAIM_TYPES = ["OBSERVED", "INFERRED_BY_DETERMINISTIC_ENGINE", "SUGGESTED_EXPLORATION", "UNCERTAIN", "NOT_AVAILABLE"];
export const ANSWER_MODES = ["DETERMINISTIC", "MODEL_VALIDATED", "DETERMINISTIC_FALLBACK", "REFUSED"];
export const SOURCE_TYPES = ["ACADEMIC_PROFILE", "STRENGTH_PROFILE", "LEARNING_EVIDENCE", "DEVELOPMENT_HISTORY", "EXPLORATION", "GUIDANCE", "INTERVENTION", "DEVELOPMENT_PLAN", "PLAN_REVIEW"];

/** The sourceId of a citation in either form the server may use. */
export const citationId = (c) => (typeof c === "string" ? c : c && typeof c === "object" ? c.sourceId ?? null : null);

/**
 * What a citation is about, for a reader: the kind of record and the thing
 * it concerns — a dimension, a subject, an area, a category, a trigger, an
 * objective, an activity. Never an internal id. `t` translates the kind and
 * the dimension; the rest is the server's own text or code.
 */
export const describeCitation = (item, t) => {
  if (!item) return t("intel.source.unknown");
  const kind = t(`intel.source.${item.sourceType}`);
  const humanCode = (s) => String(s ?? "").toLowerCase().replace(/_/g, " ");
  const detail = item.dimension ? t(`strengths.dimension.${item.dimension}`)
    : [item.subjectName, item.area, item.category, item.trigger, item.objective?.code, item.activityId, item.kind, item.insight, item.concise, item.contradiction].map(humanCode).find((s) => s.length > 0);
  return detail ? `${kind} · ${detail}` : kind;
};
