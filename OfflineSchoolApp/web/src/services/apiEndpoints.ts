// web/src/services/apiEndpoints.ts
"use strict";

import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FallbackOptions extends Omit<AxiosRequestConfig, "data"> {
  data?: unknown;
}

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
      detail:   (id: string): string => `/admin/students/${id}`,
      approve:  (id: string): string => `/admin/students/${id}/approve`,
      reject:   (id: string): string => `/admin/students/${id}/reject`,
      suspend:  (id: string): string => `/admin/students/${id}/suspend`,
      restore:  (id: string): string => `/admin/students/${id}/restore`,
      move:     (id: string): string => `/admin/students/${id}/move`,
      generateEnrollmentNo: (id: string): string =>
        `/admin/students/${id}/enrollment-number`,
    },
    teachers: {
      list:          "/admin/teachers",
      detail:        (id: string): string => `/admin/teachers/${id}`,
      resetPassword: (id: string): string => `/admin/teachers/${id}/reset-password`,
    },
    classes: {
      list:         "/admin/classes",
      detail:       (id: string): string => `/admin/classes/${id}`,
      subjects:     (id: string): string => `/admin/classes/${id}/subjects`,
      toggleActive: (id: string): string => `/admin/classes/${id}/toggle-active`,
    },
    subjects: {
      list:   "/admin/subjects",
      detail: (id: string): string => `/admin/subjects/${id}`,
    },
    assignments: {
      list:   "/admin/teacher-assignments",
      bulk:   "/admin/teacher-assignments/bulk",
      detail: (id: string): string => `/admin/teacher-assignments/${id}`,
    },
    timetable: {
      list:      "/admin/timetable",
      detail:    (id: string): string        => `/admin/timetable/${id}`,
      byTeacher: (teacherId: string): string => `/admin/timetable/teacher/${teacherId}`,
    },
    periods: {
      list:   "/admin/periods",
      detail: (id: string): string => `/admin/periods/${id}`,
    },
    templates: {
      list:   "/templates",
      detail: (id: string): string => `/templates/${id}`,
    },
    results: {
      list:              "/admin/results",
      detail:            (id: string): string                          => `/admin/results/${id}`,
      byStudent:         (examId: string, studentId: string): string   => `/results/${examId}/student/${studentId}`,
      byStudentFallback: (studentId: string, schoolId: string): string =>
        `/results?studentId=${studentId}&schoolId=${schoolId}`,
    },
    reports: {
      list:   "/admin/reports",
      detail: (id: string): string => `/admin/reports/${id}`,
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
    appStatus:      (id: string): string => `/students/application-status/${id}`,
    subjectContent: "/students/subject-content",
    results: {
      list:   "/students/results",
      detail: (id: string): string => `/students/results/${id}`,
    },
  },

  results: {
    list:          "/results",
    detail:        (id: string): string                        => `/results/${id}`,
    byExamStudent: (examId: string, studentId: string): string => `/results/${examId}/student/${studentId}`,
    byStudent:     (studentId: string): string                 => `/results?studentId=${studentId}`,
  },

  public: {
    schools:    "/public/schools",
    schoolById: (id: string): string => `/public/schools/${id}`,
    apply:      "/public/students/apply",
    applyDocs:  (id: string): string => `/public/students/apply/${id}/documents`,
  },

  sync: {
    pull: "/sync/pull",
    push: "/sync/push",
  },

  announcements: {
    list:        "/announcements",
    detail:      (id: string): string => `/announcements/${id}`,
    markRead:    (id: string): string => `/announcements/${id}/read`,
    acknowledge: (id: string): string => `/announcements/${id}/acknowledge`,
  },

  quiz: {
    list:      "/quiz/quizzes",
    detail:    (id: string): string => `/quiz/quizzes/${id}`,
    questions: "/quiz/questions",
    question:  (id: string): string => `/quiz/questions/${id}`,
    attempts:  "/quiz/attempts",
    sync:      "/quiz/sync",
  },
} as const;

export const callWithFallback = async <T = unknown>(
  apiInstance: AxiosInstance,
  method:      HttpMethod,
  endpoints:   string | string[],
  options:     FallbackOptions = {},
): Promise<AxiosResponse<T>> => {
  const endpointList = Array.isArray(endpoints) ? endpoints : [endpoints];
  const { data: requestBody, ...axiosConfig } = options;
  let lastError: unknown;

  for (const endpoint of endpointList) {
    try {
      const m = method.toLowerCase() as Lowercase<HttpMethod>;
      switch (m) {
        case "get":    return await apiInstance.get<T>(endpoint, axiosConfig);
        case "post":   return await apiInstance.post<T>(endpoint, requestBody ?? null, axiosConfig);
        case "put":    return await apiInstance.put<T>(endpoint, requestBody ?? null, axiosConfig);
        case "patch":  return await apiInstance.patch<T>(endpoint, requestBody ?? null, axiosConfig);
        case "delete": return await apiInstance.delete<T>(endpoint, axiosConfig);
        default: {
          const _never: never = m;
          throw new Error(`[callWithFallback] Unknown HTTP method: "${_never}"`);
        }
      }
    } catch (err: unknown) {
      lastError = err;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 404) throw err;
      console.warn(`[api] callWithFallback: ${endpoint} → 404, trying next endpoint…`);
    }
  }

  throw (
    lastError ??
    new Error(`[callWithFallback] All endpoints failed: ${endpointList.join(", ")}`)
  );
};