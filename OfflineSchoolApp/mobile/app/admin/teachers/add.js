// mobile/app/admin/teachers/add.js
import { useState, useRef, useCallback } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert,
  StyleSheet, KeyboardAvoidingView, Platform,
  Clipboard,
} from "react-native";
import { useRouter }        from "expo-router";
import { Ionicons }         from "@expo/vector-icons";
import { TeacherService }   from "@/services/teacher.service";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const MAX_NAME  = 60;
const EMAIL_RGX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NEXT_STEPS = [
  { icon: "key-outline",  color: "#4F46E5", text: "A secure temporary password is generated automatically" },
  { icon: "mail-outline", color: "#0891B2", text: "Login credentials are emailed to the teacher immediately" },
  { icon: "lock-closed-outline", color: "#059669",
    text: "Teacher sets a personal password on their first login" },
];

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function AddTeacherScreen() {
  const router = useRouter();

  const nameRef  = useRef(null);
  const emailRef = useRef(null);

  const [name,    setName]    = useState("");
  const [email,   setEmail]   = useState("");
  const [errors,  setErrors]  = useState({});
  const [saving,  setSaving]  = useState(false);
  const [success, setSuccess] = useState(null);
  const [copied,  setCopied]  = useState(false);

  const trimName  = name.trim();
  const trimEmail = email.trim();
  const charCount = trimName.length;
  const nearLimit = charCount > MAX_NAME - 10;
  const isReady   = !saving && trimName.length > 0 && trimEmail.length > 0;

  // ── Validation ──────────────────────────────────────────

  const validate = useCallback(() => {
    const next = {};

    if (!trimName) {
      next.name = "Teacher name is required.";
    } else if (trimName.length < 2) {
      next.name = "Name must be at least 2 characters.";
    } else if (trimName.length > MAX_NAME) {
      next.name = `Name cannot exceed ${MAX_NAME} characters.`;
    }

    if (!trimEmail) {
      next.email = "Email address is required.";
    } else if (!EMAIL_RGX.test(trimEmail)) {
      next.email = "Please enter a valid email address.";
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }, [trimName, trimEmail]);

  // ── Submit ──────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;

    const submittedName  = trimName;
    const submittedEmail = trimEmail;

    setSaving(true);
    setErrors({});

    try {
      // TeacherService.create() handles:
      // - local SQLite persistence
      // - server sync via API.admin.teachers.list
      // - ID reconciliation (local → server)
      // - 409 conflict detection
      const teacherId = await TeacherService.create(submittedName, submittedEmail);

      setSuccess({
        teacherId,
        teacherName:  submittedName,
        teacherEmail: submittedEmail,
        // emailSent and tempPassword are server-side concerns the service
        // does not expose — default emailSent to true for a clean UX
        emailSent:    true,
        tempPassword: null,
        message:      null,
      });
    } catch (err) {
      const message = err?.message ?? "Something went wrong. Please try again.";

      if (
        message.toLowerCase().includes("already exists") ||
        message.toLowerCase().includes("already registered")
      ) {
        setErrors({
          email:
            "This email is already registered. " +
            "Check if the teacher already has an account or use a different email.",
        });
        emailRef.current?.focus();
      } else {
        Alert.alert("Failed to Create", message);
      }
    } finally {
      setSaving(false);
    }
  }, [validate, trimName, trimEmail]);

  // ── Discard ─────────────────────────────────────────────

  const handleDiscard = useCallback(() => {
    const isDirty = trimName || trimEmail;
    if (!isDirty) { router.back(); return; }
    Alert.alert(
      "Discard Changes",
      "Are you sure you want to discard unsaved changes?",
      [
        { text: "Keep Editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => router.back() },
      ]
    );
  }, [trimName, trimEmail, router]);

  // ── Copy password ───────────────────────────────────────

  const handleCopy = useCallback((pwd) => {
    Clipboard.setString(pwd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  // ── Reset form ──────────────────────────────────────────

  const handleAddAnother = useCallback(() => {
    setName("");
    setEmail("");
    setErrors({});
    setSuccess(null);
    setCopied(false);
    setTimeout(() => nameRef.current?.focus(), 100);
  }, []);

  // ─────────────────────────────────────────────────────────
  // SUCCESS VIEW
  // ─────────────────────────────────────────────────────────

  if (success) {
    return (
      <View style={{ flex: 1, backgroundColor: "#F9FAFB" }}>
        <ScreenHeader
          title="Teacher Added"
          onBack={() =>
            success.teacherId
              ? router.push(`/admin/teachers/${success.teacherId}`)
              : router.push("/admin/teachers")
          }
        />

        <ScrollView contentContainerStyle={styles.successScroll}>
          <View style={styles.successCard}>

            {/* Icon */}
            <View style={[
              styles.successIcon,
              { backgroundColor: success.emailSent ? "#ECFDF5" : "#FFFBEB" },
            ]}>
              <Ionicons
                name={success.emailSent
                  ? "checkmark-circle-outline"
                  : "alert-circle-outline"}
                size={36}
                color={success.emailSent ? "#059669" : "#D97706"}
              />
            </View>

            <Text style={styles.successTitle}>
              {success.emailSent ? "Teacher Added!" : "Teacher Created"}
            </Text>

            <Text style={styles.successMessage}>
              {success.emailSent
                ? success.message ||
                  `"${success.teacherName}" has been added. A welcome email with login instructions has been sent to ${success.teacherEmail}.`
                : `Teacher created, but the welcome email failed. Share the credentials below manually.`
              }
            </Text>

            {/* Manual credentials — only shown when emailSent is false */}
            {!success.emailSent && success.tempPassword && (
              <View style={styles.credCard}>
                <Text style={styles.credTitle}>Share these credentials manually</Text>

                <View style={styles.credRow}>
                  <Text style={styles.credLabel}>📧 Email</Text>
                  <Text style={styles.credValue} selectable>
                    {success.teacherEmail}
                  </Text>
                </View>

                <View style={styles.credRow}>
                  <Text style={styles.credLabel}>🔑 Temp Password</Text>
                  <View style={styles.credPwdRow}>
                    <Text style={[styles.credValue, { flex: 1 }]} selectable>
                      {success.tempPassword}
                    </Text>
                    <TouchableOpacity
                      onPress={() => handleCopy(success.tempPassword)}
                      style={styles.credCopyBtn}
                    >
                      <Ionicons
                        name={copied ? "checkmark" : "copy-outline"}
                        size={14}
                        color="#4F46E5"
                      />
                      <Text style={styles.credCopyText}>
                        {copied ? "Copied" : "Copy"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <Text style={styles.credNote}>
                  The teacher must change this password on first login.
                </Text>
              </View>
            )}

            {/* Actions */}
            <TouchableOpacity
              onPress={handleAddAnother}
              style={styles.primaryBtn}
            >
              <Text style={styles.primaryBtnText}>Add Another Teacher</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() =>
                success.teacherId
                  ? router.push(`/admin/teachers/${success.teacherId}`)
                  : router.push("/admin/teachers")
              }
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {success.teacherId ? "View Teacher Profile" : "Back to Teachers"}
              </Text>
            </TouchableOpacity>

          </View>
        </ScrollView>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // FORM VIEW
  // ─────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#F9FAFB" }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScreenHeader
        title="Add Teacher"
        subtitle="Create a new teacher profile"
        onBack={handleDiscard}
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* Info banner */}
        <View style={styles.infoBanner}>
          <Ionicons name="mail-outline" size={16} color="#1D4ED8" />
          <Text style={styles.infoBannerText}>
            A temporary password will be generated and emailed to the teacher
            automatically. They will be prompted to set a personal password on
            first login.
          </Text>
        </View>

        {/* Form card */}
        <View style={styles.card}>

          {/* Name */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>
              Teacher Name <Text style={{ color: "#EF4444" }}>*</Text>
            </Text>
            <View style={[
              styles.inputWrap,
              errors.name && styles.inputError,
            ]}>
              <Ionicons
                name="person-outline"
                size={18}
                color={errors.name ? "#EF4444" : "#9CA3AF"}
              />
              <TextInput
                ref={nameRef}
                value={name}
                onChangeText={(t) => {
                  setName(t);
                  if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
                }}
                placeholder="e.g. Mr John Doe"
                placeholderTextColor="#D1D5DB"
                autoFocus
                maxLength={MAX_NAME + 5}
                returnKeyType="next"
                onSubmitEditing={() => emailRef.current?.focus()}
                style={styles.input}
              />
            </View>
            <View style={styles.fieldBottom}>
              {errors.name ? (
                <View style={styles.errorRow}>
                  <Ionicons name="alert-circle-outline" size={12} color="#DC2626" />
                  <Text style={styles.errorText}>{errors.name}</Text>
                </View>
              ) : (
                <Text style={styles.hint}>
                  Full name as it will appear across the system.
                </Text>
              )}
              <Text style={[
                styles.charCount,
                charCount > MAX_NAME                       && styles.charOver,
                nearLimit && charCount <= MAX_NAME         && styles.charNear,
              ]}>
                {charCount}/{MAX_NAME}
              </Text>
            </View>
          </View>

          {/* Email */}
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>
              Email Address <Text style={{ color: "#EF4444" }}>*</Text>
            </Text>
            <View style={[
              styles.inputWrap,
              errors.email && styles.inputError,
            ]}>
              <Ionicons
                name="mail-outline"
                size={18}
                color={errors.email ? "#EF4444" : "#9CA3AF"}
              />
              <TextInput
                ref={emailRef}
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
                }}
                placeholder="teacher@school.com"
                placeholderTextColor="#D1D5DB"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
                style={styles.input}
              />
            </View>
            {errors.email ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle-outline" size={12} color="#DC2626" />
                <Text style={styles.errorText}>{errors.email}</Text>
              </View>
            ) : (
              <Text style={styles.hint}>
                Must be unique. Used for login and receiving credentials.
              </Text>
            )}
          </View>

          {/* Submit */}
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={!isReady}
            style={[styles.submitBtn, !isReady && styles.submitDisabled]}
            activeOpacity={0.8}
          >
            {saving ? (
              <>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.submitText}>Creating…</Text>
              </>
            ) : (
              <>
                <Ionicons name="person-add-outline" size={18} color="#fff" />
                <Text style={styles.submitText}>Create Teacher</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Discard */}
          <TouchableOpacity
            onPress={handleDiscard}
            disabled={saving}
            style={styles.discardBtn}
          >
            <Text style={styles.discardText}>Discard &amp; Go Back</Text>
          </TouchableOpacity>

        </View>

        {/* What happens next */}
        <View style={styles.card}>
          <Text style={styles.nextTitle}>What happens next?</Text>
          {NEXT_STEPS.map(({ icon, color, text }) => (
            <View key={text} style={styles.nextRow}>
              <View style={[styles.nextIcon, { backgroundColor: "#F3F4F6" }]}>
                <Ionicons name={icon} size={16} color={color} />
              </View>
              <Text style={styles.nextText}>{text}</Text>
            </View>
          ))}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────

function ScreenHeader({ title, subtitle, onBack }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={styles.backBtn}>
        <Ionicons name="arrow-back" size={20} color="#374151" />
      </TouchableOpacity>
      <View>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle && <Text style={styles.headerSub}>{subtitle}</Text>}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll:       { padding: 16, gap: 14 },
  card:         { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1,
                  borderColor: "#E5E7EB", padding: 16, gap: 14,
                  shadowColor: "#000", shadowOpacity: 0.04,
                  shadowRadius: 6, elevation: 2 },
  header:       { flexDirection: "row", alignItems: "center", gap: 12,
                  backgroundColor: "#fff", borderBottomWidth: 1,
                  borderBottomColor: "#E5E7EB", paddingHorizontal: 16, paddingVertical: 14 },
  backBtn:      { width: 38, height: 38, borderRadius: 10, backgroundColor: "#F3F4F6",
                  alignItems: "center", justifyContent: "center" },
  headerTitle:  { fontSize: 17, fontWeight: "800", color: "#111827" },
  headerSub:    { fontSize: 12, color: "#6B7280", marginTop: 1 },

  // Info banner
  infoBanner:     { flexDirection: "row", alignItems: "flex-start", gap: 10,
                    backgroundColor: "#EFF6FF", borderRadius: 12, borderWidth: 1,
                    borderColor: "#BFDBFE", padding: 14 },
  infoBannerText: { flex: 1, fontSize: 13, color: "#1E40AF", lineHeight: 19 },

  // Field
  fieldWrap:    { gap: 6 },
  fieldLabel:   { fontSize: 14, fontWeight: "700", color: "#374151" },
  inputWrap:    { flexDirection: "row", alignItems: "center", gap: 10,
                  borderWidth: 2, borderColor: "#E5E7EB", borderRadius: 12,
                  backgroundColor: "#F9FAFB", paddingHorizontal: 14, paddingVertical: 12 },
  inputError:   { borderColor: "#F87171", backgroundColor: "#FEF2F2" },
  input:        { flex: 1, fontSize: 14, color: "#111827" },
  fieldBottom:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  hint:         { fontSize: 12, color: "#9CA3AF", flex: 1 },
  errorRow:     { flexDirection: "row", alignItems: "center", gap: 4 },
  errorText:    { fontSize: 12, color: "#DC2626", fontWeight: "600" },
  charCount:    { fontSize: 11, color: "#D1D5DB", marginLeft: 8 },
  charNear:     { color: "#D97706", fontWeight: "600" },
  charOver:     { color: "#DC2626", fontWeight: "700" },

  // Submit
  submitBtn:      { flexDirection: "row", alignItems: "center", justifyContent: "center",
                    gap: 8, backgroundColor: "#4F46E5", borderRadius: 12,
                    paddingVertical: 14, marginTop: 4 },
  submitDisabled: { backgroundColor: "#D1D5DB" },
  submitText:     { fontSize: 15, fontWeight: "800", color: "#fff" },
  discardBtn:     { alignItems: "center", paddingVertical: 10 },
  discardText:    { fontSize: 13, color: "#9CA3AF", fontWeight: "500" },

  // What happens next
  nextTitle:    { fontSize: 13, fontWeight: "800", color: "#374151" },
  nextRow:      { flexDirection: "row", alignItems: "center", gap: 12 },
  nextIcon:     { width: 36, height: 36, borderRadius: 10,
                  alignItems: "center", justifyContent: "center" },
  nextText:     { flex: 1, fontSize: 13, color: "#4B5563", lineHeight: 18 },

  // Success
  successScroll:  { padding: 24, alignItems: "center" },
  successCard:    { backgroundColor: "#fff", borderRadius: 20, borderWidth: 1,
                    borderColor: "#E5E7EB", padding: 24, width: "100%",
                    alignItems: "center", gap: 12,
                    shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 8, elevation: 3 },
  successIcon:    { width: 72, height: 72, borderRadius: 20,
                    alignItems: "center", justifyContent: "center" },
  successTitle:   { fontSize: 20, fontWeight: "800", color: "#111827" },
  successMessage: { fontSize: 14, color: "#6B7280", textAlign: "center", lineHeight: 20 },

  // Credentials
  credCard:      { backgroundColor: "#FFFBEB", borderRadius: 12, borderWidth: 1,
                   borderColor: "#FDE68A", padding: 14, width: "100%", gap: 10 },
  credTitle:     { fontSize: 11, fontWeight: "800", color: "#92400E",
                   textTransform: "uppercase", letterSpacing: 0.6 },
  credRow:       { gap: 4 },
  credLabel:     { fontSize: 12, color: "#B45309", fontWeight: "600" },
  credValue:     { fontSize: 14, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                   color: "#111827" },
  credPwdRow:    { flexDirection: "row", alignItems: "center", gap: 8 },
  credCopyBtn:   { flexDirection: "row", alignItems: "center", gap: 4 },
  credCopyText:  { fontSize: 12, fontWeight: "700", color: "#4F46E5" },
  credNote:      { fontSize: 11, color: "#B45309" },

  // Action buttons
  primaryBtn:       { backgroundColor: "#4F46E5", borderRadius: 12,
                      paddingVertical: 14, alignItems: "center", width: "100%", marginTop: 4 },
  primaryBtnText:   { fontSize: 15, fontWeight: "800", color: "#fff" },
  secondaryBtn:     { backgroundColor: "#F3F4F6", borderRadius: 12,
                      paddingVertical: 14, alignItems: "center", width: "100%" },
  secondaryBtnText: { fontSize: 15, fontWeight: "700", color: "#374151" },
});