// mobile/app/admin/students/detail.js
import { useEffect, useState, useCallback, useRef } from "react";
import {
  View, Text, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, StyleSheet,
  Clipboard, Platform, Modal,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons }                        from "@expo/vector-icons";
import * as Haptics                        from "expo-haptics";

import { getDatabase }    from "@/db/database";
import { useAuthStore }   from "@/store/auth.store";
import StudentService     from "@/services/student.service";
import api                from "@/services/api";
import { getStudentStatusConfig } from "@/utils/studentStatus";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const formatDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
};

/**
 * Delegates to the shared mapping. The version that lived here only knew
 * "suspended" and "inactive" and defaulted everything else to "Active", so a
 * pending student was listed as Pending and shown here as Active.
 */
const getStatusConfig = getStudentStatusConfig;

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

function InfoRow({ icon, label, value, mono = false }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={16} color="#9CA3AF" style={styles.infoIcon} />
      <View style={styles.infoText}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={[styles.infoValue, mono && styles.mono]}>{value}</Text>
      </View>
    </View>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ActionButton({ icon, label, description, onPress, variant = "default", disabled }) {
  const colors = {
    default: { bg: "#EEF2FF", border: "#C7D2FE", text: "#3730A3" },
    warning: { bg: "#FFFBEB", border: "#FDE68A", text: "#92400E" },
    danger:  { bg: "#FEF2F2", border: "#FECACA", text: "#991B1B" },
    success: { bg: "#ECFDF5", border: "#A7F3D0", text: "#065F46" },
  };
  const c = colors[variant];

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.actionBtn,
        { backgroundColor: c.bg, borderColor: c.border },
        disabled && styles.disabled,
      ]}
      activeOpacity={0.75}
    >
      <View style={[styles.actionIcon, { backgroundColor: "#fff" }]}>
        <Ionicons name={icon} size={18} color={c.text} />
      </View>
      <View style={styles.actionText}>
        <Text style={[styles.actionLabel, { color: c.text }]}>{label}</Text>
        <Text style={styles.actionDesc}>{description}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────
// ENROLLMENT CARD
// ─────────────────────────────────────────────────────────

function EnrollmentCard({ enrollmentNo, mustResetPassword, studentId }) {
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting]     = useState(false);
  const [newCreds, setNewCreds]       = useState(null); // { tempPassword }
  const [resetNote, setResetNote]     = useState(null); // non-secret outcome
  const [newCopied, setNewCopied]     = useState(false);

  const handleCopy = useCallback(() => {
    if (!enrollmentNo) return;
    Clipboard.setString(enrollmentNo);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [enrollmentNo]);

  // ── Re-issue credentials ─────────────────────────────────
  //
  // Mirrors the teacher reset flow: confirm first, then POST /students/:id/
  // reset-password. When no email went out the new password comes back in
  // the response and is shown ONCE here — same contract as enrollment.
  const handleReset = useCallback(() => {
    if (!studentId || resetting) return;
    Alert.alert(
      "Reset password?",
      "A new temporary password will be generated. The current one stops working immediately.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            setResetting(true);
            setNewCreds(null);
            setResetNote(null);
            try {
              const { data } = await api.post(
                `/students/${studentId}/reset-password`
              );
              if (!data?.success) {
                throw new Error(data?.message || "Reset failed");
              }
              if (data.tempPassword) {
                setNewCreds({ tempPassword: data.tempPassword });
              } else {
                setResetNote(
                  data.message ||
                    "Password reset. New credentials were emailed to the student."
                );
              }
            } catch (err) {
              Alert.alert(
                "Could not reset",
                err?.response?.data?.message || err?.message || "Please try again."
              );
            } finally {
              setResetting(false);
            }
          },
        },
      ]
    );
  }, [studentId, resetting]);

  const handleCopyNew = useCallback(() => {
    if (!newCreds) return;
    Clipboard.setString(newCreds.tempPassword);
    setNewCopied(true);
    setTimeout(() => setNewCopied(false), 2000);
  }, [newCreds]);

  if (!enrollmentNo) return null;

  return (
    <View style={styles.enrollCard}>
      <View style={styles.enrollHeader}>
        <Ionicons name="card-outline" size={16} color="#4F46E5" />
        <Text style={styles.enrollTitle}>Login Credentials</Text>
      </View>

      <Text style={styles.enrollHint}>
        The student uses this enrollment number to log in. Their first
        password is generated automatically — shown once when the student was
        enrolled (or sent by email). They will set their own password at
        first login.
      </Text>

      <View style={styles.enrollRow}>
        <Text style={styles.enrollNo} selectable>{enrollmentNo}</Text>
        <TouchableOpacity onPress={handleCopy} style={[
          styles.copyBtn,
          copied && styles.copyBtnCopied,
        ]}>
          <Text style={[styles.copyBtnText, copied && styles.copyBtnTextCopied]}>
            {copied ? "✓ Copied" : "Copy"}
          </Text>
        </TouchableOpacity>
      </View>

      {mustResetPassword && (
        <View style={styles.resetWarning}>
          <Ionicons name="shield-outline" size={14} color="#92400E" />
          <Text style={styles.resetWarningText}>
            <Text style={{ fontWeight: "700" }}>Password not yet changed.</Text>
            {" "}The student is still using their generated first password.
          </Text>
        </View>
      )}

      {/* ── Reset action + one-time result ── */}
      {!newCreds && !resetNote && (
        <TouchableOpacity
          onPress={handleReset}
          disabled={resetting || !studentId}
          style={[styles.resetBtn, (resetting || !studentId) && styles.disabled]}
          activeOpacity={0.75}
        >
          <Ionicons name="key-outline" size={14} color="#92400E" />
          <Text style={styles.resetBtnText}>
            {resetting ? "Resetting…" : "Forgot password? Reset it"}
          </Text>
        </TouchableOpacity>
      )}

      {newCreds && (
        <View style={styles.newCredsBox}>
          <Text style={styles.newCredsTitle}>New temporary password</Text>
          <View style={styles.enrollRow}>
            <Text style={styles.enrollNo} selectable>{newCreds.tempPassword}</Text>
            <TouchableOpacity onPress={handleCopyNew} style={[
              styles.copyBtn,
              newCopied && styles.copyBtnCopied,
            ]}>
              <Text style={[styles.copyBtnText, newCopied && styles.copyBtnTextCopied]}>
                {newCopied ? "✓ Copied" : "Copy"}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.newCredsHint}>
            Shown once — write it down or share it now. The student must set a
            new password at next login.
          </Text>
        </View>
      )}

      {!!resetNote && (
        <View style={styles.resetWarning}>
          <Ionicons name="checkmark-circle-outline" size={14} color="#065F46" />
          <Text style={[styles.resetWarningText, { color: "#065F46" }]}>
            {resetNote}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// MOVE CLASS PICKER MODAL
// ─────────────────────────────────────────────────────────

function MoveClassPicker({ visible, classes, currentClassId, onSelect, onCancel }) {
  const others = (classes || []).filter(
    (c) => String(c._id ?? c.id) !== String(currentClassId ?? "")
  );

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <Ionicons name="swap-horizontal-outline" size={20} color="#4F46E5" />
            <Text style={styles.modalTitle}>Move to Class</Text>
          </View>

          {others.length === 0 ? (
            <View style={styles.modalEmpty}>
              <Ionicons name="alert-circle-outline" size={16} color="#92400E" />
              <Text style={styles.modalEmptyText}>
                No other classes available. Create more classes first.
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.modalList}>
              {others.map((cls, i) => (
                <TouchableOpacity
                  key={cls._id ?? cls.id}
                  onPress={() => onSelect(cls)}
                  style={[
                    styles.modalItem,
                    i < others.length - 1 && styles.modalItemBorder,
                  ]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="school-outline" size={16} color="#4F46E5" />
                  <View style={{ marginLeft: 10 }}>
                    <Text style={styles.modalItemName}>{cls.name}</Text>
                    {cls.level && (
                      <Text style={styles.modalItemLevel}>Level {cls.level}</Text>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <TouchableOpacity onPress={onCancel} style={styles.modalCancel}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function StudentDetailScreen() {
  const { studentId }    = useLocalSearchParams();
  const router           = useRouter();
  const { user }         = useAuthStore();
  const schoolId         = user?.schoolId ?? "";

  const [student,        setStudent]        = useState(null);
  const [classes,        setClasses]        = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState(null);
  const [isBusy,         setIsBusy]         = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const baseUpdatedAtRef = useRef(null);

  // ── Load student ────────────────────────────────────────

  const loadStudent = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const db = await getDatabase();

      const rows = await db.getAllAsync(
        "SELECT * FROM students WHERE id = ? LIMIT 1",
        [studentId]
      );

      if (rows.length > 0) {
        const loaded = rows[0];
        setStudent(loaded);
        // Capture the version we started editing from — for LWW conflict detection
        baseUpdatedAtRef.current = loaded.updatedAt || loaded.updated_at || null;
        console.log("[detail] 📌 base_updated_at captured:", baseUpdatedAtRef.current);
      } else {
        setError("Student not found.");
      }

      const cls = await db.getAllAsync(
        "SELECT * FROM classes WHERE schoolId = ? ORDER BY name ASC",
        [schoolId]
      );
      setClasses(cls);
    } catch (err) {
      setError(err?.message || "Failed to load student.");
    } finally {
      setLoading(false);
    }
  }, [studentId, schoolId]);

  useEffect(() => { loadStudent(); }, [loadStudent]);

  // ── Mutations ───────────────────────────────────────────

  const withConfirm = useCallback(async (title, message, action) => {
    return new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: action,   style: action === "Delete" ? "destructive" : "default",
          onPress: () => resolve(true) },
      ]);
    });
  }, []);

  const handleSuspend = useCallback(async () => {
    const yes = await withConfirm(
      "Suspend Student",
      `Suspend "${student?.name}"? They will not be able to log in until restored.`,
      "Suspend"
    );
    if (!yes) return;
    setIsBusy(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const result = await StudentService.suspend(studentId, {
        baseUpdatedAt: baseUpdatedAtRef.current,
      });
      if (result?.overwrote) {
        console.log("[detail] ⚠️ Overwrite detected:", result.overwrote);
      }
      const now = new Date().toISOString();
      setStudent((s) => ({ ...s, status: "suspended", updatedAt: now }));
      baseUpdatedAtRef.current = now;
      Alert.alert("Suspended", `${student?.name} has been suspended.`);
    } catch (err) {
      Alert.alert("Error", err?.response?.data?.message || err?.message || "Failed to suspend.");
    } finally {
      setIsBusy(false);
    }
  }, [student, studentId, withConfirm]);

  const handleRestore = useCallback(async () => {
    const yes = await withConfirm(
      "Restore Student",
      `Restore "${student?.name}" and re-enable their account?`,
      "Restore"
    );
    if (!yes) return;
    setIsBusy(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const result = await StudentService.restore(studentId, {
        baseUpdatedAt: baseUpdatedAtRef.current,
      });
      if (result?.overwrote) {
        console.log("[detail] ⚠️ Overwrite detected:", result.overwrote);
      }
      const now = new Date().toISOString();
      setStudent((s) => ({ ...s, status: "approved", updatedAt: now }));
      baseUpdatedAtRef.current = now;
      Alert.alert("Restored", `${student?.name} has been restored.`);
    } catch (err) {
      Alert.alert("Error", err?.response?.data?.message || err?.message || "Failed to restore.");
    } finally {
      setIsBusy(false);
    }
  }, [student, studentId, withConfirm]);

  const handleDelete = useCallback(async () => {
    const yes = await withConfirm(
      "Delete Student",
      `Permanently delete "${student?.name}"? This cannot be undone.`,
      "Delete"
    );
    if (!yes) return;
    setIsBusy(true);
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      const result = await StudentService.delete(studentId, {
        baseUpdatedAt: baseUpdatedAtRef.current,
      });
      if (result?.overwrote) {
        console.log("[detail] ⚠️ Overwrite detected:", result.overwrote);
      }
      Alert.alert("Deleted", `${student?.name} has been removed.`, [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      setIsBusy(false);
      Alert.alert("Error", err?.response?.data?.message || err?.message || "Failed to delete.");
    }
  }, [student, studentId, router, withConfirm]);

  const handleMoveSelect = useCallback(async (cls) => {
    const classId = String(cls._id ?? cls.id);
    const yes = await withConfirm(
      "Move Student",
      `Move "${student?.name}" to "${cls.name}"?`,
      "Move"
    );
    if (!yes) { setShowMovePicker(false); return; }
    setIsBusy(true);
    setShowMovePicker(false);
    try {
      const result = await StudentService.moveToClass(studentId, classId, {
        baseUpdatedAt: baseUpdatedAtRef.current,
      });
      if (result?.overwrote) {
        console.log("[detail] ⚠️ Overwrite detected:", result.overwrote);
      }
      const now = new Date().toISOString();
      setStudent((s) => ({ ...s, className: cls.name, classId, updatedAt: now }));
      baseUpdatedAtRef.current = now;
      Alert.alert("Moved", `${student?.name} moved to ${cls.name}.`);
    } catch (err) {
      Alert.alert("Error", err?.response?.data?.message || err?.message || "Failed to move.");
    } finally {
      setIsBusy(false);
    }
  }, [student, studentId, withConfirm]);

  // ── Derived ─────────────────────────────────────────────

  const isSuspended      = student?.status?.toLowerCase() === "suspended";
  const statusConfig     = getStatusConfig(student?.status);
  const classNameDisplay = student?.className || student?.class_name || student?.class?.name;
  const classIdForMove   = student?.classId   || student?.class_id   || student?.class?._id;
  const enrollmentNo     = student?.enrollmentNo ?? student?.enrollment_no ?? null;
  const mustReset        = student?.mustResetPassword ?? student?.must_reset_password ?? false;
  const firstLetter      = (student?.name || "?").charAt(0).toUpperCase();

  // ── Loading ─────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading student…</Text>
      </View>
    );
  }

  if (error || !student) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
        <Text style={styles.errorTitle}>Student not found</Text>
        <Text style={styles.errorSub}>
          {error || "This student may have been deleted."}
        </Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.errorBtn}>
          <Text style={styles.errorBtnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render ──────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: "#F9FAFB" }}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
          >
            <Ionicons name="chevron-back" size={20} color="#374151" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {student.name}
            </Text>
            <Text style={styles.headerSub}>Student Detail</Text>
          </View>
          <TouchableOpacity onPress={loadStudent} style={styles.refreshBtn}>
            <Ionicons name="refresh-outline" size={18} color="#6B7280" />
          </TouchableOpacity>
        </View>

        {/* Profile card */}
        <View style={styles.profileCard}>
          <View style={[
            styles.avatar,
            { backgroundColor: isSuspended ? "#FEE2E2" : "#EEF2FF" },
          ]}>
            <Text style={[
              styles.avatarText,
              { color: isSuspended ? "#DC2626" : "#4F46E5" },
            ]}>
              {firstLetter}
            </Text>
          </View>

          <View style={{ flex: 1 }}>
            <Text style={styles.profileName} numberOfLines={1}>
              {student.name}
            </Text>

            {enrollmentNo && (
              <Text style={styles.profileEnroll}>{enrollmentNo}</Text>
            )}
            {!enrollmentNo && student.admissionNumber && (
              <Text style={styles.profileAdm}>#{student.admissionNumber}</Text>
            )}

            {/* Badges */}
            <View style={styles.badges}>
              <View style={[
                styles.badge,
                { backgroundColor: statusConfig.bg, borderColor: statusConfig.dot },
              ]}>
                <View style={[styles.badgeDot, { backgroundColor: statusConfig.dot }]} />
                <Text style={[styles.badgeText, { color: statusConfig.color }]}>
                  {statusConfig.label}
                </Text>
              </View>

              {classNameDisplay && classNameDisplay !== "Unassigned" && (
                <View style={styles.badgeIndigo}>
                  <Ionicons name="school-outline" size={11} color="#4338CA" />
                  <Text style={styles.badgeIndigoText}>{classNameDisplay}</Text>
                </View>
              )}

              {mustReset && (
                <View style={styles.badgeAmber}>
                  <Ionicons name="key-outline" size={11} color="#92400E" />
                  <Text style={styles.badgeAmberText}>Password not changed</Text>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Enrollment card */}
        <EnrollmentCard
          enrollmentNo={enrollmentNo}
          mustResetPassword={mustReset}
          studentId={student.id || student._id || null}
        />

        {/* Personal info */}
        <Section title="Personal Information">
          <InfoRow icon="person-outline"   label="Full Name"     value={student.name || student.studentName} />
          <InfoRow icon="mail-outline"     label="Email"         value={student.email} />
          <InfoRow icon="call-outline"     label="Phone"         value={student.phone} />
          <InfoRow icon="calendar-outline" label="Date of Birth" value={formatDate(student.dateOfBirth || student.date_of_birth)} />
          <InfoRow icon="card-outline"     label="Enrollment No" value={enrollmentNo} mono />
          <InfoRow icon="pricetag-outline" label="Admission No"  value={student.admissionNumber || student.admissionNo} />
          <InfoRow icon="person-outline"   label="Gender"        value={student.gender} />
          <InfoRow icon="location-outline" label="Address"       value={student.address} />
        </Section>

        {/* School info */}
        <Section title="School Information">
          <InfoRow icon="school-outline"   label="Class"          value={classNameDisplay} />
          <InfoRow icon="people-outline"   label="Guardian Name"  value={student.guardianName || student.guardian_name} />
          <InfoRow icon="call-outline"     label="Guardian Phone" value={student.guardianPhone || student.guardian_phone} />
          <InfoRow icon="calendar-outline" label="Enrolled On"    value={formatDate(student.enrolledAt || student.enrolled_at || student.approved_at)} />
          <InfoRow icon="calendar-outline" label="Created"        value={formatDate(student.createdAt || student.created_at)} />
          <InfoRow icon="calendar-outline" label="Last Updated"   value={formatDate(student.updatedAt || student.updated_at)} />
        </Section>

        {/* Actions */}
        <View style={styles.actionsSection}>
          <Text style={styles.sectionTitle}>Actions</Text>

          <ActionButton
            icon="swap-horizontal-outline"
            label="Move to Class"
            description="Transfer this student to a different class"
            variant="default"
            disabled={isBusy}
            onPress={() => setShowMovePicker(true)}
          />

          {isSuspended ? (
            <ActionButton
              icon="checkmark-circle-outline"
              label="Restore Student"
              description="Re-enable this student's account"
              variant="success"
              disabled={isBusy}
              onPress={handleRestore}
            />
          ) : (
            <ActionButton
              icon="ban-outline"
              label="Suspend Student"
              description="Temporarily disable this student's account"
              variant="warning"
              disabled={isBusy}
              onPress={handleSuspend}
            />
          )}

          <ActionButton
            icon="trash-outline"
            label="Delete Student"
            description="Permanently remove this student"
            variant="danger"
            disabled={isBusy}
            onPress={handleDelete}
          />
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Move picker modal */}
      <MoveClassPicker
        visible={showMovePicker}
        classes={classes}
        currentClassId={classIdForMove}
        onSelect={handleMoveSelect}
        onCancel={() => setShowMovePicker(false)}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll:          { padding: 16, gap: 12 },
  center:          { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  loadingText:     { marginTop: 12, fontSize: 14, color: "#9CA3AF" },
  errorTitle:      { fontSize: 18, fontWeight: "700", color: "#111827", marginTop: 12 },
  errorSub:        { fontSize: 14, color: "#9CA3AF", textAlign: "center", marginTop: 4 },
  errorBtn:        { marginTop: 16, backgroundColor: "#4F46E5", borderRadius: 12,
                     paddingHorizontal: 20, paddingVertical: 10 },
  errorBtnText:    { color: "#fff", fontWeight: "700", fontSize: 14 },

  header:          { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  backBtn:         { width: 40, height: 40, borderRadius: 12, backgroundColor: "#F3F4F6",
                     alignItems: "center", justifyContent: "center" },
  refreshBtn:      { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6",
                     alignItems: "center", justifyContent: "center" },
  headerTitle:     { fontSize: 20, fontWeight: "800", color: "#111827" },
  headerSub:       { fontSize: 13, color: "#6B7280", marginTop: 1 },

  profileCard:     { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1,
                     borderColor: "#E5E7EB", padding: 16, flexDirection: "row",
                     alignItems: "flex-start", gap: 12, shadowColor: "#000",
                     shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
                     elevation: 2 },
  avatar:          { width: 56, height: 56, borderRadius: 16,
                     alignItems: "center", justifyContent: "center" },
  avatarText:      { fontSize: 24, fontWeight: "800" },
  profileName:     { fontSize: 17, fontWeight: "800", color: "#111827" },
  profileEnroll:   { fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                     fontSize: 13, fontWeight: "700", color: "#4F46E5", marginTop: 2,
                     letterSpacing: 2 },
  profileAdm:      { fontSize: 13, color: "#9CA3AF", marginTop: 2 },
  badges:          { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  badge:           { flexDirection: "row", alignItems: "center", gap: 5,
                     borderRadius: 20, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 },
  badgeDot:        { width: 6, height: 6, borderRadius: 3 },
  badgeText:       { fontSize: 11, fontWeight: "700" },
  badgeIndigo:     { flexDirection: "row", alignItems: "center", gap: 4,
                     backgroundColor: "#EEF2FF", borderRadius: 20, borderWidth: 1,
                     borderColor: "#C7D2FE", paddingHorizontal: 10, paddingVertical: 4 },
  badgeIndigoText: { fontSize: 11, fontWeight: "700", color: "#3730A3" },
  badgeAmber:      { flexDirection: "row", alignItems: "center", gap: 4,
                     backgroundColor: "#FFFBEB", borderRadius: 20, borderWidth: 1,
                     borderColor: "#FDE68A", paddingHorizontal: 10, paddingVertical: 4 },
  badgeAmberText:  { fontSize: 11, fontWeight: "700", color: "#92400E" },

  enrollCard:      { backgroundColor: "#EEF2FF", borderRadius: 16, borderWidth: 1,
                     borderColor: "#C7D2FE", padding: 16 },
  enrollHeader:    { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  enrollTitle:     { fontSize: 14, fontWeight: "800", color: "#1E1B4B" },
  enrollHint:      { fontSize: 12, color: "#4338CA", lineHeight: 18, marginBottom: 12 },
  enrollRow:       { flexDirection: "row", alignItems: "center", backgroundColor: "#fff",
                     borderRadius: 12, borderWidth: 1, borderColor: "#C7D2FE",
                     paddingHorizontal: 14, paddingVertical: 12 },
  enrollNo:        { flex: 1, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                     fontSize: 16, fontWeight: "800", color: "#312E81", letterSpacing: 3 },
  copyBtn:         { backgroundColor: "#EEF2FF", borderRadius: 8,
                     paddingHorizontal: 12, paddingVertical: 6 },
  copyBtnCopied:   { backgroundColor: "#D1FAE5" },
  copyBtnText:     { fontSize: 12, fontWeight: "700", color: "#4338CA" },
  copyBtnTextCopied: { color: "#065F46" },
  resetWarning:    { flexDirection: "row", alignItems: "flex-start", gap: 8,
                     backgroundColor: "#FFFBEB", borderRadius: 10, borderWidth: 1,
                     borderColor: "#FDE68A", padding: 10, marginTop: 10 },
  resetWarningText:{ fontSize: 12, color: "#92400E", flex: 1, lineHeight: 17 },
  resetBtn:        { flexDirection: "row", alignItems: "center", justifyContent: "center",
                     gap: 6, backgroundColor: "#FFFBEB", borderRadius: 10,
                     borderWidth: 1, borderColor: "#FDE68A",
                     paddingVertical: 8, marginTop: 10 },
  resetBtnText:    { fontSize: 12, fontWeight: "700", color: "#92400E" },
  newCredsBox:     { backgroundColor: "#ECFDF5", borderRadius: 10, borderWidth: 1,
                     borderColor: "#A7F3D0", padding: 10, marginTop: 10 },
  newCredsTitle:   { fontSize: 12, fontWeight: "800", color: "#065F46", marginBottom: 6 },
  newCredsHint:    { fontSize: 11, color: "#047857", lineHeight: 15, marginTop: 4 },

  section:         { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1,
                     borderColor: "#E5E7EB", padding: 16, shadowColor: "#000",
                     shadowOpacity: 0.03, shadowRadius: 4, elevation: 1 },
  sectionTitle:    { fontSize: 13, fontWeight: "800", color: "#111827", marginBottom: 14 },

  infoRow:         { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 12 },
  infoIcon:        { marginTop: 2 },
  infoText:        { flex: 1 },
  infoLabel:       { fontSize: 10, fontWeight: "700", color: "#9CA3AF",
                     textTransform: "uppercase", letterSpacing: 0.8 },
  infoValue:       { fontSize: 14, fontWeight: "600", color: "#111827", marginTop: 2 },
  mono:            { fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                     letterSpacing: 2 },

  actionsSection:  { gap: 10 },
  actionBtn:       { flexDirection: "row", alignItems: "center", gap: 12,
                     borderRadius: 14, borderWidth: 1, padding: 14 },
  actionIcon:      { width: 36, height: 36, borderRadius: 10,
                     alignItems: "center", justifyContent: "center",
                     shadowColor: "#000", shadowOpacity: 0.06,
                     shadowRadius: 3, elevation: 1 },
  actionText:      { flex: 1 },
  actionLabel:     { fontSize: 14, fontWeight: "800" },
  actionDesc:      { fontSize: 12, color: "#6B7280", marginTop: 2 },
  disabled:        { opacity: 0.5 },

  modalOverlay:    { flex: 1, backgroundColor: "rgba(0,0,0,0.45)",
                     justifyContent: "center", alignItems: "center", padding: 24 },
  modalSheet:      { backgroundColor: "#fff", borderRadius: 20, padding: 20,
                     width: "100%", maxWidth: 380 },
  modalHeader:     { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  modalTitle:      { fontSize: 17, fontWeight: "800", color: "#111827" },
  modalList:       { maxHeight: 280, borderRadius: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  modalItem:       { flexDirection: "row", alignItems: "center", padding: 14 },
  modalItemBorder: { borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  modalItemName:   { fontSize: 14, fontWeight: "700", color: "#111827" },
  modalItemLevel:  { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  modalEmpty:      { flexDirection: "row", alignItems: "center", gap: 8,
                     backgroundColor: "#FFFBEB", borderRadius: 12, padding: 14 },
  modalEmptyText:  { fontSize: 13, color: "#92400E", flex: 1 },
  modalCancel:     { marginTop: 14, borderRadius: 12, borderWidth: 1,
                     borderColor: "#E5E7EB", paddingVertical: 12, alignItems: "center" },
  modalCancelText: { fontSize: 14, fontWeight: "700", color: "#6B7280" },
});