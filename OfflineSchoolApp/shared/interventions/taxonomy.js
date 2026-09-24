// shared/interventions/taxonomy.js
"use strict";

/**
 * What each trigger means, what an intervention proposed from it is for,
 * who owns it by default, what evidence it collects, and how long it runs
 * before review. Codes only; the interface holds the sentences.
 */

const TRIGGER_DEFINITIONS = Object.freeze({
  PERSISTENT_DECLINE:         { objective: "STABILISE_AND_UNDERSTAND_THE_DECLINE", ownerRole: "TEACHER", evidenceToCollect: ["ACADEMIC", "ASSIGNMENT", "TEACHER_OBSERVATION"], durationDays: 42, guidanceCategory: "SEEK_SUPPORT" },
  REPEATED_DIFFICULTY:        { objective: "TARGETED_PRACTICE_ON_THE_DIFFICULT_PART", ownerRole: "TEACHER", evidenceToCollect: ["ASSIGNMENT", "QUIZ"], durationDays: 42, guidanceCategory: "CHANGE_APPROACH" },
  LEARNING_CONTRADICTION:     { objective: "EXAMINE_WHY_CLASS_AND_INDEPENDENT_WORK_DISAGREE", ownerRole: "TEACHER", evidenceToCollect: ["ASSIGNMENT", "QUIZ", "TEACHER_OBSERVATION"], durationDays: 28, guidanceCategory: "REFLECT" },
  ACADEMIC_LEARNING_MISMATCH: { objective: "CHECK_THE_ASSESSMENT_CONTEXT_AND_TASK_TYPES", ownerRole: "TEACHER", evidenceToCollect: ["COURSEWORK", "ASSIGNMENT"], durationDays: 28, guidanceCategory: "REFLECT" },
  INSUFFICIENT_EVIDENCE:      { objective: "GATHER_INDEPENDENT_LEARNING_EVIDENCE", ownerRole: "STUDENT", evidenceToCollect: ["ASSIGNMENT", "QUIZ", "COURSEWORK"], durationDays: 42, guidanceCategory: "BUILD_EVIDENCE" },
  REPEATED_SUPPORT_SIGNAL:    { objective: "AGREE_A_SUPPORT_PLAN_WITH_THE_TEACHER", ownerRole: "TEACHER", evidenceToCollect: ["TEACHER_OBSERVATION", "ACADEMIC"], durationDays: 56, guidanceCategory: "SEEK_SUPPORT" },
  EVIDENCE_COVERAGE_GAP:      { objective: "OPEN_A_MISSING_EVIDENCE_SOURCE", ownerRole: "TEACHER", evidenceToCollect: ["PRACTICAL", "EXPLORATION", "COURSEWORK"], durationDays: 56, guidanceCategory: "BUILD_EVIDENCE" },
});

/** Bounded actions per trigger; the proposer picks one. */
const ACTIONS = Object.freeze({
  PERSISTENT_DECLINE:         ["WEEKLY_CHECK_IN_WITH_SUBJECT_TEACHER", "STRUCTURED_REVISION_OF_RECENT_TOPICS"],
  REPEATED_DIFFICULTY:        ["SHORT_TARGETED_PRACTICE_SET", "PEER_OR_TEACHER_WORKED_EXAMPLES"],
  LEARNING_CONTRADICTION:     ["COMPARE_A_CLASS_TASK_AND_AN_INDEPENDENT_TASK_TOGETHER", "AGREE_HOW_INDEPENDENT_WORK_IS_DONE"],
  ACADEMIC_LEARNING_MISMATCH: ["REVIEW_TASK_TYPES_ACROSS_ASSESSMENTS", "ONE_SUPERVISED_PIECE_OF_INDEPENDENT_WORK"],
  INSUFFICIENT_EVIDENCE:      ["COMPLETE_THE_NEXT_ASSIGNMENTS_AND_QUIZZES", "ONE_EXPLORATION_ACTIVITY_IN_THE_AREA"],
  REPEATED_SUPPORT_SIGNAL:    ["SUPPORT_PLAN_AGREED_WITH_TEACHER", "REGULAR_PROGRESS_CONVERSATION"],
  EVIDENCE_COVERAGE_GAP:      ["SCHEDULE_A_PRACTICAL_OR_PROJECT", "RECORD_A_TEACHER_OBSERVATION"],
});

module.exports = { TRIGGER_DEFINITIONS, ACTIONS };
