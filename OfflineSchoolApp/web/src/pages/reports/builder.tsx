// web/src/pages/reports/builder.tsx
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import api              from "@/services/api";
import { getErrorMessage } from "@/lib/axios";
import {
  ArrowLeft, Save, Loader2, Code2,
  Palette, List, Star, Eye,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast }       from "@/components/ui/Toast";

// ─────────────────────────────────────────────────────────
// VARIABLE REFERENCE
// ─────────────────────────────────────────────────────────

// `key` is the placeholder token the render engine looks for and the exact
// text inserted into the template — it is never translated. Module scope has
// no `t`, so group names and descriptions are held as keys and resolved at
// render time.
const VARIABLE_GROUPS = [
  {
    labelKey: "builder.varGroups.student",
    vars: [
      { key: "{{student_name}}",     labelKey: "builder.vars.studentName"      },
      { key: "{{admission_number}}", labelKey: "builder.vars.admissionNumber"  },
      { key: "{{gender}}",           labelKey: "builder.vars.gender"           },
      { key: "{{date_of_birth}}",    labelKey: "builder.vars.dateOfBirth"      },
      { key: "{{class}}",            labelKey: "builder.vars.className"        },
      { key: "{{stream}}",           labelKey: "builder.vars.stream"           },
      { key: "{{student_photo}}",    labelKey: "builder.vars.studentPhoto"     },
    ],
  },
  {
    labelKey: "builder.varGroups.exam",
    vars: [
      { key: "{{term}}",          labelKey: "builder.vars.term"         },
      { key: "{{academic_year}}", labelKey: "builder.vars.academicYear" },
    ],
  },
  {
    labelKey: "builder.varGroups.performance",
    vars: [
      { key: "{{average}}",          labelKey: "builder.vars.average"         },
      { key: "{{grade}}",            labelKey: "builder.vars.grade"           },
      { key: "{{remark}}",           labelKey: "builder.vars.remark"          },
      { key: "{{position}}",         labelKey: "builder.vars.position"        },
      { key: "{{total_students}}",   labelKey: "builder.vars.totalStudents"   },
      { key: "{{promotion_status}}", labelKey: "builder.vars.promotionStatus" },
    ],
  },
  {
    labelKey: "builder.varGroups.termResults",
    vars: [
      { key: "{{term_average}}",          labelKey: "builder.vars.termAverage"          },
      { key: "{{term_grade}}",            labelKey: "builder.vars.termGrade"            },
      { key: "{{term_remark}}",           labelKey: "builder.vars.termRemark"           },
      { key: "{{term_class_position}}",   labelKey: "builder.vars.termClassPosition"    },
      { key: "{{term_total_in_class}}",   labelKey: "builder.vars.termTotalInClass"     },
      { key: "{{sequence_1_average}}",    labelKey: "builder.vars.sequence1Average"     },
      { key: "{{sequence_2_average}}",    labelKey: "builder.vars.sequence2Average"     },
      { key: "{{sequence_3_average}}",    labelKey: "builder.vars.sequence3Average"     },
      { key: "{{sequence_4_average}}",    labelKey: "builder.vars.sequence4Average"     },
      { key: "{{sequence_5_average}}",    labelKey: "builder.vars.sequence5Average"     },
      { key: "{{sequence_6_average}}",    labelKey: "builder.vars.sequence6Average"     },
    ],
  },
  {
    labelKey: "builder.varGroups.annualResults",
    vars: [
      { key: "{{annual_average}}",        labelKey: "builder.vars.annualAverage"        },
      { key: "{{annual_grade}}",          labelKey: "builder.vars.annualGrade"          },
      { key: "{{annual_remark}}",         labelKey: "builder.vars.annualRemark"         },
      { key: "{{annual_class_position}}", labelKey: "builder.vars.annualClassPosition"  },
      { key: "{{annual_total_in_class}}", labelKey: "builder.vars.annualTotalInClass"   },
      { key: "{{term_1_average}}",        labelKey: "builder.vars.term1Average"         },
      { key: "{{term_2_average}}",        labelKey: "builder.vars.term2Average"         },
      { key: "{{term_3_average}}",        labelKey: "builder.vars.term3Average"         },
    ],
  },
  {
    labelKey: "builder.varGroups.attendance",
    vars: [
      { key: "{{days_present}}",       labelKey: "builder.vars.daysPresent"       },
      { key: "{{days_absent}}",        labelKey: "builder.vars.daysAbsent"        },
      { key: "{{days_open}}",          labelKey: "builder.vars.daysOpen"          },
      { key: "{{attendance_percent}}", labelKey: "builder.vars.attendancePercent" },
    ],
  },
  {
    labelKey: "builder.varGroups.school",
    vars: [
      { key: "{{school_name}}",    labelKey: "builder.vars.schoolName"    },
      { key: "{{school_motto}}",   labelKey: "builder.vars.schoolMotto"   },
      { key: "{{school_address}}", labelKey: "builder.vars.schoolAddress" },
      { key: "{{school_phone}}",   labelKey: "builder.vars.schoolPhone"   },
      { key: "{{school_logo}}",    labelKey: "builder.vars.schoolLogo"    },
    ],
  },
  {
    labelKey: "builder.varGroups.staff",
    vars: [
      { key: "{{principal_name}}",    labelKey: "builder.vars.principalName"    },
      { key: "{{class_teacher}}",     labelKey: "builder.vars.classTeacher"     },
      { key: "{{teacher_comment}}",   labelKey: "builder.vars.teacherComment"   },
      { key: "{{principal_comment}}", labelKey: "builder.vars.principalComment" },
    ],
  },
  {
    labelKey: "builder.varGroups.tables",
    vars: [
      { key: "{{subjects_table}}",   labelKey: "builder.vars.subjectsTable"   },
      { key: "{{attendance_table}}", labelKey: "builder.vars.attendanceTable" },
    ],
  },
  {
    labelKey: "builder.varGroups.subjectsLoop",
    vars: [
      { key: "{{each subjects}}",     labelKey: "builder.vars.eachSubjects"  },
      { key: "{{subject.name}}",      labelKey: "builder.vars.subjectName"   },
      { key: "{{subject.caScore}}",   labelKey: "builder.vars.subjectCa"     },
      { key: "{{subject.examScore}}", labelKey: "builder.vars.subjectExam"   },
      { key: "{{subject.total}}",     labelKey: "builder.vars.subjectTotal"  },
      { key: "{{subject.grade}}",     labelKey: "builder.vars.subjectGrade"  },
      { key: "{{subject.remark}}",    labelKey: "builder.vars.subjectRemark" },
      { key: "{{/each}}",             labelKey: "builder.vars.endEach"       },
    ],
  },
  {
    labelKey: "builder.varGroups.conditionals",
    vars: [
      { key: "{{if isPassing}}",   labelKey: "builder.vars.ifPassing"   },
      { key: "{{if isRepeating}}", labelKey: "builder.vars.ifRepeating" },
      { key: "{{else}}",           labelKey: "builder.vars.elseBranch"  },
      { key: "{{endif}}",          labelKey: "builder.vars.endif"       },
    ],
  },
  {
    labelKey: "builder.varGroups.extras",
    vars: [
      { key: "{{qr_code}}",        labelKey: "builder.vars.qrCode"       },
      { key: "{{report_date}}",    labelKey: "builder.vars.reportDate"   },
      { key: "{{next_term_date}}", labelKey: "builder.vars.nextTermDate" },
    ],
  },
];

// ─────────────────────────────────────────────────────────
// STARTER TEMPLATE
// ─────────────────────────────────────────────────────────

/** The default layout a school starts from; tokens stay untouched. */
const buildStarterHtml = (t: (key: string) => string) => `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px;">

  <!-- School Header -->
  <div style="text-align: center; border-bottom: 2px solid #2563EB; padding-bottom: 16px; margin-bottom: 16px;">
    {{school_logo}}
    <h1 style="color: #1E40AF; margin: 8px 0 4px;">{{school_name}}</h1>
    <p style="color: #6B7280; font-style: italic; margin: 0;">{{school_motto}}</p>
    <h2 style="color: #2563EB; margin: 12px 0 0; font-size: 14px; letter-spacing: 2px;">
      ${t("builder.tplTitle")}
    </h2>
    <p style="margin: 4px 0; color: #374151; font-size: 13px;">
      {{term}} &mdash; {{academic_year}}
    </p>
  </div>

  <!-- Student Info -->
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <tr>
      <td style="padding: 6px; color: #6B7280; width: 140px; font-size: 12px;">${t("builder.tplStudentName")}</td>
      <td style="padding: 6px; font-weight: bold;">{{student_name}}</td>
      <td style="padding: 6px; color: #6B7280; width: 140px; font-size: 12px;">${t("builder.tplAdmissionNo")}</td>
      <td style="padding: 6px; font-weight: bold;">{{admission_number}}</td>
    </tr>
    <tr>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">Class</td>
      <td style="padding: 6px; font-weight: bold;">{{class}} {{stream}}</td>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">Gender</td>
      <td style="padding: 6px;">{{gender}}</td>
    </tr>
    <tr>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">${t("builder.tplClassTeacher")}</td>
      <td style="padding: 6px;">{{class_teacher}}</td>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">${t("builder.tplDob")}</td>
      <td style="padding: 6px;">{{date_of_birth}}</td>
    </tr>
  </table>

  <!-- Subjects Table -->
  <h3 style="font-size: 13px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; margin-bottom: 8px;">
    ${t("builder.tplPerformance")}
  </h3>
  {{subjects_table}}

  <!-- Summary -->
  <div style="display: flex; gap: 12px; margin: 16px 0;">
    <div style="flex: 1; text-align: center; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px;">
      <div style="font-size: 22px; font-weight: bold; color: #2563EB;">{{average}}</div>
      <div style="font-size: 10px; color: #6B7280; margin-top: 2px;">Average</div>
    </div>
    <div style="flex: 1; text-align: center; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px;">
      <div style="font-size: 22px; font-weight: bold; color: #7C3AED;">{{grade}}</div>
      <div style="font-size: 10px; color: #6B7280; margin-top: 2px;">Grade</div>
    </div>
    <div style="flex: 1; text-align: center; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px;">
      <div style="font-size: 22px; font-weight: bold; color: #059669;">
        {{position}} / {{total_students}}
      </div>
      <div style="font-size: 10px; color: #6B7280; margin-top: 2px;">Position</div>
    </div>
    <div style="flex: 1; text-align: center; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px;">
      <div style="font-size: 22px; font-weight: bold; color: #D97706;">{{promotion_status}}</div>
      <div style="font-size: 10px; color: #6B7280; margin-top: 2px;">Status</div>
    </div>
  </div>

  <!-- Attendance -->
  <h3 style="font-size: 13px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; margin-bottom: 8px;">
    Attendance
  </h3>
  <div style="display: flex; gap: 12px; margin-bottom: 16px;">
    <div style="flex: 1; background: #F9FAFB; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
      ${t("builder.tplDaysOpen")} <strong>{{days_open}}</strong>
    </div>
    <div style="flex: 1; background: #F9FAFB; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
      ${t("builder.tplPresent")} <strong>{{days_present}}</strong>
    </div>
    <div style="flex: 1; background: #F9FAFB; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
      ${t("builder.tplAbsent")} <strong>{{days_absent}}</strong>
    </div>
    <div style="flex: 1; background: #F9FAFB; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
      ${t("builder.tplRate")} <strong>{{attendance_percent}}</strong>
    </div>
  </div>

  <!-- Comments -->
  <div style="display: flex; gap: 16px; margin-bottom: 16px;">
    <div style="flex: 1; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px;">
      <div style="font-size: 11px; font-weight: bold; color: #6B7280; margin-bottom: 6px;">
        ${t("builder.tplTeacherRemark")}
      </div>
      <p style="margin: 0; font-size: 12px; color: #374151;">{{teacher_comment}}</p>
      <div style="margin-top: 20px; border-top: 1px solid #9CA3AF; padding-top: 4px;
                  font-size: 10px; color: #9CA3AF;">
        Signature: _______________________
      </div>
    </div>
    <div style="flex: 1; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px;">
      <div style="font-size: 11px; font-weight: bold; color: #6B7280; margin-bottom: 6px;">
        ${t("builder.tplPrincipalRemark")}
      </div>
      <p style="margin: 0; font-size: 12px; color: #374151;">{{principal_comment}}</p>
      <div style="margin-top: 20px; border-top: 1px solid #9CA3AF; padding-top: 4px;
                  font-size: 10px; color: #9CA3AF;">
        Signature: _______________________
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div style="display: flex; justify-content: space-between; align-items: flex-end;
              border-top: 1px solid #E5E7EB; padding-top: 12px; margin-top: 8px;">
    <div>{{qr_code}}</div>
    <div style="text-align: right; font-size: 11px; color: #6B7280;">
      <p style="margin: 0;">${t("builder.tplNextTerm")} <strong>{{next_term_date}}</strong></p>
      <p style="margin: 4px 0 0;">Report Generated: {{report_date}}</p>
    </div>
  </div>

</div>`;

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

type Tab = "html" | "css" | "vars" | "preview";

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function TemplateBuilderPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate    = useNavigate();
  const [params]    = useSearchParams();
  const user        = useAuthStore((s) => s.user);
  const schoolId    = user?.schoolId;

  const templateId = params.get("id");
  const isEditing  = !!templateId;

  const [name,      setName]      = useState("");
  const [html,      setHtml]      = useState(() => buildStarterHtml(t));
  const [css,       setCss]       = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("html");
  const [loading,   setLoading]   = useState(isEditing);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  // Tokens the render engine does not know. The template saved fine; these
  // would print as literal braces on a report card.
  const [unknownTokens, setUnknownTokens] = useState<string[]>([]);

  // ── Load existing ──────────────────────────────────────

  useEffect(() => {
    if (!templateId) return;
    api.get(`/templates/${templateId}`, { params: { schoolId } })
      .then((res) => {
        const tmpl = res.data?.template || res.data?.data || res.data;
        setName(tmpl.name           || "");
        setHtml(tmpl.html           || buildStarterHtml(t));
        setCss(tmpl.css             || "");
        setIsDefault(tmpl.isDefault || false);
      })
      .catch((err) => {
        setError(err?.response?.data?.error || err.message);
      })
      .finally(() => setLoading(false));
  }, [templateId, schoolId]);

  // ── Save ───────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast({ kind: "warning", title: t("builder.nameRequired") });
      return;
    }
    if (!html.trim()) {
      toast({ kind: "warning", title: t("builder.htmlRequired") });
      return;
    }

    setSaving(true);
    setError(null);
    setUnknownTokens([]);
    try {
      const body = { schoolId, name: name.trim(), html, css, isDefault };
      const res  = isEditing
        ? await api.put(`/templates/${templateId}`, body)
        : await api.post("/templates", body);

      // Saved either way. But if the engine cannot resolve a token, keep the
      // author here so they can fix the typo now — navigating away would hide
      // the only warning they get before it reaches a parent.
      const unknown: string[] = res.data?.unknownTokens ?? [];
      if (unknown.length) {
        setUnknownTokens(unknown);
        return;
      }

      navigate("/reports/templates");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [name, html, css, isDefault, isEditing, templateId, schoolId, navigate, t]);

  // ── Keyboard shortcut Ctrl/Cmd + S ────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // ─────────────────────────────────────────────────────────
  // RENDER — Loading
  // ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 size={36} className="animate-spin text-blue-600" />
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER — Main
  // ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex
                      items-center gap-4 shrink-0">
        <button
          onClick={() => navigate("/reports/templates")}
          className="w-9 h-9 flex items-center justify-center rounded-xl
                     bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          <ArrowLeft size={20} className="text-gray-700" />
        </button>

        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900">
            {isEditing ? t("builder.editTemplate") : t("templates.new")}
          </h1>
          <p className="text-xs text-gray-500">{t("builder.title")}</p>
        </div>

        {/* Name input */}
        <input
          type="text"
          placeholder={t("builder.namePh")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm
                     text-gray-900 w-56 focus:outline-none focus:ring-2
                     focus:ring-blue-500 focus:border-transparent"
        />

        {/* Default toggle */}
        <button
          onClick={() => setIsDefault((v) => !v)}
          className={`
            flex items-center gap-1.5 text-sm font-semibold px-3 py-2
            rounded-lg border transition-colors
            ${isDefault
              ? "border-blue-300 bg-blue-50 text-blue-600"
              : "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100"}
          `}
        >
          <Star
            size={14}
            className={isDefault ? "fill-blue-500 text-blue-500" : ""}
          />
          {t("common.default")}
        </button>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700
                     disabled:opacity-60 text-white text-sm font-semibold
                     px-4 py-2 rounded-lg transition-colors"
        >
          {saving
            ? <Loader2 size={15} className="animate-spin" />
            : <Save size={15} />
          }
          {saving ? t("common.saving") : t("common.save")}
          <span className="text-green-300 text-xs hidden md:inline">⌘S</span>
        </button>
      </div>

      {/* Error bar */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2
                        text-sm text-red-700 flex items-center gap-2">
          <span className="font-semibold">{t("builder.errorLabel")}</span>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-500 hover:text-red-700 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Unknown-token warning */}
      {unknownTokens.length > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2
                        text-sm text-amber-800 flex items-start gap-2">
          <span className="font-semibold shrink-0">{t("builder.savedBut")}</span>
          <span>
            {t("builder.unknownToken", { count: unknownTokens.length })}{" "}
            {unknownTokens.map((tok) => (
              <code
                key={tok}
                className="bg-amber-100 px-1 rounded font-mono text-xs mr-1"
              >
                {tok}
              </code>
            ))}
          </span>
          <button
            onClick={() => navigate("/reports/templates")}
            className="ml-auto shrink-0 text-amber-800 underline font-medium"
          >
            {t("builder.continueAnyway")}
          </button>
          <button
            onClick={() => setUnknownTokens([])}
            className="shrink-0 text-amber-600 hover:text-amber-800 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="bg-white border-b border-gray-200 px-6 flex shrink-0">
        {(
          [
            // "HTML" and "CSS" are format names, identical in both languages.
            { id: "html",    label: "HTML",                 Icon: Code2   },
            { id: "css",     label: "CSS",                  Icon: Palette },
            { id: "vars",    label: t("builder.variables"), Icon: List    },
            { id: "preview", label: t("common.preview"),    Icon: Eye     },
          ] as { id: Tab; label: string; Icon: LucideIcon }[]
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`
              flex items-center gap-1.5 px-4 py-3 text-sm font-semibold
              border-b-2 transition-colors
              ${activeTab === id
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"}
            `}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">

        {/* HTML editor */}
        {activeTab === "html" && (
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            spellCheck={false}
            className="w-full h-full p-6 font-mono text-sm text-gray-900
                       bg-gray-50 resize-none focus:outline-none leading-relaxed"
            placeholder={t("builder.htmlPh")}
            style={{ minHeight: "calc(100vh - 180px)" }}
          />
        )}

        {/* CSS editor */}
        {activeTab === "css" && (
          <textarea
            value={css}
            onChange={(e) => setCss(e.target.value)}
            spellCheck={false}
            className="w-full h-full p-6 font-mono text-sm text-gray-900
                       bg-gray-50 resize-none focus:outline-none leading-relaxed"
            placeholder={t("builder.cssPh")}
            style={{ minHeight: "calc(100vh - 180px)" }}
          />
        )}

        {/* Variables reference */}
        {activeTab === "vars" && (
          <div
            className="h-full overflow-y-auto p-6 space-y-6"
            style={{ maxHeight: "calc(100vh - 180px)" }}
          >
            <p className="text-sm text-gray-500 italic">
              {t("builder.clickPlaceholder")}
            </p>
            {VARIABLE_GROUPS.map((group) => (
              <div key={group.labelKey}>
                <h3 className="text-xs font-bold text-gray-500 uppercase
                               tracking-wider mb-2">
                  {t(group.labelKey)}
                </h3>
                <div className="space-y-1">
                  {group.vars.map((v) => (
                    <button
                      key={v.key}
                      onClick={() => {
                        setHtml((prev) => prev + v.key);
                        setActiveTab("html");
                      }}
                      className="w-full flex items-center gap-3 bg-white border
                                 border-gray-200 rounded-lg px-3 py-2.5
                                 hover:border-blue-300 hover:bg-blue-50
                                 transition-colors text-left group"
                    >
                      <code className="text-blue-600 text-xs font-mono min-w-[200px]">
                        {v.key}
                      </code>
                      <span className="text-gray-500 text-xs flex-1">
                        {t(v.labelKey)}
                      </span>
                      <span className="text-blue-400 text-xs opacity-0
                                       group-hover:opacity-100 transition-opacity">
                        + {t("builder.insert")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Live preview */}
        {activeTab === "preview" && (
          <div
            className="h-full flex flex-col"
            style={{ maxHeight: "calc(100vh - 180px)" }}
          >
            <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-2
                            text-xs text-yellow-700 flex items-center gap-2">
              <span className="font-semibold">{t("builder.layoutPreview")}</span>
              {" — "}{t("builder.previewNote")}
            </div>
            <iframe
              srcDoc={`
                <!DOCTYPE html>
                <html>
                <head>
                  <meta charset="UTF-8">
                  <style>${css}</style>
                </head>
                <body>${html}</body>
                </html>
              `}
              className="flex-1 w-full border-0"
              sandbox="allow-same-origin"
              title={t("builder.templatePreview")}
            />
          </div>
        )}
      </div>
    </div>
  );
}