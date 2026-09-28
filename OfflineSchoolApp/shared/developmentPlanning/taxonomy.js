// shared/developmentPlanning/taxonomy.js
"use strict";

/**
 * Objectives, the actions and milestones each may carry, their completion
 * criteria, and how a guidance category maps to an objective. Codes only.
 *
 * Every objective is bounded and evidence-oriented ("increase exposure to
 * practical problem solving"), never a future identity ("become an
 * engineer") and never a trait ("become more confident"). Every milestone
 * is an observable event. Completion is milestones plus new independent
 * evidence — never a mark going up.
 */

const OBJECTIVES = Object.freeze({
  BUILD_SKILL:            { code: "APPLY_THE_STRENGTH_IN_MORE_DEMANDING_WORK", defaultActions: ["HIGHER_COMPLEXITY"], milestones: [["practical_completed", "STUDENT"], ["teacher_observation_recorded", "TEACHER"]], evidenceFamilies: ["PRACTICAL", "TEACHER_OBSERVATION"], completion: { requiredMilestones: 2, independentObservations: 1 } },
  INCREASE_PRACTICE:      { code: "BUILD_REGULAR_PRACTICE_IN_THIS_AREA", defaultActions: ["MORE_PRACTICE"], milestones: [["assignment_submitted", "STUDENT"], ["quiz_completed", "STUDENT"], ["assignment_submitted", "STUDENT"]], evidenceFamilies: ["ASSIGNMENT", "QUIZ"], completion: { requiredMilestones: 3, independentObservations: 1 } },
  INCREASE_EXPOSURE:      { code: "INCREASE_EXPOSURE_TO_APPLIED_WORK_IN_THIS_AREA", defaultActions: ["ADDITIONAL_EXPOSURE"], milestones: [["activity_started", "STUDENT"], ["activity_completed", "STUDENT"]], evidenceFamilies: ["EXPLORATION"], completion: { requiredMilestones: 2, independentObservations: 1 } },
  EXPLORE:                { code: "EXPLORE_AN_EMERGING_STRENGTH_THROUGH_TWO_INDEPENDENT_ACTIVITIES", defaultActions: ["NEW_CONTEXT"], milestones: [["activity_completed", "STUDENT"], ["reflection_submitted", "STUDENT"], ["activity_completed", "STUDENT"]], evidenceFamilies: ["EXPLORATION", "REFLECTION"], completion: { requiredMilestones: 3, independentObservations: 1 } },
  STRENGTHEN_CONSISTENCY: { code: "BUILD_CONSISTENCY_IN_COMPLETING_COURSEWORK", defaultActions: ["MORE_PRACTICE"], milestones: [["coursework_submitted", "STUDENT"], ["coursework_submitted", "STUDENT"], ["teacher_observation_recorded", "TEACHER"]], evidenceFamilies: ["COURSEWORK", "ASSIGNMENT"], completion: { requiredMilestones: 3, independentObservations: 1 } },
  ADDRESS_DECLINE:        { code: "UNDERSTAND_AND_STEADY_A_RECENT_DECLINE", defaultActions: ["TEACHER_SUPPORT", "MORE_PRACTICE"], milestones: [["support_session_completed", "TEACHER"], ["assignment_submitted", "STUDENT"], ["teacher_observation_recorded", "TEACHER"]], evidenceFamilies: ["ACADEMIC", "ASSIGNMENT", "TEACHER_OBSERVATION"], completion: { requiredMilestones: 3, independentObservations: 1 } },
  RESOLVE_EVIDENCE_GAP:   { code: "IMPROVE_EVIDENCE_COVERAGE_IN_AN_INSUFFICIENTLY_OBSERVED_AREA", defaultActions: ["REPEAT_OBSERVATION"], milestones: [["assignment_submitted", "STUDENT"], ["second_independent_observation_recorded", "TEACHER"]], evidenceFamilies: ["ASSIGNMENT", "QUIZ", "COURSEWORK"], completion: { requiredMilestones: 2, independentObservations: 1 } },
  TEST_AN_APPROACH:       { code: "TRY_A_DIFFERENT_WAY_OF_WORKING_AND_SEE_WHAT_THE_EVIDENCE_SHOWS", defaultActions: ["DIFFERENT_PRACTICE"], milestones: [["different_approach_tried", "STUDENT"], ["assignment_submitted", "STUDENT"], ["reflection_submitted", "STUDENT"]], evidenceFamilies: ["ASSIGNMENT", "QUIZ", "REFLECTION"], completion: { requiredMilestones: 3, independentObservations: 1 } },
  REFLECT:                { code: "EXAMINE_WHERE_IT_WENT_WELL_AND_WHERE_IT_DID_NOT", defaultActions: ["REFLECTION"], milestones: [["reflection_submitted", "STUDENT"], ["support_session_completed", "TEACHER"]], evidenceFamilies: ["REFLECTION", "TEACHER_OBSERVATION"], completion: { requiredMilestones: 2, independentObservations: 0 } },
  SEEK_SUPPORT:           { code: "AGREE_AND_USE_SUPPORT_IN_THIS_AREA", defaultActions: ["TEACHER_SUPPORT"], milestones: [["support_session_completed", "TEACHER"], ["support_session_completed", "TEACHER"], ["teacher_observation_recorded", "TEACHER"]], evidenceFamilies: ["TEACHER_OBSERVATION", "ACADEMIC"], completion: { requiredMilestones: 3, independentObservations: 1 } },
});

/** Which objective a guidance category opens. MONITOR opens none: it means wait, not plan. */
const GUIDANCE_TO_OBJECTIVE = Object.freeze({
  MAINTAIN: "STRENGTHEN_CONSISTENCY", PRACTICE: "INCREASE_PRACTICE", DEEPEN: "BUILD_SKILL", EXPLORE: "EXPLORE", REFLECT: "REFLECT",
  SEEK_SUPPORT: "SEEK_SUPPORT", CHANGE_APPROACH: "TEST_AN_APPROACH", BUILD_EVIDENCE: "RESOLVE_EVIDENCE_GAP", REVISIT: "INCREASE_EXPOSURE", MONITOR: null,
});

/** One deterministic explanation code per action type. */
const ACTION_EXPLANATIONS = Object.freeze({
  MORE_PRACTICE: "MORE_OF_THE_SAME_KIND_OF_WORK_TO_LET_THE_RECORD_SHOW_A_PATTERN",
  DIFFERENT_PRACTICE: "THE_SAME_AIM_THROUGH_A_DIFFERENT_KIND_OF_TASK",
  LOWER_COMPLEXITY: "A_SIMPLER_VERSION_OF_THE_TASK_FIRST",
  HIGHER_COMPLEXITY: "A_MORE_DEMANDING_VERSION_OF_THE_TASK",
  NEW_CONTEXT: "THE_SAME_STRENGTH_IN_A_DIFFERENT_SETTING",
  ADDITIONAL_EXPOSURE: "MORE_OPPORTUNITIES_TO_MEET_THIS_KIND_OF_WORK",
  TEACHER_SUPPORT: "TIME_WITH_THE_SUBJECT_TEACHER_ON_WHAT_IS_HARD",
  PEER_SUPPORT: "WORKING_ALONGSIDE_A_CLASSMATE",
  REFLECTION: "LOOKING_BACK_AT_WHAT_WENT_WELL_AND_WHAT_DID_NOT",
  REPEAT_OBSERVATION: "ANOTHER_OBSERVATION_SO_THE_RECORD_HAS_MORE_THAN_ONE",
  WAIT_FOR_MORE_EVIDENCE: "LET_THE_NEXT_PERIOD_ADD_EVIDENCE_BEFORE_CHANGING_ANYTHING",
  RESOURCE_SUBSTITUTION: "THE_SAME_AIM_WITH_A_RESOURCE_THAT_IS_AVAILABLE",
});

module.exports = { OBJECTIVES, GUIDANCE_TO_OBJECTIVE, ACTION_EXPLANATIONS };
