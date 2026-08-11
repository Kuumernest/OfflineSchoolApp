// app/admin/reports/templates/builder.js
"use strict";

import React, {
  useState, useCallback, useEffect,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, ActivityIndicator, Alert,
  KeyboardAvoidingView, Platform,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import { useAuthStore }    from "../../../../src/store/auth.store";
import { TemplateService } from "../../../../src/services/template.service";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  success:   "#059669",
  error:     "#DC2626",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

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
      { key: "{{each subjects}}",    desc: "Start loop over subjects" },
      { key: "{{subject.name}}",     desc: "Subject name (in loop)"   },
      { key: "{{subject.caScore}}",  desc: "CA score (in loop)"       },
      { key: "{{subject.examScore}}",desc: "Exam score (in loop)"     },
      { key: "{{subject.total}}",    desc: "Total score (in loop)"    },
      { key: "{{subject.grade}}",    desc: "Grade (in loop)"          },
      { key: "{{subject.remark}}",   desc: "Remark (in loop)"         },
      { key: "{{/each}}",            desc: "End loop"                  },
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
      { key: "{{qr_code}}",        desc: "QR code placeholder"  },
      { key: "{{report_date}}",    desc: "Date report generated"},
      { key: "{{next_term_date}}", desc: "Next term start date" },
    ],
  },
];

// ─────────────────────────────────────────────────────────
// STARTER HTML
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

  <!-- Subjects -->
  <h3 style="font-size: 13px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; margin-bottom: 8px;">
    Academic Performance
  </h3>
  {{subjects_table}}

  <!-- Summary -->
  <div style="display: flex; gap: 12px; margin: 16px 0;">
    <div style="flex: 1; text-align: center; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px;">
      <div style="font-size: 22px; font-weight: bold; color: #2563EB;">{{average}}</div>
      <div style="font-size: 10px; color: #6B7280; margin-top: 2px;">Average /20</div>
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

  <!-- Pass / Fail -->
  {{if isPassing}}
    <div style="text-align:center;padding:10px;background:#D1FAE5;color:#059669;font-weight:bold;border-radius:6px;margin-bottom:14px;">
      ✓ PROMOTED &mdash; {{remark}}
    </div>
  {{else}}
    <div style="text-align:center;padding:10px;background:#FEE2E2;color:#DC2626;font-weight:bold;border-radius:6px;margin-bottom:14px;">
      ✗ NOT PROMOTED &mdash; {{remark}}
    </div>
  {{endif}}

  <!-- Attendance -->
  <h3 style="font-size: 13px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; margin: 16px 0 8px;">
    Attendance
  </h3>
  <div style="display: flex; gap: 12px; margin-bottom: 16px;">
    <div style="flex:1;background:#F9FAFB;border-radius:6px;padding:8px 12px;font-size:12px;">
      Days Open: <strong>{{days_open}}</strong>
    </div>
    <div style="flex:1;background:#F9FAFB;border-radius:6px;padding:8px 12px;font-size:12px;">
      Present: <strong>{{days_present}}</strong>
    </div>
    <div style="flex:1;background:#F9FAFB;border-radius:6px;padding:8px 12px;font-size:12px;">
      Absent: <strong>{{days_absent}}</strong>
    </div>
    <div style="flex:1;background:#F9FAFB;border-radius:6px;padding:8px 12px;font-size:12px;">
      Rate: <strong>{{attendance_percent}}</strong>
    </div>
  </div>

  <!-- Remarks -->
  <div style="display: flex; gap: 16px; margin-bottom: 16px;">
    <div style="flex:1;border:1px solid #E5E7EB;border-radius:8px;padding:12px;">
      <div style="font-size:11px;font-weight:bold;color:#6B7280;margin-bottom:6px;">CLASS TEACHER'S REMARK</div>
      <p style="margin:0;font-size:12px;color:#374151;">{{teacher_comment}}</p>
      <div style="margin-top:20px;border-top:1px solid #9CA3AF;padding-top:4px;font-size:10px;color:#9CA3AF;">
        Signature: _______________________
      </div>
    </div>
    <div style="flex:1;border:1px solid #E5E7EB;border-radius:8px;padding:12px;">
      <div style="font-size:11px;font-weight:bold;color:#6B7280;margin-bottom:6px;">PRINCIPAL'S REMARK</div>
      <p style="margin:0;font-size:12px;color:#374151;">{{principal_comment}}</p>
      <div style="margin-top:20px;border-top:1px solid #9CA3AF;padding-top:4px;font-size:10px;color:#9CA3AF;">
        Signature: _______________________
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid #E5E7EB;padding-top:12px;margin-top:8px;">
    <div>{{qr_code}}</div>
    <div style="text-align:right;font-size:11px;color:#6B7280;">
      <p style="margin:0;">Next Term Begins: <strong>{{next_term_date}}</strong></p>
      <p style="margin:4px 0 0;">Report Generated: {{report_date}}</p>
    </div>
  </div>

</div>`;

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TemplateBuilderScreen() {
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const { templateId } = useLocalSearchParams();
  const isEditing = !!templateId;

  const [name,      setName]      = useState("");
  const [html,      setHtml]      = useState(STARTER_HTML);
  const [css,       setCss]       = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [loading,   setLoading]   = useState(isEditing);
  const [activeTab, setActiveTab] = useState("html");

  // ── Load existing template if editing ─────────────────
  useEffect(() => {
    if (!templateId) return;
    TemplateService.getById(templateId)
      .then((tmpl) => {
        if (!tmpl) {
          Alert.alert("Error", "Template not found");
          router.back();
          return;
        }
        setName(tmpl.name      || "");
        setHtml(tmpl.html      || STARTER_HTML);
        setCss(tmpl.css        || "");
        setIsDefault(tmpl.isDefault || false);
      })
      .catch((err) => {
        Alert.alert("Error", err?.response?.data?.error || err.message);
      })
      .finally(() => setLoading(false));
  }, [templateId]);

  // ── Save ───────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      Alert.alert("Missing", "Please enter a template name.");
      return;
    }
    if (!html.trim()) {
      Alert.alert("Missing", "HTML cannot be empty.");
      return;
    }

    setSaving(true);
    try {
      if (isEditing) {
        await TemplateService.update(templateId, {
          name: name.trim(),
          html,
          css,
          isDefault,
        });
      } else {
        await TemplateService.create({
          schoolId,
          name: name.trim(),
          html,
          css,
          isDefault,
        });
      }
      Alert.alert(
        "Saved",
        isEditing
          ? "Template updated successfully."
          : "Template created successfully.",
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (err) {
      Alert.alert("Save Failed", err?.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  }, [name, html, css, isDefault, isEditing, templateId, schoolId]);

  if (loading) {
    return (
      <View style={s.screen}>
        <BuilderHeader isEditing={isEditing} saving={false} onSave={handleSave} />
        <View style={s.centered}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <BuilderHeader
        isEditing={isEditing}
        saving={saving}
        onSave={handleSave}
      />

      {/* Name + Default toggle */}
      <View style={s.nameRow}>
        <TextInput
          style={s.nameInput}
          placeholder="Template name…"
          placeholderTextColor={C.gray400}
          value={name}
          onChangeText={setName}
          returnKeyType="done"
        />
        <TouchableOpacity
          style={[s.defaultToggle, isDefault && s.defaultToggleActive]}
          onPress={() => setIsDefault((v) => !v)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={isDefault ? "star" : "star-outline"}
            size={16}
            color={isDefault ? C.primary : C.gray400}
          />
          <Text style={[s.defaultToggleText, isDefault && { color: C.primary }]}>
            Default
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tab bar */}
      <View style={s.tabs}>
        {[
          { id: "html",  label: "HTML",      icon: "code-slash-outline"    },
          { id: "css",   label: "CSS",       icon: "color-palette-outline" },
          { id: "vars",  label: "Variables", icon: "list-outline"          },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.id}
            style={[s.tab, activeTab === tab.id && s.tabActive]}
            onPress={() => setActiveTab(tab.id)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={tab.icon}
              size={14}
              color={activeTab === tab.id ? C.primary : C.gray500}
            />
            <Text style={[s.tabText, activeTab === tab.id && s.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* HTML editor */}
      {activeTab === "html" && (
        <ScrollView style={s.editorScroll} keyboardShouldPersistTaps="handled">
          <TextInput
            style={s.editor}
            multiline
            value={html}
            onChangeText={setHtml}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            placeholder="Paste your HTML here…"
            placeholderTextColor={C.gray400}
          />
        </ScrollView>
      )}

      {/* CSS editor */}
      {activeTab === "css" && (
        <ScrollView style={s.editorScroll} keyboardShouldPersistTaps="handled">
          <TextInput
            style={s.editor}
            multiline
            value={css}
            onChangeText={setCss}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            placeholder="Optional CSS styles…"
            placeholderTextColor={C.gray400}
          />
        </ScrollView>
      )}

      {/* Variables reference */}
      {activeTab === "vars" && (
        <ScrollView
          style={s.varsScroll}
          contentContainerStyle={s.varsContent}
        >
          <Text style={s.varsHint}>
            Tap any placeholder to append it to your HTML template.
          </Text>
          {VARIABLE_GROUPS.map((group) => (
            <View key={group.group} style={s.varGroup}>
              <Text style={s.varGroupLabel}>{group.group}</Text>
              {group.vars.map((v) => (
                <TouchableOpacity
                  key={v.key}
                  style={s.varRow}
                  onPress={() => {
                    setHtml((prev) => prev + v.key);
                    setActiveTab("html");
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={s.varKey}>{v.key}</Text>
                  <Text style={s.varDesc}>{v.desc}</Text>
                  <Ionicons name="add-circle-outline" size={16} color={C.primary} />
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────

function BuilderHeader({ isEditing, saving, onSave }) {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
        <Ionicons name="arrow-back" size={24} color={C.gray900} />
      </TouchableOpacity>
      <View style={s.headerCenter}>
        <Text style={s.headerTitle}>
          {isEditing ? "Edit Template" : "New Template"}
        </Text>
        <Text style={s.headerSub}>Report Card Builder</Text>
      </View>
      <TouchableOpacity
        style={[s.saveBtn, saving && { opacity: 0.6 }]}
        onPress={onSave}
        disabled={saving}
        activeOpacity={0.8}
      >
        {saving ? (
          <ActivityIndicator size="small" color={C.white} />
        ) : (
          <>
            <Ionicons name="checkmark" size={16} color={C.white} />
            <Text style={s.saveBtnText}>Save</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen:  { flex: 1, backgroundColor: C.gray50 },
  centered:{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },
  saveBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   C.success,
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   9,
  },
  saveBtnText: { fontSize: 13, fontWeight: "700", color: C.white },
  nameRow: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               10,
  },
  nameInput: {
    flex:              1,
    fontSize:          14,
    color:             C.gray900,
    borderWidth:       1,
    borderColor:       C.gray200,
    borderRadius:      8,
    paddingHorizontal: 12,
    paddingVertical:   8,
  },
  defaultToggle: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   8,
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       C.gray200,
    backgroundColor:   C.gray50,
  },
  defaultToggleActive: { borderColor: C.primary, backgroundColor: C.primaryBg },
  defaultToggleText:   { fontSize: 12, fontWeight: "600", color: C.gray500 },
  tabs: {
    flexDirection:     "row",
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
  },
  tab: {
    flex:              1,
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               4,
    paddingVertical:   10,
  },
  tabActive:     { borderBottomWidth: 2, borderBottomColor: C.primary },
  tabText:       { fontSize: 12, fontWeight: "600", color: C.gray500 },
  tabTextActive: { color: C.primary },
  editorScroll: { flex: 1 },
  editor: {
    flex:        1,
    fontSize:    13,
    color:       C.gray900,
    fontFamily:  Platform.OS === "ios" ? "Menlo" : "monospace",
    backgroundColor: C.gray50,
    padding:     16,
    lineHeight:  22,
    minHeight:   600,
  },
  varsScroll:   { flex: 1 },
  varsContent:  { padding: 16, gap: 16, paddingBottom: 40 },
  varsHint: {
    fontSize:  12,
    color:     C.gray500,
    fontStyle: "italic",
    lineHeight:18,
    marginBottom: 4,
  },
  varGroup:      { gap: 4 },
  varGroupLabel: {
    fontSize:      11,
    fontWeight:    "700",
    color:         C.gray700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom:  4,
  },
  varRow: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   C.white,
    borderRadius:      8,
    paddingHorizontal: 12,
    paddingVertical:   10,
    borderWidth:       1,
    borderColor:       C.gray200,
    gap:               10,
  },
  varKey: {
    fontSize:   12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color:      C.primary,
    width:      180,
  },
  varDesc: { flex: 1, fontSize: 11, color: C.gray500 },
});