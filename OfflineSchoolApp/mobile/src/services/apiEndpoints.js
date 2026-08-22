// src/services/apiEndpoints.js
// ADD the applications endpoints — everything else unchanged

export const API = {
  auth: {
    login:          "/auth/login",
    logout:         "/auth/logout",
    refresh:        "/auth/refresh",
    me:             "/auth/me",
    changePassword: "/auth/change-password",
  },

  admin: {
    students: {
      list:     "/admin/students",
      pending:  "/admin/students/pending",
      approved: "/admin/students/approved",
      detail:   (id) => `/admin/students/${id}`,
      approve:  (id) => `/admin/students/${id}/approve`,
      reject:   (id) => `/admin/students/${id}/reject`,
      suspend:  (id) => `/admin/students/${id}/suspend`,
      restore:  (id) => `/admin/students/${id}/restore`,
      move:     (id) => `/admin/students/${id}/move`,
      generateEnrollmentNo: (id) => `/admin/students/${id}/enrollment-number`,

      // Approve fallback chain — the backend exposes the approve/reject
      // actions under /admin/students/:id/approve (PUT). Older builds tried
      // /admin/applications and /admin/student-applications first; those
      // paths do not exist, so the students path is now FIRST.
      approveFallbackChain: (id) => [
        `/admin/students/${id}/approve`,
        `/admin/applications/${id}/approve`,
        `/admin/student-applications/${id}/approve`,
      ],

      // Reject fallback chain
      rejectFallbackChain: (id) => [
        `/admin/students/${id}/reject`,
        `/admin/applications/${id}/reject`,
        `/admin/student-applications/${id}/reject`,
      ],
    },

    // ── NEW: dedicated applications collection ──────────────────────────
    applications: {
      // Try these in order — whichever your backend actually exposes
      list:    "/admin/applications",
      pending: "/admin/applications/pending",
      detail:  (id) => `/admin/applications/${id}`,
      approve: (id) => `/admin/applications/${id}/approve`,
      reject:  (id) => `/admin/applications/${id}/reject`,

      // Fallback chain tried automatically by getPendingApplications
      pendingFallbackChain: [
        "/admin/applications/pending",
        "/admin/applications?status=pending",
        "/admin/student-applications/pending",
        "/admin/student-applications?status=pending",
        "/admin/students/applications",
        "/admin/students/pending",          // last resort: students table
      ],

      // Approve fallback chain
      approveFallbackChain: (id) => [
        `/admin/applications/${id}/approve`,
        `/admin/student-applications/${id}/approve`,
        `/admin/students/${id}/approve`,    // last resort: students table
      ],

      // Reject fallback chain
      rejectFallbackChain: (id) => [
        `/admin/applications/${id}/reject`,
        `/admin/student-applications/${id}/reject`,
        `/admin/students/${id}/reject`,
      ],
    },
    // ───────────────────────────────────────────────────────────────────

    teachers: {
      list:          "/admin/teachers",
      detail:        (id) => `/admin/teachers/${id}`,
      resetPassword: (id) => `/admin/teachers/${id}/reset-password`,
    },
    classes: {
      list:         "/admin/classes",
      detail:       (id) => `/admin/classes/${id}`,
      subjects:     (id) => `/admin/classes/${id}/subjects`,
      toggleActive: (id) => `/admin/classes/${id}/toggle-active`,
    },
    subjects: {
      list:   "/admin/subjects",
      detail: (id) => `/admin/subjects/${id}`,
    },
    assignments: {
      list:   "/admin/teacher-assignments",
      bulk:   "/admin/teacher-assignments/bulk",
      detail: (id) => `/admin/teacher-assignments/${id}`,
    },
    timetable: {
      list:      "/admin/timetable",
      detail:    (id)        => `/admin/timetable/${id}`,
      byTeacher: (teacherId) => `/admin/timetable/teacher/${teacherId}`,
    },
    periods: {
      list:   "/admin/periods",
      detail: (id) => `/admin/periods/${id}`,
    },
    templates: {
      list:   "/templates",
      detail: (id) => `/templates/${id}`,
    },
    results: {
      list:              "/admin/results",
      detail:            (id)                  => `/admin/results/${id}`,
      byStudent:         (examId, studentId)   => `/results/${examId}/student/${studentId}`,
      byStudentFallback: (studentId, schoolId) =>
        `/results?studentId=${studentId}&schoolId=${schoolId}`,
    },
    reports: {
      list:   "/admin/reports",
      detail: (id) => `/admin/reports/${id}`,
    },
    school:    "/admin/school-info",
    stats:     "/admin/stats",
    grading:   "/admin/settings/grading",
    admins:    "/admin/settings/admins",
    analytics: "/admin/settings/analytics",
  },

  teacher: {
    profile:       "/teacher/profile",
    myAssignments: "/teacher/my-assignments",
    mySubjects:    "/teacher/my-subjects",
    myWorkload:    "/teacher/my-workload",
    myTimetable:   "/teacher/my-timetable",
    myStudents:    "/teacher/my-students",
    announcements: "/teacher/announcements",
    results: {
      list:      "/teacher/results",
      examMarks: "/teacher/exam-marks",
      quizzes:   "/teacher/quiz-results",
    },
  },

  student: {
    me:             "/students/me",
    profile:        "/students/profile",
    announcements:  "/students/announcements",
    apply:          "/students/apply",
    appStatus:      (id) => `/students/application-status/${id}`,
    subjectContent: "/students/subject-content",
    // Student-scoped: the server takes the class from the signed-in student's
    // own record. Without this key the role-aware chooser in timetableService
    // fell through to the admin endpoint and took a 403 on every open.
    timetable:      "/students/timetable",
    results: {
      list:   "/students/results",
      detail: (id) => `/students/results/${id}`,
    },
  },

  results: {
    list:          "/results",
    detail:        (id)                => `/results/${id}`,
    byExamStudent: (examId, studentId) => `/results/${examId}/student/${studentId}`,
    byStudent:     (studentId)         => `/results?studentId=${studentId}`,
  },

  public: {
    schools:    "/public/schools",
    schoolById: (id) => `/public/schools/${id}`,
    apply:      "/public/students/apply",
    applyDocs:  (id) => `/public/students/apply/${id}/documents`,
  },

  sync: {
    pull: "/sync/pull",
    push: "/sync/push",
  },

  announcements: {
    list:        "/announcements",
    detail:      (id) => `/announcements/${id}`,
    markRead:    (id) => `/announcements/${id}/read`,
    acknowledge: (id) => `/announcements/${id}/acknowledge`,
  },

  quiz: {
    list:      "/quiz/quizzes",
    detail:    (id) => `/quiz/quizzes/${id}`,
    questions: "/quiz/questions",
    question:  (id) => `/quiz/questions/${id}`,
    attempts:  "/quiz/attempts",
    sync:      "/quiz/sync",
  },
};

export const callWithFallback = async (
  apiInstance,
  method,
  endpoints,
  options = {}
) => {
  const endpointList = Array.isArray(endpoints) ? endpoints : [endpoints];
  const { data: requestBody, ...axiosConfig } = options;
  let lastError;

  for (const endpoint of endpointList) {
    try {
      const m = method.toLowerCase();
      switch (m) {
        case "get":    return await apiInstance.get(endpoint, axiosConfig);
        case "post":   return await apiInstance.post(endpoint, requestBody ?? null, axiosConfig);
        case "put":    return await apiInstance.put(endpoint, requestBody ?? null, axiosConfig);
        case "patch":  return await apiInstance.patch(endpoint, requestBody ?? null, axiosConfig);
        case "delete": return await apiInstance.delete(endpoint, axiosConfig);
        default: throw new Error(`[callWithFallback] Unknown HTTP method: "${method}"`);
      }
    } catch (err) {
      lastError = err;
      if (err?.response?.status !== 404) throw err;
      console.warn(`[api] callWithFallback: ${endpoint} → 404, trying next endpoint…`);
    }
  }

  throw lastError ??
    new Error(`[callWithFallback] All endpoints failed: ${endpointList.join(", ")}`);
};