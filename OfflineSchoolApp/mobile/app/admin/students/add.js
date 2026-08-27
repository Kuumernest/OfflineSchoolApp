// app/admin/students/add.js
import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView as RNSafeAreaView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  Alert,
  Modal,
  FlatList,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import NetInfo from "@react-native-community/netinfo";
import * as Clipboard from "expo-clipboard";
import { ClassService } from "../../../src/services/class.service";
import { useAuthStore } from "../../../src/store/auth.store";
import DateField        from "../../../src/components/DateField";
import { useTranslation } from "../../../src/i18n/useTranslation";
import {
  enrollStudentLocally,
  pushEnrollments,
  getEnrollmentStatus,
} from "../../../src/services/studentEnroll.service";
import { errorText } from "../../../src/utils/appError";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY_FORM = {
  firstName:     "",
  lastName:      "",
  email:         "",
  phone:         "",
  gender:        "",
  dateOfBirth:   "",
  address:       "",
  guardianName:  "",
  guardianPhone: "",
  classId:       "",
};

const SYNC_CONFIG = {
  pending:     { color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "⏳", labelKey: "syncPending"               },
  syncing:     { color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe", icon: "🔄", labelKey: "syncSyncing"                   },
  synced:      { color: "#059669", bg: "#ecfdf5", border: "#a7f3d0", icon: "✅", labelKey: "syncSynced"                    },
  sync_failed: { color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "❌", labelKey: "syncFailed" },
};

// ─────────────────────────────────────────────────────────
// DROP-IN PICKER
// ─────────────────────────────────────────────────────────
function SimpleSelect({
  label,
  value,
  options = [],
  onChange,
  placeholder,
  error = false,
}) {
  const [open, setOpen] = React.useState(false);
  const selected        = options.find((o) => o.value === value);

  return (
    <>
      <TouchableOpacity
        style={[sel.trigger, error && sel.triggerError]}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
      >
        <Text style={[sel.triggerText, !selected && sel.placeholder]}>
          {selected ? selected.label : placeholder}
        </Text>
        <Text style={sel.arrow}>▾</Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <TouchableOpacity
          style={sel.backdrop}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        />

        <View style={sel.sheet}>
          <View style={sel.sheetHeader}>
            <Text style={sel.sheetTitle}>{label}</Text>
            <TouchableOpacity
              onPress={() => setOpen(false)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Text style={sel.sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <FlatList
            data={options}
            keyExtractor={(item) => String(item.value)}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  sel.option,
                  item.value === value && sel.optionSelected,
                ]}
                onPress={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    sel.optionText,
                    item.value === value && sel.optionTextSelected,
                  ]}
                >
                  {item.label}
                </Text>
                {item.value === value && (
                  <Text style={sel.optionCheck}>✓</Text>
                )}
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={sel.separator} />}
          />
        </View>
      </Modal>
    </>
  );
}

const sel = StyleSheet.create({
  trigger: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   "#f9fafb",
    borderWidth:       1,
    borderColor:       "#e5e7eb",
    borderRadius:      12,
    paddingHorizontal: 14,
    paddingVertical:   13,
    minHeight:         48,
    marginBottom:      4,
  },
  triggerError: {
    borderColor:     "#f87171",
    backgroundColor: "#fef2f2",
  },
  triggerText: {
    flex:     1,
    fontSize: 14,
    color:    "#111827",
  },
  placeholder: {
    color: "#9ca3af",
  },
  arrow: {
    fontSize:   14,
    color:      "#6b7280",
    marginLeft: 8,
  },
  backdrop: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    backgroundColor:      "#ffffff",
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    maxHeight:            "60%",
    paddingBottom:        32,
  },
  sheetHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingVertical:   16,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  sheetTitle: {
    fontSize:   16,
    fontWeight: "700",
    color:      "#111827",
  },
  sheetClose: {
    fontSize: 18,
    color:    "#6b7280",
  },
  option: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingVertical:   14,
  },
  optionSelected: {
    backgroundColor: "#EEF2FF",
  },
  optionText: {
    fontSize: 15,
    color:    "#374151",
  },
  optionTextSelected: {
    color:      "#4F46E5",
    fontWeight: "600",
  },
  optionCheck: {
    fontSize: 16,
    color:    "#4F46E5",
  },
  separator: {
    height:           1,
    backgroundColor:  "#f9fafb",
    marginHorizontal: 20,
  },
});

// ─────────────────────────────────────────────────────────
// DATA LAYER
// ─────────────────────────────────────────────────────────
// This screen owns no persistence of its own. The student row, its queueing
// and its retry policy live in studentEnroll.service, which writes to the
// canonical `students` table and enqueues on the shared outbox.
//
// It previously carried a private `pending_students` table, a private sync
// loop, a private event bus and a hardcoded BASE_URL pointing at
// https://your-api.example.com — so nothing it saved could reach the server,
// and because the row never landed in `students`, the new student did not
// appear in any count either.

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────
export default function AddStudentScreen() {
  const router = useRouter();
  const { t }  = useTranslation();

  // Real auth. These were placeholder strings ("SCHOOL_ID_FROM_AUTH") with a
  // TODO, so every enrollment was stamped with a school that does not exist.
  const schoolId = useAuthStore(
    (s) => s.user?.schoolId || s.user?.school_id || null
  );

  const firstNameRef = useRef(null);

  const [form,           setForm]           = useState(EMPTY_FORM);
  const [errors,         setErrors]         = useState({});
  const [saving,         setSaving]         = useState(false);
  const [success,        setSuccess]        = useState(null);
  const [classes,        setClasses]        = useState([]);
  const [classesLoading, setClassesLoading] = useState(true);
  const [copied,         setCopied]         = useState(false);
  const [isOnline,       setIsOnline]       = useState(true);
  const [dbReady,        setDbReady]        = useState(false);

  // The shared database is already open by the time any screen mounts (the
  // root layout awaits it), so there is nothing to initialise here — the
  // enrollment service adds the columns it needs on first write.
  useEffect(() => { setDbReady(true); }, []);

  // ── Network listener ─────────────────────────────────────
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setIsOnline(!!state.isConnected);
      if (state.isConnected) {
        // Queued enrollments go out through the shared outbox.
        pushEnrollments().catch(console.warn);
      }
    });
    return unsub;
  }, []);

  // ── Load classes ─────────────────────────────────────────
  // ClassService.getAll is already local-first (it reads SQLite and refreshes
  // from the server when online), and it is the same call the classes screen
  // uses — so the dropdown can never disagree with that list. The private
  // `classes_cache` table this screen used to keep is gone.
  useEffect(() => {
    if (!dbReady || !schoolId) return;

    let cancelled = false;
    setClassesLoading(true);

    (async () => {
      try {
        const rows = await ClassService.getAll(true);
        if (cancelled) return;

        setClasses(
          (rows ?? [])
            .filter((c) => c.id && c.name)
            .map((c) => ({
              id:      c.id,
              schoolId,
              name:    c.name,
              section: c.section ?? undefined,
            }))
        );
      } catch (err) {
        console.warn("[AddStudent] load classes failed:", err.message);
      } finally {
        if (!cancelled) setClassesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [dbReady, schoolId]);

  // ── Reflect the queued enrollment's real state ───────────
  //
  // The private event bus this screen used to run is gone. The outbox is the
  // source of truth now, so we simply re-read the row — getEnrollmentStatus
  // follows the id map, so it still finds the student after the server
  // assigns it a different id.
  const refreshSyncState = useCallback(async (localId) => {
    if (!localId) return;
    try {
      const row = await getEnrollmentStatus(localId);
      if (!row) return;
      setSuccess((prev) => {
        if (!prev || prev.localId !== localId) return prev;
        return {
          ...prev,
          syncStatus:   row.synced ? "synced" : prev.syncStatus,
          enrollmentNo: row.enrollmentNo ?? prev.enrollmentNo,
          // Server-minted login credentials, captured by the outbox
          // reconciler. Shown once on the success card, like the web flow.
          tempPassword: row.tempPassword ?? prev.tempPassword,
          emailSent:    row.emailSent,
          message: row.synced
            ? t("studentAdd.msgEnrolled", { name: row.name })
            : prev.message,
        };
      });
    } catch (err) {
      console.warn("[AddStudent] status refresh failed:", err.message);
    }
  }, [t]);

  // Poll briefly while an enrollment is in flight, so the card settles on its
  // own once the outbox delivers. Stops as soon as it lands.
  useEffect(() => {
    if (!success?.localId) return;
    if (success.syncStatus === "synced") return;

    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled) return;
      refreshSyncState(success.localId);
    }, 3_000);

    return () => { cancelled = true; clearInterval(timer); };
  }, [success?.localId, success?.syncStatus, refreshSyncState]);

  // ── Field change ─────────────────────────────────────────
  const handleChange = useCallback(
    (field, value) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      if (errors[field]) {
        setErrors((prev) => ({ ...prev, [field]: undefined }));
      }
    },
    [errors]
  );

  // ── Validation ───────────────────────────────────────────
  const validate = useCallback(() => {
    const next = {};

    if (!form.firstName.trim())
      next.firstName = t("studentAdd.firstNameRequired");
    else if (form.firstName.trim().length < 2)
      next.firstName = t("studentAdd.minTwoChars");

    if (!form.lastName.trim())
      next.lastName = t("studentAdd.lastNameRequired");
    else if (form.lastName.trim().length < 2)
      next.lastName = t("studentAdd.minTwoChars");

    if (!form.classId)
      next.classId = t("studentAdd.classRequired");

    if (form.email.trim() && !EMAIL_RE.test(form.email.trim()))
      next.email = t("studentAdd.emailInvalid");

    if (form.phone.trim() && form.phone.trim().length < 7)
      next.phone = t("studentAdd.phoneTooShort");

    if (form.guardianPhone.trim() && form.guardianPhone.trim().length < 7)
      next.guardianPhone = t("studentAdd.guardianPhoneTooShort");

    setErrors(next);
    if (Object.keys(next).length > 0) {
      firstNameRef.current?.focus();
    }
    return Object.keys(next).length === 0;
  }, [form, t]);

  // ── Submit ───────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!validate()) return;
    if (!schoolId) {
      setErrors({ general: t("studentAdd.schoolIdMissing") });
      return;
    }
    if (!dbReady) {
      setErrors({ general: t("studentAdd.dbNotReady") });
      return;
    }

    setSaving(true);
    setErrors({});

    try {
      const selectedClass = classes.find((c) => c.id === form.classId);
      const className     = selectedClass
        ? [selectedClass.name, selectedClass.section].filter(Boolean).join(" ")
        : t("studentAdd.unknownClass");

      // Writes the student into the canonical `students` table and queues one
      // mutation on the shared outbox — the same path every other write takes.
      const { id, name: displayName } = await enrollStudentLocally({
        schoolId,
        classId:       form.classId,
        className,
        firstName:     form.firstName.trim(),
        lastName:      form.lastName.trim(),
        email:         form.email.trim()         || null,
        phone:         form.phone.trim()         || null,
        gender:        form.gender               || null,
        dateOfBirth:   form.dateOfBirth          || null,
        address:       form.address.trim()       || null,
        guardianName:  form.guardianName.trim()  || null,
        guardianPhone: form.guardianPhone.trim() || null,
      });

      setSuccess({
        localId:     id,
        studentName: displayName,
        className,
        syncStatus:  "pending",
        isOffline:   !isOnline,
        message:     isOnline
          ? t("studentAdd.msgSavedUploading", { name: displayName })
          : t("studentAdd.msgSavedOffline", { name: displayName }),
      });

      if (isOnline) {
        // Push now, then reflect whatever actually happened.
        pushEnrollments()
          .then(() => refreshSyncState(id))
          .catch(console.warn);
      }
    } catch (err) {
      setErrors({
        general: errorText(t, err, "studentAdd.saveFailed"),
      });
    } finally {
      setSaving(false);
    }
  }, [validate, form, schoolId, classes, isOnline, dbReady, refreshSyncState, t]);

  // ── Retry sync ───────────────────────────────────────────
  const handleRetrySync = useCallback(async () => {
    if (!success) return;
    setSuccess((prev) => prev ? { ...prev, syncStatus: "syncing" } : prev);
    try {
      await pushEnrollments();
      await refreshSyncState(success.localId);
    } catch (err) {
      console.warn("[AddStudent] retry failed:", err.message);
      setSuccess((prev) => prev ? { ...prev, syncStatus: "sync_failed" } : prev);
    }
  }, [success, refreshSyncState]);

  // ── Add another ──────────────────────────────────────────
  const handleAddAnother = useCallback(() => {
    setForm(EMPTY_FORM);
    setErrors({});
    setSuccess(null);
    setCopied(false);
    setTimeout(() => firstNameRef.current?.focus(), 150);
  }, []);

  // ── Copy ─────────────────────────────────────────────────
  const handleCopy = useCallback(async (text) => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);

  // ─────────────────────────────────────────────────────────
  // SUCCESS VIEW
  // ─────────────────────────────────────────────────────────
  if (success) {
    const cfg = SYNC_CONFIG[success.syncStatus] ?? SYNC_CONFIG.pending;
    const syncLabels = {
      syncPending: t("studentAdd.syncPending"),
      syncSyncing: t("studentAdd.syncSyncing"),
      syncSynced:  t("studentAdd.syncSynced"),
      syncFailed:  t("studentAdd.syncFailed"),
    };

    return (
      <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
        <ScrollView
          contentContainerStyle={s.successContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero */}
          <View style={s.hero}>
            <View
              style={[
                s.heroIcon,
                { backgroundColor: success.warning ? "#fffbeb" : "#ecfdf5" },
              ]}
            >
              <Text style={s.heroEmoji}>
                {success.syncStatus === "synced" ? "🎉" : "💾"}
              </Text>
            </View>
            <Text style={s.heroTitle}>{t("studentAdd.successTitle")}</Text>
            <Text style={s.heroSub}>{success.message}</Text>
          </View>

          {/* Sync badge */}
          <View
            style={[
              s.syncBadge,
              { backgroundColor: cfg.bg, borderColor: cfg.border },
            ]}
          >
            <Text style={s.syncIcon}>{cfg.icon}</Text>
            <Text style={[s.syncLabel, { color: cfg.color }]}>
              {syncLabels[cfg.labelKey]}
            </Text>
            {success.syncStatus === "sync_failed" && (
              <TouchableOpacity
                onPress={handleRetrySync}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[s.retryText, { color: cfg.color }]}>
                  ↺ {t("studentAdd.retry")}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Server warning */}
          {success.warning && (
            <View style={s.warningCard}>
              <Text style={s.warningIcon}>⚠️</Text>
              <Text style={s.warningText}>{success.warning}</Text>
            </View>
          )}

          {/* Summary */}
          <View style={s.summaryCard}>
            <SummaryRow label={t("studentAdd.summaryName")}  value={success.studentName} />
            <SummaryRow label={t("studentAdd.summaryClass")} value={success.className}   />
            <SummaryRow
              label={t("studentAdd.summaryEnrollmentNo")}
              value={
                success.enrollmentNo ??
                (success.syncStatus === "synced" ? "—" : t("studentAdd.pendingSync"))
              }
              highlight={!!success.enrollmentNo}
            />
            {success.emailSent !== undefined && (
              <SummaryRow
                label={t("studentAdd.summaryEmailSent")}
                value={
                  success.emailSent
                    ? t("studentAdd.emailSentYes")
                    : t("studentAdd.emailSentNo")
                }
              />
            )}
            {success.isOffline && (
              <SummaryRow
                label={t("studentAdd.summaryStatus")}
                value={t("studentAdd.statusSavedOffline")}
              />
            )}
          </View>

          {/* Manual credentials */}
          {success.syncStatus === "synced" &&
           !success.emailSent             &&
           success.tempPassword           && (
            <View style={s.credCard}>
              <Text style={s.credTitle}>{t("studentAdd.credTitle")}</Text>

              <View style={s.credBlock}>
                <Text style={s.credLabel}>{t("studentAdd.credEnrollmentLabel")}</Text>
                <Text style={s.credValue}>{success.enrollmentNo}</Text>
              </View>

              <View style={s.credBlock}>
                <Text style={s.credLabel}>{t("studentAdd.credPasswordLabel")}</Text>
                <View style={s.credRow}>
                  <Text style={[s.credValue, { flex: 1 }]}>
                    {success.tempPassword}
                  </Text>
                  <TouchableOpacity
                    onPress={() => handleCopy(success.tempPassword)}
                    style={s.copyBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={s.copyBtnText}>
                      {copied ? t("studentAdd.copied") : t("studentAdd.copy")}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              <Text style={s.credHint}>
                {t("studentAdd.credHint")}
              </Text>
            </View>
          )}

          {/* Actions */}
          <TouchableOpacity
            style={s.primaryBtn}
            onPress={handleAddAnother}
            activeOpacity={0.8}
          >
            <Text style={s.primaryBtnText}>{t("studentAdd.addAnother")}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.secondaryBtn}
            onPress={() => router.replace("/admin/students/approved")}
            activeOpacity={0.8}
          >
            <Text style={s.secondaryBtnText}>{t("studentAdd.backToStudents")}</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─────────────────────────────────────────────────────────
  // FORM VIEW
  // ─────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={s.backBtn}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={s.backArrow}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{t("studentAdd.title")}</Text>
          <Text style={s.headerSub}>
            {isOnline
              ? t("studentAdd.headerSubOnline")
              : t("studentAdd.headerSubOffline")}
          </Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={s.formContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── General error ── */}
          {errors.general && (
            <View style={s.errorBanner}>
              <Text style={s.errorBannerText}>⚠ {errors.general}</Text>
            </View>
          )}

          {/* ── Offline notice ── */}
          {!isOnline && (
            <View style={s.offlineBanner}>
              <Text style={s.offlineBannerText}>
                {t("studentAdd.offlineBanner")}
              </Text>
            </View>
          )}

          {/* ── Info banner ── */}
          <View style={s.infoBanner}>
            <Text style={s.infoBannerText}>
              ✅{" "}
              <Text style={{ fontWeight: "700" }}>
                {t("studentAdd.directEnrollment")}
              </Text>
              {" — "}{t("studentAdd.directEnrollmentNote")}
            </Text>
          </View>

          {/* ═══════════════════════════════════════════════
              CLASS ASSIGNMENT
          ═══════════════════════════════════════════════ */}
          <View style={s.card}>
            <SectionHeader emoji="🏫" title={t("studentAdd.sectionClass")} required />

            {classesLoading ? (
              <View style={s.loadingRow}>
                <ActivityIndicator size="small" color="#6b7280" />
                <Text style={s.loadingText}>{t("studentAdd.loadingClasses")}</Text>
              </View>
            ) : classes.length === 0 ? (
              <View style={s.emptyClassRow}>
                <Text style={s.emptyClassText}>{t("studentAdd.noClasses")}</Text>
                <TouchableOpacity
                  onPress={() => router.push("/admin/classes")}
                >
                  <Text style={s.emptyClassLink}>{t("studentAdd.addClassFirst")}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <SimpleSelect
                  label={t("studentAdd.selectClass")}
                  value={form.classId}
                  onChange={(v) => handleChange("classId", v)}
                  placeholder={t("studentAdd.selectClassPlaceholder")}
                  error={!!errors.classId}
                  options={classes.map((cls) => ({
                    label: [cls.name, cls.section].filter(Boolean).join(" — "),
                    value: cls.id,
                  }))}
                />
                {errors.classId && (
                  <Text style={s.fieldError}>⚠ {errors.classId}</Text>
                )}
              </>
            )}
          </View>

          {/* ═══════════════════════════════════════════════
              PERSONAL INFORMATION
          ═══════════════════════════════════════════════ */}
          <View style={s.card}>
            <SectionHeader emoji="👤" title={t("studentAdd.sectionPersonal")} />

            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <FormField
                  ref={firstNameRef}
                  label={t("studentAdd.firstName")}
                  required
                  value={form.firstName}
                  onChangeText={(v) => handleChange("firstName", v)}
                  placeholder={t("studentAdd.firstNamePlaceholder")}
                  error={errors.firstName}
                  autoCapitalize="words"
                  returnKeyType="next"
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <FormField
                  label={t("studentAdd.lastName")}
                  required
                  value={form.lastName}
                  onChangeText={(v) => handleChange("lastName", v)}
                  placeholder={t("studentAdd.lastNamePlaceholder")}
                  error={errors.lastName}
                  autoCapitalize="words"
                  returnKeyType="next"
                />
              </View>
            </View>

            <View style={s.fieldWrap}>
              <Text style={s.fieldLabel}>{t("studentAdd.gender")}</Text>
              <SimpleSelect
                label={t("studentAdd.selectGender")}
                value={form.gender}
                onChange={(v) => handleChange("gender", v)}
                placeholder={t("studentAdd.selectGenderPlaceholder")}
                options={[
                  { label: t("studentAdd.genderMale"),   value: "male"   },
                  { label: t("studentAdd.genderFemale"), value: "female" },
                  { label: t("studentAdd.genderOther"),  value: "other"  },
                ]}
              />
            </View>

            <DateField
              label={t("studentAdd.dateOfBirth")}
              value={form.dateOfBirth}
              onChange={(ymd) => handleChange("dateOfBirth", ymd)}
              maximumDate={new Date()}
              hint={t("studentAdd.dateOfBirthHint")}
            />
          </View>

          {/* ═══════════════════════════════════════════════
              CONTACT INFORMATION
          ═══════════════════════════════════════════════ */}
          <View style={s.card}>
            <SectionHeader emoji="📬" title={t("studentAdd.sectionContact")} />

            <FormField
              label={t("studentAdd.email")}
              value={form.email}
              onChangeText={(v) => handleChange("email", v)}
              placeholder="student@example.com"
              error={errors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              hint={t("studentAdd.emailHint")}
            />
            <FormField
              label={t("studentAdd.phone")}
              value={form.phone}
              onChangeText={(v) => handleChange("phone", v)}
              placeholder="+234 800 000 0000"
              error={errors.phone}
              keyboardType="phone-pad"
            />
            <FormField
              label={t("studentAdd.address")}
              value={form.address}
              onChangeText={(v) => handleChange("address", v)}
              placeholder={t("studentAdd.addressPlaceholder")}
              autoCapitalize="sentences"
            />
          </View>

          {/* ═══════════════════════════════════════════════
              GUARDIAN / PARENT
          ═══════════════════════════════════════════════ */}
          <View style={s.card}>
            <SectionHeader emoji="👨‍👧" title={t("studentAdd.sectionGuardian")} />

            <FormField
              label={t("studentAdd.guardianName")}
              value={form.guardianName}
              onChangeText={(v) => handleChange("guardianName", v)}
              placeholder={t("studentAdd.guardianNamePlaceholder")}
              autoCapitalize="words"
            />
            <FormField
              label={t("studentAdd.guardianPhone")}
              value={form.guardianPhone}
              onChangeText={(v) => handleChange("guardianPhone", v)}
              placeholder="+234 800 000 0000"
              error={errors.guardianPhone}
              keyboardType="phone-pad"
            />
          </View>

          {/* ── What happens info box ── */}
          <View style={s.infoBox}>
            <Text style={s.infoBoxTitle}>{t("studentAdd.infoTitle")}</Text>
            {[
              { e: "💾", text: t("studentAdd.infoSaved")        },
              { e: "🔄", text: t("studentAdd.infoAutoSync")     },
              { e: "🔢", text: t("studentAdd.infoEnrollmentNo") },
              { e: "📧", text: t("studentAdd.infoCredentials")  },
              { e: "📴", text: t("studentAdd.infoOffline")      },
            ].map(({ e, text }) => (
              <View key={text} style={s.infoRow}>
                <Text style={s.infoEmoji}>{e}</Text>
                <Text style={s.infoText}>{text}</Text>
              </View>
            ))}
          </View>

          {/* ── Submit ── */}
          <TouchableOpacity
            style={[
              s.submitBtn,
              (saving || classesLoading || classes.length === 0) &&
                s.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={saving || classesLoading || classes.length === 0}
            activeOpacity={0.8}
          >
            {saving ? (
              <View style={s.submitInner}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={s.submitBtnText}>{t("studentAdd.savingToDevice")}</Text>
              </View>
            ) : (
              <Text style={s.submitBtnText}>
                {isOnline ? t("studentAdd.enroll") : t("studentAdd.saveOffline")}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={s.discardBtn}
            onPress={() => router.back()}
            disabled={saving}
          >
            <Text style={s.discardBtnText}>{t("studentAdd.discard")}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

function SectionHeader({ emoji, title, required = false }) {
  return (
    <View style={sh.row}>
      <Text style={sh.emoji}>{emoji}</Text>
      <Text style={sh.title}>{title}</Text>
      {required && <Text style={sh.required}>*</Text>}
    </View>
  );
}

const sh = StyleSheet.create({
  row: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingBottom:     12,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    marginBottom:      14,
  },
  emoji:    { fontSize: 16 },
  title:    { flex: 1, fontSize: 13, fontWeight: "700", color: "#374151" },
  required: { fontSize: 14, color: "#ef4444", fontWeight: "700" },
});

// ── FormField ─────────────────────────────────────────────
const FormField = React.forwardRef(function FormField(
  { label, required, error, hint, ...inputProps },
  ref
) {
  return (
    <View style={ff.wrapper}>
      <Text style={ff.label}>
        {label}
        {required && <Text style={ff.required}> *</Text>}
      </Text>
      <View style={[ff.inputBox, error && ff.inputBoxError]}>
        <TextInput
          ref={ref}
          style={ff.input}
          placeholderTextColor="#9ca3af"
          {...inputProps}
        />
      </View>
      {error ? (
        <Text style={ff.errorText}>⚠ {error}</Text>
      ) : hint ? (
        <Text style={ff.hint}>{hint}</Text>
      ) : null}
    </View>
  );
});

const ff = StyleSheet.create({
  wrapper:  { marginBottom: 4 },
  label:    { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 6 },
  required: { color: "#ef4444" },
  inputBox: {
    backgroundColor:   "#f9fafb",
    borderWidth:       1,
    borderColor:       "#e5e7eb",
    borderRadius:      12,
    paddingHorizontal: 14,
    paddingVertical:   Platform.OS === "ios" ? 13 : 10,
  },
  inputBoxError: { borderColor: "#f87171", backgroundColor: "#fef2f2" },
  input:         { fontSize: 14, color: "#111827", padding: 0 },
  errorText:     { fontSize: 11, color: "#dc2626", fontWeight: "600", marginTop: 4 },
  hint:          { fontSize: 11, color: "#9ca3af", marginTop: 4 },
});

// ── SummaryRow ────────────────────────────────────────────
function SummaryRow({ label, value, highlight = false }) {
  return (
    <View style={sr.row}>
      <Text style={sr.label}>{label}</Text>
      <Text style={[sr.value, highlight && sr.valueHighlight]}>{value}</Text>
    </View>
  );
}

const sr = StyleSheet.create({
  row: {
    flexDirection:   "row",
    justifyContent:  "space-between",
    alignItems:      "center",
    paddingVertical: 4,
  },
  label: { fontSize: 13, color: "#6b7280" },
  value: {
    fontSize:   13,
    fontWeight: "700",
    color:      "#111827",
    flexShrink: 1,
    textAlign:  "right",
    marginLeft: 8,
  },
  valueHighlight: { color: "#4f46e5" },
});

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f9fafb" },

  // ── header ──────────────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               12,
    backgroundColor:   "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    paddingHorizontal: 16,
    paddingTop:        16,
    paddingBottom:     14,
  },
  backBtn: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: "#f3f4f6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  backArrow:   { fontSize: 20, color: "#374151" },
  headerTitle: { fontSize: 17, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#6b7280", marginTop: 1 },

  // ── form scroll ──────────────────────────────────────────
  formContent: { padding: 16, paddingBottom: 48, gap: 16 },

  // ── banners ──────────────────────────────────────────────
  errorBanner: {
    backgroundColor: "#fef2f2",
    borderWidth:     1,
    borderColor:     "#fecaca",
    borderRadius:    12,
    padding:         14,
  },
  errorBannerText: { fontSize: 13, color: "#dc2626" },
  offlineBanner: {
    backgroundColor: "#fffbeb",
    borderWidth:     1,
    borderColor:     "#fde68a",
    borderRadius:    12,
    padding:         14,
  },
  offlineBannerText: { fontSize: 13, color: "#92400e" },
  infoBanner: {
    backgroundColor: "#ecfdf5",
    borderWidth:     1,
    borderColor:     "#a7f3d0",
    borderRadius:    12,
    padding:         14,
  },
  infoBannerText: { fontSize: 13, color: "#065f46" },

  // ── card ─────────────────────────────────────────────────
  card: {
    backgroundColor: "#fff",
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     "#e5e7eb",
    padding:         16,
  },

  // ── class picker ─────────────────────────────────────────
  loadingRow:  { flexDirection: "row", alignItems: "center", gap: 8, padding: 8 },
  loadingText: { fontSize: 13, color: "#6b7280" },
  emptyClassRow: {
    flexDirection:   "row",
    alignItems:      "center",
    flexWrap:        "wrap",
    backgroundColor: "#fffbeb",
    borderWidth:     1,
    borderColor:     "#fde68a",
    borderRadius:    10,
    padding:         12,
  },
  emptyClassText: { fontSize: 13, color: "#92400e" },
  emptyClassLink: {
    fontSize:           13,
    color:              "#d97706",
    fontWeight:         "700",
    textDecorationLine: "underline",
  },
  fieldError: { fontSize: 11, color: "#dc2626", fontWeight: "600", marginTop: 4 },

  // ── field helpers ────────────────────────────────────────
  row:        { flexDirection: "row" },
  fieldWrap:  { marginBottom: 4 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginBottom: 6 },

  // ── info box ─────────────────────────────────────────────
  infoBox: {
    backgroundColor: "#fff",
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     "#e5e7eb",
    padding:         16,
    gap:             10,
  },
  infoBoxTitle: { fontSize: 13, fontWeight: "700", color: "#374151", marginBottom: 4 },
  infoRow:      { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  infoEmoji:    { fontSize: 14 },
  infoText:     { flex: 1, fontSize: 13, color: "#4b5563" },

  // ── submit / discard ─────────────────────────────────────
  submitBtn: {
    backgroundColor: "#059669",
    borderRadius:    14,
    paddingVertical: 16,
    alignItems:      "center",
    justifyContent:  "center",
  },
  submitBtnDisabled: { backgroundColor: "#d1d5db" },
  submitInner:       { flexDirection: "row", alignItems: "center", gap: 8 },
  submitBtnText:     { fontSize: 15, fontWeight: "700", color: "#fff" },
  discardBtn:        { alignItems: "center", paddingVertical: 12 },
  discardBtnText:    { fontSize: 14, color: "#9ca3af", fontWeight: "500" },

  // ── success view ─────────────────────────────────────────
  successContent: { padding: 20, gap: 16, paddingBottom: 48 },
  hero:           { alignItems: "center", paddingVertical: 8 },
  heroIcon: {
    width:          80,
    height:         80,
    borderRadius:   24,
    alignItems:     "center",
    justifyContent: "center",
    marginBottom:   14,
  },
  heroEmoji: { fontSize: 38 },
  heroTitle: { fontSize: 22, fontWeight: "800", color: "#111827" },
  heroSub: {
    fontSize:   14,
    color:      "#6b7280",
    textAlign:  "center",
    marginTop:  6,
    lineHeight: 20,
  },
  syncBadge: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    borderWidth:   1,
    borderRadius:  12,
    padding:       12,
  },
  syncIcon:  { fontSize: 18 },
  syncLabel: { flex: 1, fontSize: 13, fontWeight: "600" },
  retryText: { fontSize: 13, fontWeight: "700" },
  warningCard: {
    flexDirection:   "row",
    gap:             8,
    alignItems:      "flex-start",
    backgroundColor: "#fffbeb",
    borderWidth:     1,
    borderColor:     "#fde68a",
    borderRadius:    12,
    padding:         12,
  },
  warningIcon: { fontSize: 14 },
  warningText: { flex: 1, fontSize: 13, color: "#92400e" },
  summaryCard: {
    backgroundColor: "#fff",
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     "#e5e7eb",
    padding:         16,
    gap:             8,
  },
  credCard: {
    backgroundColor: "#fffbeb",
    borderWidth:     1,
    borderColor:     "#fde68a",
    borderRadius:    16,
    padding:         16,
    gap:             12,
  },
  credTitle: {
    fontSize:      11,
    fontWeight:    "800",
    color:         "#92400e",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  credBlock: { gap: 4 },
  credLabel: { fontSize: 11, color: "#b45309", fontWeight: "600" },
  credValue: {
    fontSize:   14,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
    color:      "#111827",
  },
  credRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  copyBtn: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    backgroundColor:   "#fff",
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       "#d97706",
  },
  copyBtnText:      { fontSize: 12, fontWeight: "700", color: "#d97706" },
  credHint:         { fontSize: 11, color: "#b45309" },
  primaryBtn: {
    backgroundColor: "#4f46e5",
    borderRadius:    14,
    paddingVertical: 16,
    alignItems:      "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  secondaryBtn: {
    backgroundColor: "#f3f4f6",
    borderRadius:    14,
    paddingVertical: 16,
    alignItems:      "center",
  },
  secondaryBtnText: { color: "#374151", fontSize: 15, fontWeight: "600" },
});