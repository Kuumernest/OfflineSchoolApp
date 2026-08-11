// web/src/pages/reports/builder.tsx
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import api              from "@/services/api";
import {
  ArrowLeft, Save, Loader2, Code2,
  Palette, List, Star, Eye,
} from "lucide-react";

// ─────────────────────────────────────────────────────────
// VARIABLE REFERENCE
// ─────────────────────────────────────────────────────────

const VARIABLE_GROUPS = [
  {
    group: "Student",
    vars: [
      { key: "{{student_name}}",     desc: "Full name"         },
      { key: "{{admission_number}}", desc: "Admission number"  },
      { key: "{{gender}}",           desc: "Gender"            },
      { key: "{{date_of_birth}}",    desc: "Date of birth"     },
      { key: "{{class}}",            desc: "Class name"        },
      { key: "{{stream}}",           desc: "Stream or section" },
      { key: "{{student_photo}}",    desc: "Passport photo"    },
    ],
  },
  {
    group: "Exam",
    vars: [
      { key: "{{term}}",          desc: "Term"          },
      { key: "{{academic_year}}", desc: "Academic year" },
    ],
  },
  {
    group: "Performance",
    vars: [
      { key: "{{average}}",          desc: "Average score"       },
      { key: "{{grade}}",            desc: "Overall grade"       },
      { key: "{{remark}}",           desc: "Overall remark"      },
      { key: "{{position}}",         desc: "Position in class"   },
      { key: "{{total_students}}",   desc: "Total in class"      },
      { key: "{{promotion_status}}", desc: "Promoted / Repeated" },
    ],
  },
  {
    group: "Attendance",
    vars: [
      { key: "{{days_present}}",       desc: "Days present"          },
      { key: "{{days_absent}}",        desc: "Days absent"           },
      { key: "{{days_open}}",          desc: "Total school days"     },
      { key: "{{attendance_percent}}", desc: "Attendance percentage" },
    ],
  },
  {
    group: "School",
    vars: [
      { key: "{{school_name}}",    desc: "School name"    },
      { key: "{{school_motto}}",   desc: "School motto"   },
      { key: "{{school_address}}", desc: "School address" },
      { key: "{{school_phone}}",   desc: "Phone number"   },
      { key: "{{school_logo}}",    desc: "School logo"    },
    ],
  },
  {
    group: "Staff",
    vars: [
      { key: "{{principal_name}}",    desc: "Principal name"     },
      { key: "{{class_teacher}}",     desc: "Class teacher name" },
      { key: "{{teacher_comment}}",   desc: "Teacher comment"    },
      { key: "{{principal_comment}}", desc: "Principal comment"  },
    ],
  },
  {
    group: "Tables",
    vars: [
      { key: "{{subjects_table}}",   desc: "Full subjects table — auto-generated" },
      { key: "{{attendance_table}}", desc: "Monthly attendance table"             },
    ],
  },
  {
    group: "Subjects Loop",
    vars: [
      { key: "{{each subjects}}",     desc: "Start loop over subjects" },
      { key: "{{subject.name}}",      desc: "Subject name (in loop)"   },
      { key: "{{subject.caScore}}",   desc: "CA score (in loop)"       },
      { key: "{{subject.examScore}}", desc: "Exam score (in loop)"     },
      { key: "{{subject.total}}",     desc: "Total score (in loop)"    },
      { key: "{{subject.grade}}",     desc: "Grade (in loop)"          },
      { key: "{{subject.remark}}",    desc: "Remark (in loop)"         },
      { key: "{{/each}}",             desc: "End loop"                 },
    ],
  },
  {
    group: "Conditionals",
    vars: [
      { key: "{{if isPassing}}",   desc: "Show if student is passing"   },
      { key: "{{if isRepeating}}", desc: "Show if student is repeating" },
      { key: "{{else}}",           desc: "Else branch"                  },
      { key: "{{endif}}",          desc: "End conditional"              },
    ],
  },
  {
    group: "Extras",
    vars: [
      { key: "{{qr_code}}",        desc: "QR code placeholder"   },
      { key: "{{report_date}}",    desc: "Date report generated" },
      { key: "{{next_term_date}}", desc: "Next term start date"  },
    ],
  },
];

// ─────────────────────────────────────────────────────────
// STARTER TEMPLATE
// ─────────────────────────────────────────────────────────

const STARTER_HTML = `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px;">

  <!-- School Header -->
  <div style="text-align: center; border-bottom: 2px solid #2563EB; padding-bottom: 16px; margin-bottom: 16px;">
    {{school_logo}}
    <h1 style="color: #1E40AF; margin: 8px 0 4px;">{{school_name}}</h1>
    <p style="color: #6B7280; font-style: italic; margin: 0;">{{school_motto}}</p>
    <h2 style="color: #2563EB; margin: 12px 0 0; font-size: 14px; letter-spacing: 2px;">
      STUDENT REPORT CARD
    </h2>
    <p style="margin: 4px 0; color: #374151; font-size: 13px;">
      {{term}} &mdash; {{academic_year}}
    </p>
  </div>

  <!-- Student Info -->
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <tr>
      <td style="padding: 6px; color: #6B7280; width: 140px; font-size: 12px;">Student Name</td>
      <td style="padding: 6px; font-weight: bold;">{{student_name}}</td>
      <td style="padding: 6px; color: #6B7280; width: 140px; font-size: 12px;">Admission No</td>
      <td style="padding: 6px; font-weight: bold;">{{admission_number}}</td>
    </tr>
    <tr>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">Class</td>
      <td style="padding: 6px; font-weight: bold;">{{class}} {{stream}}</td>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">Gender</td>
      <td style="padding: 6px;">{{gender}}</td>
    </tr>
    <tr>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">Class Teacher</td>
      <td style="padding: 6px;">{{class_teacher}}</td>
      <td style="padding: 6px; color: #6B7280; font-size: 12px;">Date of Birth</td>
      <td style="padding: 6px;">{{date_of_birth}}</td>
    </tr>
  </table>

  <!-- Subjects Table -->
  <h3 style="font-size: 13px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; margin-bottom: 8px;">
    Academic Performance
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
      Days Open: <strong>{{days_open}}</strong>
    </div>
    <div style="flex: 1; background: #F9FAFB; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
      Present: <strong>{{days_present}}</strong>
    </div>
    <div style="flex: 1; background: #F9FAFB; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
      Absent: <strong>{{days_absent}}</strong>
    </div>
    <div style="flex: 1; background: #F9FAFB; border-radius: 6px; padding: 8px 12px; font-size: 12px;">
      Rate: <strong>{{attendance_percent}}</strong>
    </div>
  </div>

  <!-- Comments -->
  <div style="display: flex; gap: 16px; margin-bottom: 16px;">
    <div style="flex: 1; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px;">
      <div style="font-size: 11px; font-weight: bold; color: #6B7280; margin-bottom: 6px;">
        CLASS TEACHER'S REMARK
      </div>
      <p style="margin: 0; font-size: 12px; color: #374151;">{{teacher_comment}}</p>
      <div style="margin-top: 20px; border-top: 1px solid #9CA3AF; padding-top: 4px;
                  font-size: 10px; color: #9CA3AF;">
        Signature: _______________________
      </div>
    </div>
    <div style="flex: 1; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px;">
      <div style="font-size: 11px; font-weight: bold; color: #6B7280; margin-bottom: 6px;">
        PRINCIPAL'S REMARK
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
      <p style="margin: 0;">Next Term Begins: <strong>{{next_term_date}}</strong></p>
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
  const navigate    = useNavigate();
  const [params]    = useSearchParams();
  const user        = useAuthStore((s) => s.user);
  const schoolId    = user?.schoolId;

  const templateId = params.get("id");
  const isEditing  = !!templateId;

  const [name,      setName]      = useState("");
  const [html,      setHtml]      = useState(STARTER_HTML);
  const [css,       setCss]       = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("html");
  const [loading,   setLoading]   = useState(isEditing);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // ── Load existing ──────────────────────────────────────

  useEffect(() => {
    if (!templateId) return;
    api.get(`/templates/${templateId}`, { params: { schoolId } })
      .then((res) => {
        const tmpl = res.data?.template || res.data?.data || res.data;
        setName(tmpl.name           || "");
        setHtml(tmpl.html           || STARTER_HTML);
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
    if (!name.trim()) { alert("Please enter a template name."); return; }
    if (!html.trim()) { alert("HTML cannot be empty.");          return; }

    setSaving(true);
    setError(null);
    try {
      if (isEditing) {
        await api.put(`/templates/${templateId}`, {
          schoolId, name: name.trim(), html, css, isDefault,
        });
      } else {
        await api.post("/templates", {
          schoolId, name: name.trim(), html, css, isDefault,
        });
      }
      navigate("/reports/templates");
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  }, [name, html, css, isDefault, isEditing, templateId, schoolId, navigate]);

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
            {isEditing ? "Edit Template" : "New Template"}
          </h1>
          <p className="text-xs text-gray-500">Report Card Builder</p>
        </div>

        {/* Name input */}
        <input
          type="text"
          placeholder="Template name…"
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
          Default
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
          {saving ? "Saving…" : "Save"}
          <span className="text-green-300 text-xs hidden md:inline">⌘S</span>
        </button>
      </div>

      {/* Error bar */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2
                        text-sm text-red-700 flex items-center gap-2">
          <span className="font-semibold">Error:</span>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-500 hover:text-red-700 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="bg-white border-b border-gray-200 px-6 flex shrink-0">
        {(
          [
            { id: "html",    label: "HTML",      Icon: Code2   },
            { id: "css",     label: "CSS",        Icon: Palette },
            { id: "vars",    label: "Variables",  Icon: List    },
            { id: "preview", label: "Preview",    Icon: Eye     },
          ] as { id: Tab; label: string; Icon: any }[]
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
            placeholder="Paste your HTML here…"
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
            placeholder="Optional extra CSS styles…"
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
              Click any placeholder to append it to your HTML.
            </p>
            {VARIABLE_GROUPS.map((group) => (
              <div key={group.group}>
                <h3 className="text-xs font-bold text-gray-500 uppercase
                               tracking-wider mb-2">
                  {group.group}
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
                        {v.desc}
                      </span>
                      <span className="text-blue-400 text-xs opacity-0
                                       group-hover:opacity-100 transition-opacity">
                        + Insert
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
              <span className="font-semibold">Layout Preview</span>
              — placeholders are still visible. Save then use the Preview
              button on the templates list to see filled data.
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
              title="Template Preview"
            />
          </div>
        )}
      </div>
    </div>
  );
}