// app/admin/exams/[id]/index.js
"use strict";

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar, Alert, Modal,
  FlatList, TextInput,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../../src/store/auth.store";
import { ExamService }  from "../../../../src/services/exam.service";
// The class NAME is not on an exam subject. /exams/:id/submissions returns raw
// ExamSubject rows, which carry classId and nothing readable, so the names come
// from the synced classes table instead.
import { getClassesList } from "../../../../src/services/assignment.service";
import { useTranslation } from "../../../../src/i18n/useTranslation";
import { errorText } from "../../../../src/utils/appError";

// ─────────────────────────────────────────────────────────
// UUID VALIDATOR
// ─────────────────────────────────────────────────────────

const isValidUUID = (str) =>
  typeof str === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

// Also accepts MongoDB ObjectIds (24 hex chars)
const isValidId = (str) =>
  isValidUUID(str) ||
  (typeof str === "string" && /^[0-9a-f]{24}$/i.test(str));

// ─────────────────────────────────────────────────────────
// CLASS NAME / ID RESOLVERS
// ─────────────────────────────────────────────────────────

function resolveClassName(item) {
  if (!item) return null;

  if (typeof item.className === "string" && item.className.trim())
    return item.className.trim();
  if (typeof item.class === "string" && item.class.trim())
    return item.class.trim();
  if (typeof item.stream === "string" && item.stream.trim())
    return item.stream.trim();

  if (item.className && typeof item.className === "object")
    return item.className.name || item.className.className || null;
  if (item.class && typeof item.class === "object")
    return item.class.name || item.class.className || null;
  if (item.classInfo) {
    if (typeof item.classInfo === "string") return item.classInfo;
    return item.classInfo.name || item.classInfo.className || null;
  }

  if (item.student) {
    const st = item.student;
    if (typeof st.className === "string" && st.className.trim())
      return st.className.trim();
    if (st.className && typeof st.className === "object")
      return st.className.name || st.className.className || null;
    if (typeof st.class === "string" && st.class.trim())
      return st.class.trim();
    if (st.class && typeof st.class === "object")
      return st.class.name || st.class.className || null;
  }

  if (typeof item.grade === "string" && item.grade.trim())
    return item.grade.trim();
  if (typeof item.level === "string" && item.level.trim())
    return item.level.trim();

  return null;
}

function resolveClassId(item) {
  if (!item) return null;
  if (typeof item.classId === "string") return item.classId;
  if (item.classId?._id) return item.classId._id;
  if (typeof item.class === "string") return item.class;
  if (item.class?._id) return item.class._id;
  if (item.className?._id) return item.className._id;
  if (item.student?.classId) return item.student.classId;
  if (item.student?.class?._id) return item.student.class._id;
  return null;
}

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const STATUS_META = {
  draft:     { color: "#6B7280", bg: "#F3F4F6", labelKey: "examDetail.statusDraft"     },
  scheduled: { color: "#4F46E5", bg: "#EEF2FF", labelKey: "examDetail.statusScheduled" },
  ongoing:   { color: "#D97706", bg: "#FEF3C7", labelKey: "examDetail.statusOngoing"   },
  completed: { color: "#059669", bg: "#ECFDF5", labelKey: "examDetail.statusCompleted" },
  published: { color: "#7C3AED", bg: "#F5F3FF", labelKey: "examDetail.statusPublished" },
  archived:  { color: "#9CA3AF", bg: "#F9FAFB", labelKey: "examDetail.statusArchived"  },
};

const SUBMISSION_META = {
  pending:   { color: "#D97706", bg: "#FEF3C7", labelKey: "examDetail.statPending",   icon: "time-outline"             },
  submitted: { color: "#4F46E5", bg: "#EEF2FF", labelKey: "examDetail.statSubmitted", icon: "cloud-upload-outline"     },
  approved:  { color: "#059669", bg: "#ECFDF5", labelKey: "examDetail.statApproved",  icon: "checkmark-circle-outline" },
  rejected:  { color: "#DC2626", bg: "#FEF2F2", labelKey: "examDetail.statRejected",  icon: "close-circle-outline"     },
};

const EXAM_TYPE_KEYS = {
  test:               "examDetail.typeTest",
  practical:          "examDetail.typePractical",
  promotion_exam:     "examDetail.typePromotionExam",
};

/** Translated exam-type label, falling back to the raw stored value. */
const examTypeLabel = (t, type) =>
  EXAM_TYPE_KEYS[type] ? t(EXAM_TYPE_KEYS[type]) : type;

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const deriveClasses = (subjects, exam, t) => {
  const map = {};

  if (Array.isArray(exam?.classIds) && exam.classIds.length > 0) {
    const namesList = exam.classNames
      ? exam.classNames.split(",").map((n) => n.trim())
      : [];
    exam.classIds.forEach((cid, i) => {
      const cidStr = String(cid);
      if (!map[cidStr]) {
        map[cidStr] = {
          classId:   cidStr,
          className: namesList[i] || exam.className || t("examDetail.classFallback"),
        };
      }
    });
  }

  for (const s of subjects) {
    const cid   = resolveClassId(s) || s.classId;
    const cname =
      resolveClassName(s) ||
      map[cid]?.className ||
      resolveClassName(exam) ||
      exam?.className ||
      t("examDetail.unknownClass");

    if (cid && !map[cid]) {
      map[cid] = { classId: cid, className: cname };
    }
  }

  const examClassId = resolveClassId(exam) || exam?.classId;
  if (examClassId && !map[examClassId]) {
    map[examClassId] = {
      classId:   examClassId,
      className: resolveClassName(exam) || exam?.className || t("examDetail.classFallback"),
    };
  }

  return Object.values(map);
};

/**
 * Group subjects or results into per-class sections, so an exam that spans
 * several classes reads class by class instead of as one flat list.
 *
 * ── Where the class NAME comes from, and why the order matters ─────────────
 *
 * Grouping by id is the easy half: /exams/:id/submissions returns raw
 * ExamSubject rows and every one carries classId. Naming the group is the part
 * that fails quietly.
 *
 * An ExamSubject has no readable class field at all, so resolveClassName(item)
 * returns null for every subject. `classNameById` — read from the synced
 * classes table — is therefore the real source, and it is consulted FIRST.
 *
 * exam.classNames is only a fallback because it cannot be trusted for this: it
 * is a single comma-joined string paired positionally with classIds, it
 * defaults to null, and when it is null every group would otherwise inherit
 * exam.className, which on a multi-class exam is one class's name printed over
 * all of them. That is the failure this ordering exists to avoid — headers that
 * look right and name the wrong class.
 *
 * First-seen order is preserved, so subjects follow the exam's own class order
 * and results stay in ranking order.
 */
const groupByClass = (items, exam, t, classNameById = {}) => {
  const groups = [];
  const index  = {};

  const examClassNameById = (() => {
    if (!Array.isArray(exam?.classIds) || exam.classIds.length === 0) return {};
    const namesList = exam.classNames
      ? exam.classNames.split(",").map((n) => n.trim())
      : [];
    const map = {};
    exam.classIds.forEach((cid, i) => {
      // Only positional names. exam.className is deliberately NOT used as a
      // per-class default here — see the note above.
      map[String(cid)] = namesList[i] || null;
    });
    return map;
  })();

  // A single-class exam has one group, and then the exam's own name is right.
  const singleClass = !Array.isArray(exam?.classIds) || exam.classIds.length <= 1;

  const nameFor = (cid, itemClass) =>
    classNameById[String(cid)] ||
    itemClass ||
    (cid && examClassNameById[String(cid)]) ||
    (singleClass ? resolveClassName(exam) || exam?.className : null) ||
    t("examDetail.unknownClass");

  for (const item of items) {
    const cid       = resolveClassId(item) || item?.classId || null;
    const itemClass = resolveClassName(item);
    const key       = cid || "__no_class__";

    if (!index[key]) {
      index[key] = { classId: cid, className: nameFor(cid, itemClass), items: [] };
      groups.push(index[key]);
    } else if (itemClass && index[key].className === t("examDetail.unknownClass")) {
      // A later item carrying a real name upgrades a header that fell back.
      index[key].className = itemClass;
    }

    index[key].items.push(item);
  }

  return groups;
};

// ─────────────────────────────────────────────────────────
// REJECT MODAL  (cross-platform — replaces Alert.prompt)
// ─────────────────────────────────────────────────────────

const RejectModal = ({ visible, subjectName, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

  // Reset when opened
  useEffect(() => {
    if (visible) setReason("");
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={rm.overlay}>
        <View style={rm.box}>
          <Text style={rm.title}>{t("examDetail.rejectTitle")}</Text>
          {!!subjectName && (
            <Text style={rm.sub}>{subjectName}</Text>
          )}
          <TextInput
            style={rm.input}
            placeholder={t("examDetail.rejectPlaceholder")}
            placeholderTextColor="#9CA3AF"
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={3}
            autoFocus
          />
          <View style={rm.actions}>
            <TouchableOpacity style={rm.cancelBtn} onPress={onCancel}>
              <Text style={rm.cancelText}>{t("examDetail.cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[rm.rejectBtn, !reason.trim() && { opacity: 0.4 }]}
              onPress={() => {
                if (!reason.trim()) {
                  Alert.alert(
                    t("examDetail.requiredTitle"),
                    t("examDetail.reasonRequired")
                  );
                  return;
                }
                onConfirm(reason.trim());
              }}
              disabled={!reason.trim()}
            >
              <Text style={rm.rejectText}>{t("examDetail.reject")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const rm = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent:  "center",
    alignItems:      "center",
    padding:         24,
  },
  box: {
    backgroundColor: "#FFF",
    borderRadius:    20,
    padding:         24,
    width:           "100%",
    gap:             12,
  },
  title:     { fontSize: 18, fontWeight: "700", color: "#111827" },
  sub:       { fontSize: 13, color: "#6B7280" },
  input: {
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    borderRadius:      10,
    padding:           12,
    fontSize:          14,
    color:             "#111827",
    backgroundColor:   "#F9FAFB",
    minHeight:         80,
    textAlignVertical: "top",
  },
  actions:   { flexDirection: "row", gap: 10 },
  cancelBtn: {
    flex:            1,
    paddingVertical: 12,
    borderRadius:    10,
    alignItems:      "center",
    backgroundColor: "#F3F4F6",
  },
  cancelText: { fontSize: 14, fontWeight: "600", color: "#374151" },
  rejectBtn: {
    flex:            1,
    paddingVertical: 12,
    borderRadius:    10,
    alignItems:      "center",
    backgroundColor: "#DC2626",
  },
  rejectText: { fontSize: 14, fontWeight: "700", color: "#FFF" },
});

// ─────────────────────────────────────────────────────────
// COEFFICIENT MODAL
// ─────────────────────────────────────────────────────────

/**
 * Set one subject's coefficient — how much it counts in the average and on
 * the report card. Stored server-side as weight = coefficient × 100.
 */
const CoeffModal = ({ visible, subject, saving, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  const [value, setValue] = useState("1");

  useEffect(() => {
    if (visible) {
      setValue(String(Math.round(((subject?.weight ?? 100) / 100) * 100) / 100));
    }
  }, [visible, subject]);

  const parsed = Number(value);
  const valid  = Number.isFinite(parsed) && parsed > 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={rm.overlay}>
        <View style={rm.box}>
          <Text style={rm.title}>{t("examDetail.coeffTitle")}</Text>
          {!!subject?.subjectName && (
            <Text style={rm.sub}>
              {t("examDetail.coeffHelp", { subject: subject.subjectName })}
            </Text>
          )}
          <TextInput
            style={[rm.input, { minHeight: 0, textAlignVertical: "center" }]}
            keyboardType="numeric"
            value={value}
            onChangeText={setValue}
            placeholder="1"
            placeholderTextColor="#9CA3AF"
            autoFocus
          />
          <View style={rm.actions}>
            <TouchableOpacity style={rm.cancelBtn} onPress={onCancel}>
              <Text style={rm.cancelText}>{t("examDetail.cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                rm.rejectBtn,
                { backgroundColor: "#4F46E5" },
                (!valid || saving) && { opacity: 0.4 },
              ]}
              onPress={() => valid && onConfirm(parsed)}
              disabled={!valid || saving}
            >
              <Text style={rm.rejectText}>
                {saving ? t("examDetail.saving") : t("examDetail.save")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────
// CLASS PICKER MODAL
// ─────────────────────────────────────────────────────────

const ClassPickerModal = ({ visible, classes, onSelect, onClose, examName, t }) => (
  <Modal
    visible={visible}
    transparent
    animationType="slide"
    onRequestClose={onClose}
  >
    <TouchableOpacity
      style={cp.overlay}
      activeOpacity={1}
      onPress={onClose}
    >
      <TouchableOpacity
        style={cp.sheet}
        activeOpacity={1}
        onPress={() => {}}
      >
        <View style={cp.handle} />
        <Text style={cp.title}>{t("examDetail.pickClassTitle")}</Text>
        <Text style={cp.sub}>
          {t("examDetail.pickClassSub", { exam: examName })}
        </Text>
        <FlatList
          data={classes}
          keyExtractor={(item) => item.classId}
          contentContainerStyle={{ gap: 8, paddingBottom: 16 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={cp.classRow}
              onPress={() => onSelect(item)}
              activeOpacity={0.7}
            >
              <View style={cp.classIcon}>
                <Ionicons name="school-outline" size={18} color="#4F46E5" />
              </View>
              <Text style={cp.className}>{item.className}</Text>
              <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
            </TouchableOpacity>
          )}
        />
        <TouchableOpacity
          style={cp.cancelBtn}
          onPress={onClose}
          activeOpacity={0.7}
        >
          <Text style={cp.cancelText}>{t("examDetail.cancel")}</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </TouchableOpacity>
  </Modal>
);

const cp = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent:  "flex-end",
  },
  sheet: {
    backgroundColor:      "#FFF",
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    padding:              20,
    paddingTop:           12,
    maxHeight:            "70%",
  },
  handle: {
    width:           40,
    height:          4,
    backgroundColor: "#E5E7EB",
    borderRadius:    2,
    alignSelf:       "center",
    marginBottom:    16,
  },
  title:    { fontSize: 17, fontWeight: "700", color: "#111827", marginBottom: 4 },
  sub:      { fontSize: 13, color: "#6B7280", marginBottom: 16, lineHeight: 18 },
  classRow: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    backgroundColor: "#F9FAFB",
    borderRadius:    12,
    padding:         14,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
  },
  classIcon: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  className: { flex: 1, fontSize: 15, fontWeight: "600", color: "#111827" },
  cancelBtn: {
    marginTop:       8,
    paddingVertical: 14,
    alignItems:      "center",
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
  },
  cancelText: { fontSize: 14, fontWeight: "600", color: "#6B7280" },
});

// ─────────────────────────────────────────────────────────
// INFO ROW
// ─────────────────────────────────────────────────────────

const InfoRow = ({ icon, label, value }) => (
  <View style={ir.row}>
    <View style={ir.iconBox}>
      <Ionicons name={icon} size={16} color="#6B7280" />
    </View>
    <View style={ir.content}>
      <Text style={ir.label}>{label}</Text>
      <Text style={ir.value}>{value || "—"}</Text>
    </View>
  </View>
);

const ir = StyleSheet.create({
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               12,
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
  },
  iconBox: {
    width:           32,
    height:          32,
    borderRadius:    8,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  content: { flex: 1 },
  label: {
    fontSize:      11,
    color:         "#9CA3AF",
    fontWeight:    "600",
    textTransform: "uppercase",
  },
  value: { fontSize: 14, color: "#111827", fontWeight: "600", marginTop: 2 },
});

// ─────────────────────────────────────────────────────────
// SUBMISSION CARD
// ─────────────────────────────────────────────────────────

const SubmissionCard = ({
  subject, onApprove, onReject, onEnterMarks, onEditCoeff,
}) => {
  const { t }     = useTranslation();
  const meta      = SUBMISSION_META[subject.submissionStatus] || SUBMISSION_META.pending;
  const className = resolveClassName(subject);

  return (
    <View style={sc.card}>
      {!!className && (
        <View style={sc.classBadge}>
          <Ionicons name="school-outline" size={11} color="#6B7280" />
          <Text style={sc.classBadgeText}>{className}</Text>
        </View>
      )}

      <View style={sc.top}>
        <View style={sc.info}>
          <Text style={sc.subjectName} numberOfLines={1}>
            {subject.subjectName || t("examDetail.unknownSubject")}
          </Text>
          <Text style={sc.teacherName}>
            {subject.teacherName || t("examDetail.noTeacher")}
          </Text>
          {subject.totalScoresEntered > 0 && (
            <Text style={sc.scoresCount}>
              {t("examDetail.scoresEntered", {
                count: subject.totalScoresEntered,
              })}
            </Text>
          )}
        </View>
        <View style={[sc.badge, { backgroundColor: meta.bg }]}>
          <Ionicons name={meta.icon} size={12} color={meta.color} />
          <Text style={[sc.badgeText, { color: meta.color }]}>
            {t(meta.labelKey)}
          </Text>
        </View>
      </View>

      <View style={sc.metaRow}>
        <Text style={sc.meta}>
          {t("examDetail.maxLabel", { value: subject.maxScore })}
        </Text>
        <Text style={sc.meta}>
          {t("examDetail.passLabel", { value: subject.passMark })}
        </Text>
        {/* weight is percentage-style (100 = ×1); people think in
            coefficients, so that is what the card shows and edits. */}
        <TouchableOpacity
          style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
          onPress={() => onEditCoeff?.(subject)}
          activeOpacity={0.7}
        >
          <Text style={sc.meta}>
            {t("examDetail.coeffLabel", {
              value: Math.round(((subject.weight ?? 100) / 100) * 100) / 100,
            })}
          </Text>
          <Ionicons name="pencil-outline" size={11} color="#4F46E5" />
        </TouchableOpacity>
        {subject.isPractical && (
          <Text style={[sc.meta, sc.tag]}>{t("examDetail.tagPractical")}</Text>
        )}
        {subject.isOral && (
          <Text style={[sc.meta, sc.tag]}>{t("examDetail.tagOral")}</Text>
        )}
      </View>

      <View style={sc.actions}>
        <TouchableOpacity
          style={sc.actionBtn}
          onPress={() => onEnterMarks(subject)}
          activeOpacity={0.7}
        >
          <Ionicons name="create-outline" size={14} color="#4F46E5" />
          <Text style={[sc.actionText, { color: "#4F46E5" }]}>
            {t("examDetail.enterMarks")}
          </Text>
        </TouchableOpacity>

        {subject.submissionStatus === "submitted" && (
          <>
            <TouchableOpacity
              style={[sc.actionBtn, { backgroundColor: "#ECFDF5" }]}
              onPress={() => onApprove(subject)}
              activeOpacity={0.7}
            >
              <Ionicons
                name="checkmark-circle-outline"
                size={14}
                color="#059669"
              />
              <Text style={[sc.actionText, { color: "#059669" }]}>
                {t("examDetail.approve")}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[sc.actionBtn, { backgroundColor: "#FEF2F2" }]}
              onPress={() => onReject(subject)}
              activeOpacity={0.7}
            >
              <Ionicons
                name="close-circle-outline"
                size={14}
                color="#DC2626"
              />
              <Text style={[sc.actionText, { color: "#DC2626" }]}>
                {t("examDetail.reject")}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
};

const sc = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  classBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   "#F3F4F6",
    alignSelf:         "flex-start",
    borderRadius:      6,
    paddingHorizontal: 8,
    paddingVertical:   3,
    marginBottom:      8,
  },
  classBadgeText: { fontSize: 10, fontWeight: "600", color: "#6B7280" },
  top:            { flexDirection: "row", alignItems: "flex-start", marginBottom: 8 },
  info:           { flex: 1, marginRight: 10 },
  subjectName:    { fontSize: 15, fontWeight: "700", color: "#111827" },
  teacherName:    { fontSize: 12, color: "#6B7280", marginTop: 2 },
  scoresCount:    { fontSize: 11, color: "#059669", fontWeight: "600", marginTop: 2 },
  badge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    borderRadius:      8,
    paddingHorizontal: 8,
    paddingVertical:   4,
  },
  badgeText: { fontSize: 11, fontWeight: "700" },
  metaRow:   { flexDirection: "row", gap: 12, marginBottom: 10 },
  meta:      { fontSize: 11, color: "#6B7280" },
  tag: {
    backgroundColor:   "#EEF2FF",
    color:             "#4F46E5",
    borderRadius:      4,
    paddingHorizontal: 6,
    fontWeight:        "600",
  },
  actions: {
    flexDirection:  "row",
    gap:            8,
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
    paddingTop:     10,
    flexWrap:       "wrap",
  },
  actionBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   6,
    borderRadius:      8,
    backgroundColor:   "#EEF2FF",
  },
  actionText: { fontSize: 12, fontWeight: "600" },
});

// ─────────────────────────────────────────────────────────
// RESULT CARD
// ─────────────────────────────────────────────────────────

const ResultCard = ({ result }) => {
  const { t }     = useTranslation();
  const className = resolveClassName(result);
  const color     = result.isPassing ? "#059669" : "#DC2626";

  return (
    <View style={rc.card}>
      <View style={[rc.pos, { backgroundColor: color + "15" }]}>
        <Text style={[rc.posText, { color }]}>
          #{result.classPosition ?? "—"}
        </Text>
      </View>

      <View style={rc.info}>
        <Text style={rc.name} numberOfLines={1}>
          {result.studentName || result.name || t("examDetail.unknownStudent")}
        </Text>
        <View style={rc.classRow}>
          <Ionicons name="school-outline" size={10} color="#9CA3AF" />
          <Text style={rc.resolvedClass} numberOfLines={1}>
            {className ?? t("examDetail.noClass")}
          </Text>
        </View>
        {result.admissionNo ? (
          <Text style={rc.sub}>#{result.admissionNo}</Text>
        ) : result.studentId ? (
          <Text style={rc.sub}>{result.studentId}</Text>
        ) : null}
      </View>

      <View style={rc.scores}>
        <Text style={[rc.pct, { color }]}>
          {result.percentage != null
            ? `${Number(result.percentage).toFixed(1)}%`
            : "—"}
        </Text>
        <Text style={rc.grade}>{result.overallGrade || "—"}</Text>
        <View style={[rc.passBadge, { backgroundColor: color + "15" }]}>
          <Text style={[rc.passText, { color }]}>
            {result.isPassing
              ? t("examDetail.resultPass")
              : t("examDetail.resultFail")}
          </Text>
        </View>
      </View>
    </View>
  );
};

const rc = StyleSheet.create({
  card: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         12,
    marginBottom:    8,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    gap:             12,
  },
  pos: {
    width:          40,
    height:         40,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  posText:       { fontSize: 13, fontWeight: "800" },
  info:          { flex: 1 },
  name:          { fontSize: 14, fontWeight: "700", color: "#111827" },
  classRow:      { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 },
  resolvedClass: { fontSize: 11, color: "#6B7280", fontWeight: "600", maxWidth: 150 },
  sub:           { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  scores:        { alignItems: "flex-end", gap: 2 },
  pct:           { fontSize: 16, fontWeight: "800" },
  grade:         { fontSize: 12, color: "#6B7280", fontWeight: "600" },
  passBadge:     { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  passText:      { fontSize: 10, fontWeight: "700" },
});

// ─────────────────────────────────────────────────────────
// QUICK ACTIONS BAR
// ─────────────────────────────────────────────────────────

const QuickActions = ({
  exam, subjects, onEnterMarks, onProcess, onPublish,
  processing, router, id, t,
}) => (
  <View style={qa.wrap}>
    <Text style={qa.title}>{t("examDetail.quickActions")}</Text>
    <View style={qa.grid}>

      <TouchableOpacity
        style={[qa.btn, { backgroundColor: "#EEF2FF" }]}
        onPress={onEnterMarks}
        activeOpacity={0.8}
      >
        <View style={[qa.icon, { backgroundColor: "#4F46E5" }]}>
          <Ionicons name="create-outline" size={20} color="#FFF" />
        </View>
        <Text style={[qa.btnLabel, { color: "#4F46E5" }]}>
          {t("examDetail.enterMarks")}
        </Text>
        <Text style={qa.btnSub}>
          {t("examDetail.pendingCount", {
            count: subjects.filter((s) => s.submissionStatus === "pending").length,
          })}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          qa.btn,
          { backgroundColor: "#ECFDF5" },
          processing && { opacity: 0.6 },
        ]}
        onPress={onProcess}
        disabled={processing}
        activeOpacity={0.8}
      >
        <View style={[qa.icon, { backgroundColor: "#059669" }]}>
          {processing
            ? <ActivityIndicator size="small" color="#FFF" />
            : <Ionicons name="calculator-outline" size={20} color="#FFF" />
          }
        </View>
        <Text style={[qa.btnLabel, { color: "#059669" }]}>
          {t("examDetail.process")}
        </Text>
        <Text style={qa.btnSub}>{t("examDetail.processSub")}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[qa.btn, { backgroundColor: "#EFF6FF" }]}
        onPress={() =>
          router.push({
            pathname: "/admin/exams/results/[examId]",
            params:   { examId: id },
          })
        }
        activeOpacity={0.8}
      >
        <View style={[qa.icon, { backgroundColor: "#2563EB" }]}>
          <Ionicons name="trophy-outline" size={20} color="#FFF" />
        </View>
        <Text style={[qa.btnLabel, { color: "#2563EB" }]}>
          {t("examDetail.rankings")}
        </Text>
        <Text style={qa.btnSub}>{t("examDetail.rankingsSub")}</Text>
      </TouchableOpacity>

      {exam.status === "completed" && (
        <TouchableOpacity
          style={[qa.btn, { backgroundColor: "#F5F3FF" }]}
          onPress={onPublish}
          activeOpacity={0.8}
        >
          <View style={[qa.icon, { backgroundColor: "#7C3AED" }]}>
            <Ionicons name="megaphone-outline" size={20} color="#FFF" />
          </View>
          <Text style={[qa.btnLabel, { color: "#7C3AED" }]}>
            {t("examDetail.publish")}
          </Text>
          <Text style={qa.btnSub}>{t("examDetail.publishSub")}</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[qa.btn, { backgroundColor: "#F9FAFB" }]}
        onPress={() =>
          router.push({
            pathname: "/admin/exams/[id]/edit",
            params:   { id },
          })
        }
        activeOpacity={0.8}
      >
        <View style={[qa.icon, { backgroundColor: "#6B7280" }]}>
          <Ionicons name="pencil-outline" size={20} color="#FFF" />
        </View>
        <Text style={[qa.btnLabel, { color: "#374151" }]}>
          {t("examDetail.edit")}
        </Text>
        <Text style={qa.btnSub}>{t("examDetail.editSub")}</Text>
      </TouchableOpacity>

    </View>
  </View>
);

const qa = StyleSheet.create({
  wrap: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  title: { fontSize: 14, fontWeight: "700", color: "#111827", marginBottom: 12 },
  grid:  { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  btn: {
    borderRadius: 14,
    padding:      14,
    alignItems:   "center",
    width:        "47%",
    gap:          6,
  },
  icon: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
  },
  btnLabel: { fontSize: 13, fontWeight: "700" },
  btnSub:   { fontSize: 10, color: "#9CA3AF", textAlign: "center" },
});

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function ExamDetailScreen() {
  const router   = useRouter();
  const { id }   = useLocalSearchParams();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;
  const { t }    = useTranslation();

  const [exam,       setExam]       = useState(null);
  const [subjects,   setSubjects]   = useState([]);
  const [results,    setResults]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab,  setActiveTab]  = useState("overview");
  const [processing, setProcessing] = useState(false);

  // classId → class name, from the synced classes table. An exam subject knows
  // only its classId, so without this every per-class header reads the same.
  const [classNameById, setClassNameById] = useState({});

  // ── Class picker ──────────────────────────────────────────
  const [classPickerVisible, setClassPickerVisible] = useState(false);
  // ✅ Store callback in ref — not state — to avoid React calling it as lazy init
  const classPickerCallbackRef = useRef(null);

  // ── Reject modal ──────────────────────────────────────────
  // ✅ Cross-platform — replaces Alert.prompt (Android crash)
  const [rejectModal,   setRejectModal]   = useState(null); // null | subject
  const [coeffModal,    setCoeffModal]    = useState(null); // null | subject
  const [coeffSaving,   setCoeffSaving]   = useState(false);
  const [rejectLoading, setRejectLoading] = useState(false);

  // ── UUID guard ────────────────────────────────────────────
  useEffect(() => {
    if (id && !isValidId(id)) {
      console.warn(`[ExamDetail] Invalid id: "${id}" — redirecting`);
      router.replace("/admin/exams");
    }
  }, [id]);

  // ── Load data ─────────────────────────────────────────────

  const loadData = useCallback(async (isRefresh = false) => {
    if (!id || !isValidId(id)) {
      setLoading(false);
      return;
    }
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);

      // Classes come from the local table, so the per-class headers are right
      // offline too — which is the normal state at a school.
      const [examRes, subRes, resultRes, classList] = await Promise.all([
        ExamService.getExamById(id, schoolId),
        ExamService.getSubmissions({ examId: id, schoolId }),
        ExamService.getResults({ examId: id, schoolId }),
        getClassesList().catch(() => []),
      ]);

      setExam(examRes?.exam           || null);
      setSubjects(subRes?.submissions || []);
      setResults(resultRes?.results   || []);

      setClassNameById(
        Object.fromEntries(
          (classList || [])
            .map((c) => [String(c.id || c._id), c.name || c.className])
            .filter(([cid, name]) => cid && name)
        )
      );
    } catch (err) {
      console.error("ExamDetail load failed:", err.message);
      Alert.alert(t("examDetail.errorTitle"), t("examDetail.loadFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, schoolId, t]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Derived data ──────────────────────────────────────────

  const classes = useMemo(
    () => deriveClasses(subjects, exam, t),
    [subjects, exam, t]
  );

  const submissionStats = useMemo(() => ({
    total:     subjects.length,
    submitted: subjects.filter((s) => s.submissionStatus === "submitted").length,
    approved:  subjects.filter((s) => s.submissionStatus === "approved").length,
    rejected:  subjects.filter((s) => s.submissionStatus === "rejected").length,
    pending:   subjects.filter((s) => s.submissionStatus === "pending").length,
  }), [subjects]);

  const resultStats = useMemo(() => {
    const total   = results.length;
    const passing = results.filter((r) => r.isPassing).length;
    const avg     = total > 0
      ? Math.round(
          results.reduce((s, r) => s + (r.percentage || 0), 0) / total
        )
      : 0;
    return { total, passing, failing: total - passing, avg };
  }, [results]);

  // ── Per-class sections ────────────────────────────────────
  // When the exam spans several classes the submissions and results are
  // rendered under one header per class instead of one flat list.
  const subjectGroups = useMemo(
    () => groupByClass(subjects, exam, t, classNameById),
    [subjects, exam, t, classNameById]
  );

  const resultGroups = useMemo(
    () => groupByClass(results, exam, t, classNameById),
    [results, exam, t, classNameById]
  );

  // ── Mark entry navigation ─────────────────────────────────

  const navigateToMarks = useCallback((classId, subject = null) => {
    const params = {
      examId:   id,
      examName: exam?.name || "",
      classId:  classId   || "",
    };
    if (subject) {
      Object.assign(params, {
        subjectId:     subject.subjectId,
        subjectName:   subject.subjectName   || "",
        examSubjectId: subject._id || subject.id,
        maxScore:      String(subject.maxScore ?? 100),
        passMark:      String(subject.passMark ?? 50),
      });
    }
    router.push({ pathname: "/admin/exams/marks", params });
  }, [id, exam, router]);

  const openMarkEntry = useCallback((subject = null) => {
    if (subject?.classId) {
      navigateToMarks(subject.classId, subject);
      return;
    }
    if (classes.length === 0) {
      navigateToMarks(exam?.classId || "", subject);
      return;
    }
    if (classes.length === 1) {
      navigateToMarks(classes[0].classId, subject);
      return;
    }
    // ✅ Store in ref — not useState — to avoid lazy-init call
    classPickerCallbackRef.current = (cls) => {
      setClassPickerVisible(false);
      navigateToMarks(cls.classId, subject);
    };
    setClassPickerVisible(true);
  }, [classes, exam, navigateToMarks]);

  // ── Status change ─────────────────────────────────────────

  const handleStatusChange = useCallback(() => {
    const options = Object.entries(STATUS_META).filter(
      ([s]) => s !== exam?.status
    );
    Alert.alert(
      t("examDetail.statusTitle"),
      t("examDetail.statusCurrent", {
        status: STATUS_META[exam?.status]
          ? t(STATUS_META[exam.status].labelKey)
          : exam?.status,
      }),
      [
        ...options.map(([s, m]) => ({
          text:    t(m.labelKey),
          onPress: async () => {
            try {
              await ExamService.updateExamStatus(id, s, schoolId);
              loadData(true);
            } catch (err) {
              Alert.alert(
                t("examDetail.errorTitle"),
                errorText(t, err, "examDetail.statusUpdateFailed")
              );
            }
          },
        })),
        { text: t("examDetail.cancel"), style: "cancel" },
      ]
    );
  }, [t, exam.status, id, schoolId, loadData]);

  // ── Process ───────────────────────────────────────────────

  const handleProcess = useCallback(async () => {
    Alert.alert(
      t("examDetail.processResults"),
      t("examDetail.processBody"),
      [
        { text: t("examDetail.cancel"), style: "cancel" },
        {
          text:    t("examDetail.process"),
          onPress: async () => {
            try {
              setProcessing(true);
              const res = await ExamService.processResults({
                examId:   id,
                // No classId, deliberately.
                //
                // It is a NARROWING parameter — process only this class — and the
                // exam's own classId is not that. An exam's class is the one it was
                // created for; its marks are wherever the pupils actually are. On
                // this school's data one exam holds all seven of its marks under a
                // different class, so this filter matched nothing and the phone
                // answered "Results processed for 0 student(s)". Another spans two
                // classes and would have processed four marks of ten, silently.
                //
                // The web has always sent examId alone. That is why the same button
                // worked there and not here.
                schoolId,
              });
              Alert.alert(
                t("examDetail.doneTitle"),
                res?.message ||
                  t("examDetail.processedCount", {
                    count: res?.processed ?? 0,
                  }),
                [{
                  text:    t("examDetail.ok"),
                  onPress: () => loadData(true),
                }]
              );
            } catch (err) {
              Alert.alert(
                t("examDetail.failedTitle"),
                errorText(t, err, "examDetail.processFailed")
              );
            } finally {
              setProcessing(false);
            }
          },
        },
      ]
    );
  }, [t, id, schoolId, loadData]);

  // ── Publish ───────────────────────────────────────────────

  const handlePublish = useCallback(() => {
    Alert.alert(
      t("examDetail.publishTitle"),
      t("examDetail.publishBody"),
      [
        { text: t("examDetail.cancel"), style: "cancel" },
        {
          text:    t("examDetail.publish"),
          onPress: async () => {
            try {
              await ExamService.updateExamStatus(id, "published", schoolId);
              loadData(true);
            } catch (err) {
              Alert.alert(
                t("examDetail.errorTitle"),
                errorText(t, err, "examDetail.publishFailed")
              );
            }
          },
        },
      ]
    );
  }, [t, id, schoolId, loadData]);

  // ── Approve ───────────────────────────────────────────────

  const handleApprove = useCallback(async (subject) => {
    try {
      await ExamService.approveSubmission({
        examId:        id,
        examSubjectId: subject._id || subject.id,
        schoolId,
      });
      loadData(true);
    } catch (err) {
      Alert.alert(t("examDetail.errorTitle"), errorText(t, err));
    }
  }, [id, schoolId, loadData, t]);

  // ── Coefficient (opens modal — Alert.prompt is iOS-only) ──

  const handleEditCoeff = useCallback((subject) => {
    setCoeffModal(subject);
  }, []);

  const confirmCoeff = useCallback(async (coefficient) => {
    if (!coeffModal) return;
    try {
      setCoeffSaving(true);
      const res = await ExamService.updateExamSubject({
        examId:        id,
        examSubjectId: coeffModal._id || coeffModal.id,
        updates:       { weight: Math.round(coefficient * 100) },
        schoolId,
        cachedRow:     coeffModal,
      });
      setCoeffModal(null);
      loadData(true);
      if (res.reprocessRequired) {
        Alert.alert(
          t("examDetail.reprocessTitle"),
          t("examDetail.reprocessBody")
        );
      }
    } catch (err) {
      Alert.alert(t("examDetail.errorTitle"), errorText(t, err));
    } finally {
      setCoeffSaving(false);
    }
  }, [coeffModal, id, schoolId, loadData, t]);

  // ── Reject (opens modal — no Alert.prompt) ────────────────

  const handleReject = useCallback((subject) => {
    setRejectModal(subject);
  }, []);

  const confirmReject = useCallback(async (reason) => {
    if (!rejectModal) return;
    try {
      setRejectLoading(true);
      await ExamService.rejectSubmission({
        examId:        id,
        examSubjectId: rejectModal._id || rejectModal.id,
        reason,
        schoolId,
      });
      setRejectModal(null);
      loadData(true);
    } catch (err) {
      Alert.alert(t("examDetail.errorTitle"), errorText(t, err));
    } finally {
      setRejectLoading(false);
    }
  }, [rejectModal, id, schoolId, loadData, t]);

  // ─────────────────────────────────────────────────────────
  // RENDER GUARDS
  // ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("examDetail.loadingExam")}</Text>
      </View>
    );
  }

  if (!id || !isValidId(id)) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>{t("examDetail.redirecting")}</Text>
      </View>
    );
  }

  if (!exam) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={48} color="#DC2626" />
        <Text style={styles.loadingText}>{t("examDetail.notFound")}</Text>
        <TouchableOpacity
          style={styles.backBtnLarge}
          onPress={() => router.back()}
        >
          <Text style={styles.backBtnLargeText}>{t("examDetail.goBack")}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const statusMeta = STATUS_META[exam.status] || STATUS_META.draft;

  const examClassDisplay =
    exam.classNames ||
    (classes.length > 0
      ? classes.map((c) => c.className).join(", ")
      : resolveClassName(exam) || exam.className || t("examDetail.allClasses"));

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* ── Modals ───────────────────────────────────────── */}
      <ClassPickerModal
        visible={classPickerVisible}
        classes={classes}
        examName={exam.name}
        t={t}
        onSelect={(cls) => classPickerCallbackRef.current?.(cls)}
        onClose={() => setClassPickerVisible(false)}
      />

      <CoeffModal
        visible={!!coeffModal}
        subject={coeffModal}
        saving={coeffSaving}
        onConfirm={confirmCoeff}
        onCancel={() => setCoeffModal(null)}
      />
      <RejectModal
        visible={!!rejectModal}
        subjectName={rejectModal?.subjectName}
        onConfirm={confirmReject}
        onCancel={() => setRejectModal(null)}
      />

      {/* ── Header ───────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {exam.name}
          </Text>
          <Text style={styles.headerSub}>
            {examTypeLabel(t, exam.type)}
            {" · "}{exam.academicYear}
            {" · "}{exam.term}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.statusBadge, { backgroundColor: statusMeta.bg }]}
          onPress={handleStatusChange}
          activeOpacity={0.7}
        >
          <Text style={[styles.statusText, { color: statusMeta.color }]}>
            {t(statusMeta.labelKey)}
          </Text>
          <Ionicons name="chevron-down" size={12} color={statusMeta.color} />
        </TouchableOpacity>
      </View>

      {/* ── Tab bar ──────────────────────────────────────── */}
      <View style={styles.tabBar}>
        {[
          { key: "overview",    label: t("examDetail.tabOverview"),    icon: "information-circle-outline" },
          { key: "submissions", label: t("examDetail.tabSubmissions"), icon: "cloud-upload-outline"       },
          { key: "results",     label: t("examDetail.tabResults"),     icon: "bar-chart-outline"          },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={tab.icon}
              size={15}
              color={activeTab === tab.key ? "#4F46E5" : "#9CA3AF"}
            />
            <Text style={[
              styles.tabText,
              activeTab === tab.key && styles.tabTextActive,
            ]}>
              {tab.label}
            </Text>
            {tab.key === "submissions" && submissionStats.pending > 0 && (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>
                  {submissionStats.pending}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Content ──────────────────────────────────────── */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadData(true)}
            tintColor="#4F46E5"
            colors={["#4F46E5"]}
          />
        }
      >

        {/* ── OVERVIEW ── */}
        {activeTab === "overview" && (
          <>
            <QuickActions
              exam={exam}
              subjects={subjects}
              onEnterMarks={() => openMarkEntry()}
              onProcess={handleProcess}
              onPublish={handlePublish}
              processing={processing}
              router={router}
              id={id}
              t={t}
            />

            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {t("examDetail.detailsTitle")}
              </Text>
              <InfoRow
                icon="document-text-outline"
                label={t("examDetail.fieldName")}
                value={exam.name}
              />
              <InfoRow
                icon="grid-outline"
                label={t("examDetail.fieldType")}
                value={examTypeLabel(t, exam.type)}
              />
              <InfoRow
                icon="school-outline"
                label={t("examDetail.fieldClasses")}
                value={examClassDisplay}
              />
              <InfoRow
                icon="calendar-outline"
                label={t("examDetail.fieldYear")}
                value={exam.academicYear}
              />
              <InfoRow
                icon="layers-outline"
                label={t("examDetail.fieldTerm")}
                value={exam.term}
              />
              <InfoRow
                icon="play-outline"
                label={t("examDetail.fieldStart")}
                value={exam.startDate}
              />
              <InfoRow
                icon="stop-outline"
                label={t("examDetail.fieldEnd")}
                value={exam.endDate}
              />
              <InfoRow
                icon="trophy-outline"
                label={t("examDetail.fieldTotal")}
                value={String(exam.totalMarks ?? 100)}
              />
              <InfoRow
                icon="checkmark-circle-outline"
                label={t("examDetail.fieldPass")}
                value={String(exam.passMark ?? 50)}
              />
            </View>

            {!!exam.description && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {t("examDetail.descriptionTitle")}
                </Text>
                <Text style={styles.bodyText}>{exam.description}</Text>
              </View>
            )}

            {!!exam.instructions && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {t("examDetail.instructionsTitle")}
                </Text>
                <Text style={styles.bodyText}>{exam.instructions}</Text>
              </View>
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {t("examDetail.submissionSummary")}
              </Text>
              <View style={styles.statRow}>
                {[
                  { id: "total",     label: t("examDetail.statTotal"),     val: submissionStats.total,     color: "#6B7280" },
                  { id: "pending",   label: t("examDetail.statPending"),   val: submissionStats.pending,   color: "#D97706" },
                  { id: "submitted", label: t("examDetail.statSubmitted"), val: submissionStats.submitted, color: "#4F46E5" },
                  { id: "approved",  label: t("examDetail.statApproved"),  val: submissionStats.approved,  color: "#059669" },
                  { id: "rejected",  label: t("examDetail.statRejected"),  val: submissionStats.rejected,  color: "#DC2626" },
                ].map((s) => (
                  <View
                    key={s.id}
                    style={[styles.statChip, { backgroundColor: s.color + "12" }]}
                  >
                    <Text style={[styles.statVal, { color: s.color }]}>
                      {s.val}
                    </Text>
                    <Text style={styles.statLbl}>{s.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {/* ── SUBMISSIONS ── */}
        {activeTab === "submissions" && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {t("examDetail.markEntryStatus")}
              </Text>
              <View style={styles.statRow}>
                {[
                  { id: "pending",   label: t("examDetail.statPending"),   val: submissionStats.pending,   color: "#D97706" },
                  { id: "submitted", label: t("examDetail.statSubmitted"), val: submissionStats.submitted, color: "#4F46E5" },
                  { id: "approved",  label: t("examDetail.statApproved"),  val: submissionStats.approved,  color: "#059669" },
                  { id: "rejected",  label: t("examDetail.statRejected"),  val: submissionStats.rejected,  color: "#DC2626" },
                ].map((s) => (
                  <View
                    key={s.id}
                    style={[styles.statChip, { backgroundColor: s.color + "12" }]}
                  >
                    <Text style={[styles.statVal, { color: s.color }]}>
                      {s.val}
                    </Text>
                    <Text style={styles.statLbl}>{s.label}</Text>
                  </View>
                ))}
              </View>
            </View>

            <TouchableOpacity
              style={styles.enterMarksBtn}
              onPress={() => openMarkEntry()}
              activeOpacity={0.8}
            >
              <Ionicons name="create-outline" size={18} color="#FFF" />
              <Text style={styles.enterMarksBtnText}>
                {t("examDetail.enterAllMarks")}
              </Text>
            </TouchableOpacity>

            {subjects.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="document-outline" size={48} color="#D1D5DB" />
                <Text style={styles.emptyTitle}>
                  {t("examDetail.noSubjects")}
                </Text>
                <Text style={styles.emptySub}>
                  {t("examDetail.noSubjectsSub")}
                </Text>
              </View>
            ) : (
              subjectGroups.map((group) => (
                <View
                  key={group.classId || "no-class"}
                  style={styles.classSection}
                >
                  {subjectGroups.length > 1 && (
                    <View style={styles.classSectionHeader}>
                      <View style={styles.classSectionIcon}>
                        <Ionicons
                          name="school-outline"
                          size={13}
                          color="#4F46E5"
                        />
                      </View>
                      <Text style={styles.classSectionTitle} numberOfLines={1}>
                        {group.className}
                      </Text>
                      <Text style={styles.classSectionCount}>
                        {group.items.length}
                      </Text>
                    </View>
                  )}
                  {group.items.map((s) => (
                    <SubmissionCard
                      key={`${s._id || s.id}-${s.classId}`}
                      subject={s}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onEnterMarks={openMarkEntry}
                      onEditCoeff={handleEditCoeff}
                    />
                  ))}
                </View>
              ))
            )}
          </>
        )}

        {/* ── RESULTS ── */}
        {activeTab === "results" && (
          <>
            <TouchableOpacity
              style={[
                styles.enterMarksBtn,
                { backgroundColor: "#2563EB", marginBottom: 16 },
              ]}
              onPress={() =>
                router.push({
                  pathname: "/admin/exams/results/[examId]",
                  params:   { examId: id },
                })
              }
              activeOpacity={0.8}
            >
              <Ionicons name="analytics-outline" size={18} color="#FFF" />
              <Text style={styles.enterMarksBtnText}>
                {t("examDetail.openDashboard")}
              </Text>
            </TouchableOpacity>

            {results.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {t("examDetail.resultsSummary")}
                </Text>
                <View style={styles.statRow}>
                  {[
                    { id: "students", label: t("examDetail.statStudents"), val: resultStats.total,     color: "#4F46E5" },
                    { id: "passed",   label: t("examDetail.statPassed"),   val: resultStats.passing,   color: "#059669" },
                    { id: "failed",   label: t("examDetail.statFailed"),   val: resultStats.failing,   color: "#DC2626" },
                    { id: "average",  label: t("examDetail.statAverage"),  val: `${resultStats.avg}%`, color: "#D97706" },
                  ].map((s) => (
                    <View
                      key={s.id}
                      style={[styles.statChip, { backgroundColor: s.color + "12" }]}
                    >
                      <Text style={[styles.statVal, { color: s.color }]}>
                        {s.val}
                      </Text>
                      <Text style={styles.statLbl}>{s.label}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.enterMarksBtn,
                { backgroundColor: "#059669" },
                processing && { opacity: 0.6 },
              ]}
              onPress={handleProcess}
              disabled={processing}
              activeOpacity={0.8}
            >
              {processing
                ? <ActivityIndicator size="small" color="#FFF" />
                : <Ionicons name="calculator-outline" size={18} color="#FFF" />
              }
              <Text style={styles.enterMarksBtnText}>
                {results.length > 0
                  ? t("examDetail.reprocessResults")
                  : t("examDetail.processResults")}
              </Text>
            </TouchableOpacity>

            {results.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="bar-chart-outline" size={48} color="#D1D5DB" />
                <Text style={styles.emptyTitle}>
                  {t("examDetail.noResults")}
                </Text>
                <Text style={styles.emptySub}>
                  {t("examDetail.noResultsSub")}
                </Text>
              </View>
            ) : (
              resultGroups.map((group) => (
                <View
                  key={group.classId || "no-class"}
                  style={styles.classSection}
                >
                  {resultGroups.length > 1 && (
                    <View style={styles.classSectionHeader}>
                      <View style={styles.classSectionIcon}>
                        <Ionicons
                          name="school-outline"
                          size={13}
                          color="#4F46E5"
                        />
                      </View>
                      <Text style={styles.classSectionTitle} numberOfLines={1}>
                        {group.className}
                      </Text>
                      <Text style={styles.classSectionCount}>
                        {group.items.length}
                      </Text>
                    </View>
                  )}
                  {group.items.map((r) => (
                    <ResultCard
                      key={r._id || r.id || r.studentId}
                      result={r}
                    />
                  ))}
                </View>
              ))
            )}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  centered: {
    flex:            1,
    justifyContent:  "center",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
    gap:             12,
  },
  loadingText: { color: "#6B7280", fontSize: 14 },
  backBtnLarge: {
    backgroundColor:   "#4F46E5",
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 24,
    marginTop:         8,
  },
  backBtnLargeText: { color: "#FFF", fontWeight: "700" },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        60,
    paddingBottom:     14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:  { flex: 1 },
  headerTitle:   { fontSize: 16, fontWeight: "700", color: "#111827" },
  headerSub:     { fontSize: 11, color: "#6B7280", marginTop: 2 },
  statusBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   6,
  },
  statusText: { fontSize: 12, fontWeight: "700" },

  tabBar: {
    flexDirection:     "row",
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  tab: {
    flex:              1,
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               5,
    paddingVertical:   12,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive:     { borderBottomColor: "#4F46E5" },
  tabText:       { fontSize: 12, color: "#9CA3AF", fontWeight: "600" },
  tabTextActive: { color: "#4F46E5" },
  tabBadge: {
    backgroundColor:   "#DC2626",
    borderRadius:      8,
    paddingHorizontal: 5,
    paddingVertical:   1,
  },
  tabBadgeText: { fontSize: 9, fontWeight: "700", color: "#FFF" },

  scroll: { padding: 16 },

  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardTitle: {
    fontSize:     14,
    fontWeight:   "700",
    color:        "#111827",
    marginBottom: 12,
  },
  bodyText: { fontSize: 14, color: "#374151", lineHeight: 22 },

  statRow:  { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  statChip: {
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   8,
    alignItems:        "center",
    minWidth:          60,
  },
  statVal: { fontSize: 16, fontWeight: "800" },
  statLbl: {
    fontSize:      9,
    color:         "#6B7280",
    fontWeight:    "600",
    textTransform: "uppercase",
  },

  enterMarksBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: "#4F46E5",
    borderRadius:    14,
    paddingVertical: 14,
    marginBottom:    12,
  },
  enterMarksBtnText: { color: "#FFF", fontWeight: "700", fontSize: 15 },

  // Per-class sections (multi-class exam — subjects & results grouped)
  classSection: { marginBottom: 14 },
  classSectionHeader: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginBottom:  10,
    paddingVertical: 6,
    backgroundColor: "#EEF2FF",
    borderRadius:  10,
  },
  classSectionIcon: {
    width:           24,
    height:          24,
    borderRadius:    8,
    backgroundColor: "#FFFFFF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  classSectionTitle: {
    flex:        1,
    fontSize:    14,
    fontWeight:  "700",
    color:       "#3730A3",
  },
  classSectionCount: {
    backgroundColor:   "#FFFFFF",
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      10,
    minWidth:          22,
    textAlign:         "center",
  },

  empty: {
    alignItems:      "center",
    paddingVertical: 60,
    gap:             10,
  },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: "#374151" },
  emptySub:   { fontSize: 13, color: "#9CA3AF", textAlign: "center" },
});