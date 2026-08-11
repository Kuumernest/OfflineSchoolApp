// web/src/services/studentApplications.service.ts
import api from "@/services/api";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

export interface ApplicationDocument {
  id?:        string;
  title?:     string;
  name?:      string;
  fileName?:  string;
  uri?:       string | null;
  url?:       string | null;
  fileUrl?:   string | null;
  path?:      string | null;
  type?:      string;
  mimeType?:  string;
}

export interface StudentApplication {
  _id:             string;
  id:              string;
  name:            string;
  email:           string;
  phone:           string;
  guardianName:    string;
  className:       string;
  classId:         string | null;
  class_id:        string | null;
  status:          string;
  address:         string;
  notes:           string;
  schoolId:        string | null;
  documents:       ApplicationDocument[];
  created_at:      string | null;
  updated_at:      string | null;
  admissionNo?:    string | null;
  admissionNumber?: string | null;
  grade?:          string | null;
}

export interface ApproveApplicationResult {
  success:       boolean;
  synced?:       boolean;
  emailSent?:    boolean;
  tempPassword?: string | null;
  warning?:      string | null;
  userId?:       string | null;
  enrollmentNo?: string | null;
  message?:      string | null;  // ✅ added
}

export interface RejectApplicationResult {
  success: boolean;
  synced?: boolean;
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const normalizeDocument = (
  doc: unknown,
  index = 0
): ApplicationDocument | null => {
  if (!doc) return null;

  if (typeof doc === "string") {
    return {
      id:    `doc-${index}`,
      title: `Document ${index + 1}`,
      uri:   doc,
      type:  "document",
    };
  }

  if (typeof doc === "object") {
    const d = doc as Record<string, unknown>;
    return {
      ...d,
      id:    String(d.id    ?? `doc-${index}`),
      title: String(d.title ?? d.name ?? d.fileName ?? `Document ${index + 1}`),
      uri:
        (d.uri     as string) ||
        (d.url     as string) ||
        (d.fileUrl as string) ||
        (d.path    as string) ||
        null,
      type: String(d.type ?? d.mimeType ?? "document"),
    };
  }

  return null;
};

const parseDocuments = (
  raw: Record<string, unknown>
): ApplicationDocument[] => {
  const candidate =
    raw.documents   ??
    raw.document    ??
    raw.docs        ??
    raw.documentUri ??
    raw.documentUrl;

  if (!candidate) return [];

  if (Array.isArray(candidate)) {
    return candidate
      .map((d, i) => normalizeDocument(d, i))
      .filter(Boolean) as ApplicationDocument[];
  }

  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed
          .map((d, i) => normalizeDocument(d, i))
          .filter(Boolean) as ApplicationDocument[];
      }
      return [normalizeDocument(parsed, 0)].filter(
        Boolean
      ) as ApplicationDocument[];
    } catch {
      return [normalizeDocument(candidate, 0)].filter(
        Boolean
      ) as ApplicationDocument[];
    }
  }

  return [normalizeDocument(candidate, 0)].filter(
    Boolean
  ) as ApplicationDocument[];
};

const resolveClassId = (raw: Record<string, unknown>): string | null => {
  if (raw.classId)  return String(raw.classId);
  if (raw.class_id) return String(raw.class_id);

  const cls = raw.class;
  if (typeof cls === "string") return cls;
  if (cls && typeof cls === "object") {
    const c  = cls as Record<string, unknown>;
    const id = c._id || c.id;
    if (id) return String(id);
  }
  return null;
};

const normaliseApplication = (
  raw: Record<string, unknown>
): StudentApplication => {
  const id = String(raw._id ?? raw.id ?? "");

  const name =
    [raw.firstName, raw.lastName]
      .filter(Boolean)
      .map(String)
      .join(" ")
      .trim() ||
    String(
      raw.studentName  ??
      raw.student_name ??
      raw.name         ??
      "Unknown Student"
    );

  const email = String(
    raw.email        ??
    raw.studentEmail ??
    raw.parentEmail  ??
    ""
  )
    .trim()
    .toLowerCase();

  const phone = String(
    raw.phone         ??
    raw.phoneNumber   ??
    raw.phone_number  ??
    raw.parentPhone   ??
    raw.guardianPhone ??
    ""
  ).trim();

  const guardianName = String(
    raw.guardianName  ??
    raw.guardian_name ??
    raw.parentName    ??
    raw.parent_name   ??
    raw.guardian      ??
    ""
  ).trim();

  const classId   = resolveClassId(raw);
  const className = String(
    raw.className  ??
    raw.class_name ??
    raw.grade      ??
    (raw.class &&
      typeof raw.class === "object" &&
      (raw.class as Record<string, unknown>).name) ??
    ""
  ).trim();

  return {
    _id:        id,
    id,
    name,
    email,
    phone,
    guardianName,
    className,
    classId,
    class_id:   classId,
    status:     String(raw.status ?? "pending"),
    address:    String(raw.address ?? raw.homeAddress ?? ""),
    notes:      String(raw.notes   ?? ""),
    schoolId:   raw.schoolId ? String(raw.schoolId) : null,
    documents:  parseDocuments(raw),
    created_at: raw.createdAt  ? String(raw.createdAt)  :
                raw.created_at ? String(raw.created_at) : null,
    updated_at: raw.updatedAt  ? String(raw.updatedAt)  :
                raw.updated_at ? String(raw.updated_at) : null,
    admissionNo:
      raw.admissionNo ? String(raw.admissionNo) : null,
    admissionNumber:
      raw.admissionNumber ? String(raw.admissionNumber) : null,
    grade:
      raw.grade ? String(raw.grade) : null,
  };
};

// ─────────────────────────────────────────────────────────
// API CALLS
// ─────────────────────────────────────────────────────────

export async function fetchPendingApplications(
  schoolId: string
): Promise<StudentApplication[]> {
  const { data } = await api.get("/admin/students/pending", {
    params: schoolId ? { schoolId } : undefined,
  });

  const rawList: Record<string, unknown>[] =
    data?.students ??
    data?.data     ??
    (Array.isArray(data) ? data : []);

  return rawList.map(normaliseApplication);
}

export async function approveApplication(
  applicationId: string,
  classId:       string
): Promise<ApproveApplicationResult> {
  const { data } = await api.put(
    `/admin/students/${applicationId}/approve`,
    { classId }
  );

  return {
    success:      true,
    synced:       data?.synced       ?? true,
    emailSent:    data?.emailSent    ?? false,
    tempPassword: data?.tempPassword ?? null,
    warning:      data?.warning      ?? null,
    userId:       data?.userId       ?? null,
    // ✅ capture enrollment number from both response shapes
    enrollmentNo:
      data?.enrollmentNo ??
      data?.data?.enrollmentNo ??
      null,
    // ✅ capture server message
    message: data?.message ?? null,
  };
}

export async function rejectApplication(
  applicationId: string,
  reason = ""
): Promise<RejectApplicationResult> {
  const { data } = await api.put(
    `/admin/students/${applicationId}/reject`,
    { reason }
  );

  return {
    success: true,
    synced:  data?.synced ?? true,
  };
}