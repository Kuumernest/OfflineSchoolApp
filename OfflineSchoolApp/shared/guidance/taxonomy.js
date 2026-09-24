// shared/guidance/taxonomy.js
"use strict";

/**
 * The guidance taxonomy: what each category means, which concrete actions
 * it may carry, and which evidence families would show whether an action
 * helped. Everything is a code. The interface renders codes in the pupil's
 * language as invitations ("you could try…"), never as orders.
 */

const DEFINITIONS = Object.freeze({
  MAINTAIN:        "an established strength or positive pattern is stable",
  PRACTICE:        "evidence shows an area that would benefit from more practice",
  DEEPEN:          "evidence is established enough to justify more challenging work",
  EXPLORE:         "an emerging strength or learning relationship offers a reasonable opening",
  REFLECT:         "evidence is mixed or contradictory; examine the experience rather than receive a conclusion",
  SEEK_SUPPORT:    "persistent difficulty, declining development or insufficient progress where human support could reasonably help",
  CHANGE_APPROACH: "repeated evidence that the current approach is not producing improvement",
  BUILD_EVIDENCE:  "coverage is insufficient to support a stronger interpretation",
  REVISIT:         "an earlier area of exploration has become relevant again",
  MONITOR:         "evidence changed, but not enough is known for stronger guidance",
});

/**
 * Bounded, concrete actions per category. `instruction` and `expectedEvidence`
 * are template codes; the catalogue in the interface holds the sentences.
 */
const ACTIONS = Object.freeze({
  MAINTAIN:        [{ type: "MAINTAIN", instruction: "KEEP_APPLYING_IN_CLASS_AND_COURSEWORK", expectedEvidence: "CONTINUED_STRONG_MARKS_AND_COURSEWORK" }],
  PRACTICE:        [{ type: "PRACTICE", instruction: "SHORT_REGULAR_PRACTICE_TASKS", expectedEvidence: "QUIZ_AND_ASSIGNMENT_MARKS_OVER_NEXT_PERIOD" }],
  DEEPEN:          [{ type: "DEEPEN", instruction: "ATTEMPT_HARDER_PROBLEMS_OR_A_PROJECT", expectedEvidence: "PRACTICAL_OR_PROJECT_EVIDENCE_AND_TEACHER_OBSERVATION" }],
  EXPLORE:         [{ type: "EXPLORE", instruction: "CHOOSE_AN_EXPLORATION_ACTIVITY_IN_THIS_AREA", expectedEvidence: "EXPLORATION_PERFORMANCE_AND_REFLECTION" }],
  REFLECT:         [{ type: "REFLECT", instruction: "COMPARE_WHERE_IT_WENT_WELL_AND_WHERE_IT_DID_NOT", expectedEvidence: "REFLECTION_AND_NEXT_ASSIGNMENTS" }],
  SEEK_SUPPORT:    [{ type: "SEEK_SUPPORT", instruction: "TALK_TO_THE_SUBJECT_TEACHER_ABOUT_WHAT_IS_HARD", expectedEvidence: "TEACHER_OBSERVATION_AND_NEXT_ASSESSMENTS" }],
  CHANGE_APPROACH: [{ type: "CHANGE_APPROACH", instruction: "TRY_A_DIFFERENT_WAY_OF_STUDYING_THIS_SUBJECT", expectedEvidence: "QUIZ_AND_ASSIGNMENT_MARKS_OVER_NEXT_PERIOD" }],
  BUILD_EVIDENCE:  [{ type: "BUILD_EVIDENCE", instruction: "COMPLETE_ASSIGNMENTS_AND_QUIZZES_SO_THE_RECORD_CAN_SHOW_MORE", expectedEvidence: "MORE_INDEPENDENT_LEARNING_EVENTS" }],
  REVISIT:         [{ type: "REVISIT", instruction: "RETURN_TO_AN_EARLIER_EXPLORATION_IN_THIS_AREA", expectedEvidence: "EXPLORATION_PERFORMANCE_AND_REFLECTION" }],
  MONITOR:         [{ type: "MONITOR", instruction: "CARRY_ON_AND_LET_THE_NEXT_PERIOD_SHOW", expectedEvidence: "NEXT_PERIOD_ASSESSMENTS" }],
});

/** Which evidence families to watch for each category. */
const EVIDENCE_TO_WATCH = Object.freeze({
  MAINTAIN: ["ACADEMIC", "COURSEWORK", "ASSIGNMENT"], PRACTICE: ["QUIZ", "ASSIGNMENT"], DEEPEN: ["PRACTICAL", "TEACHER_OBSERVATION", "EXPLORATION"],
  EXPLORE: ["EXPLORATION", "REFLECTION"], REFLECT: ["REFLECTION", "ASSIGNMENT"], SEEK_SUPPORT: ["TEACHER_OBSERVATION", "ACADEMIC"],
  CHANGE_APPROACH: ["QUIZ", "ASSIGNMENT", "ACADEMIC"], BUILD_EVIDENCE: ["ASSIGNMENT", "QUIZ", "COURSEWORK"], REVISIT: ["EXPLORATION"], MONITOR: ["ACADEMIC"],
});

module.exports = { DEFINITIONS, ACTIONS, EVIDENCE_TO_WATCH };
