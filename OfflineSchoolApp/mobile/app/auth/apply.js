// app/auth/apply.js

import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker    from "expo-image-picker";
import { File }            from "expo-file-system";     // ✅ SDK 56 new File API
import { Ionicons }        from "@expo/vector-icons";
import { API_URL }         from "../../src/services/api";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DOCUMENTS  = 5;
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per file

const DOCUMENT_TYPES = [
  { label: "Birth Certificate",      value: "birth_certificate"    },
  { label: "Previous School Report", value: "school_report"        },
  { label: "Medical Certificate",    value: "medical_certificate"  },
  { label: "Passport Photo",         value: "passport_photo"       },
  { label: "Other",                  value: "other"                },
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const formatBytes = (bytes) => {
  if (!bytes) return "";
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Derive a proper MIME type from a file name
const getMimeTypeFromName = (name = "") => {
  const ext = name.split(".").pop()?.toLowerCase();
  const map = {
    pdf:  "application/pdf",
    jpg:  "image/jpeg",
    jpeg: "image/jpeg",
    png:  "image/png",
    gif:  "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
  };
  return map[ext] || "application/octet-stream";
};

// Derive a file extension from a MIME type
const getExtensionFromMime = (mime = "") => {
  const map = {
    "application/pdf": "pdf",
    "image/jpeg":      "jpg",
    "image/png":       "png",
    "image/gif":       "gif",
    "image/webp":      "webp",
    "image/heic":      "heic",
  };
  return map[mime] || "bin";
};

// Ensure a URI has the file:// prefix (Android sometimes returns bare paths)
const normalizeFileUri = (uri) => {
  if (!uri) return uri;
  if (
    Platform.OS === "android" &&
    !uri.startsWith("file://") &&
    !uri.startsWith("content://")
  ) {
    return `file://${uri}`;
  }
  return uri;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENT — single document row
// ─────────────────────────────────────────────────────────────────────────────

const DocumentRow = ({ doc, index, onRemove, onChangeType }) => (
  <View style={docStyles.row}>
    {/* Icon */}
    <View style={docStyles.iconBox}>
      <Ionicons
        name={
          doc.mimeType?.startsWith("image/")
            ? "image-outline"
            : "document-outline"
        }
        size={22}
        color="#4F46E5"
      />
    </View>

    {/* Info */}
    <View style={docStyles.info}>
      <Text style={docStyles.fileName} numberOfLines={1}>
        {doc.name}
      </Text>
      <Text style={docStyles.fileSize}>{formatBytes(doc.size)}</Text>

      {/* Document type picker — simple tap-cycle */}
      <TouchableOpacity
        onPress={() => {
          const currentIndex = DOCUMENT_TYPES.findIndex(
            (t) => t.value === doc.docType
          );
          const next =
            DOCUMENT_TYPES[(currentIndex + 1) % DOCUMENT_TYPES.length];
          onChangeType(index, next.value);
        }}
        style={docStyles.typeChip}
        activeOpacity={0.7}
      >
        <Text style={docStyles.typeChipText}>
          {DOCUMENT_TYPES.find((t) => t.value === doc.docType)?.label ??
            "Other"}{" "}
          ↺
        </Text>
      </TouchableOpacity>
    </View>

    {/* Remove */}
    <TouchableOpacity
      onPress={() => onRemove(index)}
      style={docStyles.removeBtn}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons name="close-circle" size={22} color="#DC2626" />
    </TouchableOpacity>
  </View>
);

const docStyles = StyleSheet.create({
  row: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#F9FAFB",
    borderRadius:    12,
    padding:         12,
    marginBottom:    8,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    gap:             10,
  },
  iconBox: {
    width:           40,
    height:          40,
    borderRadius:    10,
    backgroundColor: "#EEF2FF",
    alignItems:      "center",
    justifyContent:  "center",
  },
  info:      { flex: 1 },
  fileName:  { fontSize: 13, fontWeight: "600", color: "#111827" },
  fileSize:  { fontSize: 11, color: "#9CA3AF", marginTop: 1 },
  typeChip: {
    marginTop:         4,
    alignSelf:         "flex-start",
    backgroundColor:   "#EEF2FF",
    borderRadius:      20,
    paddingVertical:   3,
    paddingHorizontal: 10,
  },
  typeChipText: { fontSize: 11, color: "#4F46E5", fontWeight: "600" },
  removeBtn:    { padding: 4 },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function ApplyScreen() {
  const router = useRouter();

  const {
    schoolId,
    schoolName,
    classes: classesParam,
  } = useLocalSearchParams();

  // ── Parse classes ──────────────────────────────────────────────────────────
  const availableClasses = (() => {
    try {
      const parsed = classesParam ? JSON.parse(classesParam) : [];
      return parsed.map((c) => ({
        ...c,
        id: String(c.id || c._id || ""),
      }));
    } catch {
      return [];
    }
  })();

  // ── State ──────────────────────────────────────────────────────────────────
  const [step,          setStep]          = useState(1);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const [selectedClass, setSelectedClass] = useState(null);
  const [documents,     setDocuments]     = useState([]);

  const [form, setForm] = useState({
    studentName:  "",
    guardianName: "",
    email:        "",
    phone:        "",
    notes:        "",
  });

  const updateField = (key, value) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // ── Document helpers ───────────────────────────────────────────────────────

  const addDocument = (file) => {
    if (documents.length >= MAX_DOCUMENTS) {
      Alert.alert(
        "Limit Reached",
        `You can attach up to ${MAX_DOCUMENTS} documents.`
      );
      return;
    }

    if (file.size && file.size > MAX_SIZE_BYTES) {
      Alert.alert(
        "File Too Large",
        `"${file.name}" is ${formatBytes(file.size)}. Maximum allowed size is ${formatBytes(MAX_SIZE_BYTES)}.`
      );
      return;
    }

    // Prevent duplicates
    const alreadyAdded = documents.some(
      (d) => d.uri === file.uri || d.name === file.name
    );
    if (alreadyAdded) {
      Alert.alert("Already Added", `"${file.name}" is already in the list.`);
      return;
    }

    setDocuments((prev) => [
      ...prev,
      { ...file, docType: "other" },
    ]);
  };

  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type:                 ["application/pdf", "image/*"],
        copyToCacheDirectory: true,
        multiple:             false,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset) return;

      const mimeType =
        asset.mimeType && asset.mimeType !== "application/octet-stream"
          ? asset.mimeType
          : getMimeTypeFromName(asset.name);

      addDocument({
        name:     asset.name || `document_${Date.now()}.${getExtensionFromMime(mimeType)}`,
        uri:      asset.uri,
        size:     asset.size || 0,
        mimeType,
      });
    } catch (err) {
      Alert.alert("Error", "Could not pick document. Please try again.");
      console.warn("DocumentPicker error:", err.message);
    }
  };

  const handlePickImage = async () => {
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert(
          "Permission Required",
          "Please allow access to your photo library to attach images."
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes:              ImagePicker.MediaTypeOptions.Images,
        allowsEditing:           false,
        quality:                 0.8,
        allowsMultipleSelection: false,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset) return;

      // Derive a proper file name with extension
      const uriParts = asset.uri.split("/");
      let   fileName = uriParts[uriParts.length - 1] || `photo_${Date.now()}.jpg`;

      if (!fileName.includes(".")) {
        const ext = asset.mimeType?.split("/")[1] || "jpg";
        fileName = `${fileName}.${ext}`;
      }

      const mimeType = asset.mimeType || getMimeTypeFromName(fileName);

      addDocument({
        name:     fileName,
        uri:      asset.uri,
        size:     asset.fileSize || 0,
        mimeType,
      });
    } catch (err) {
      Alert.alert("Error", "Could not pick image. Please try again.");
      console.warn("ImagePicker error:", err.message);
    }
  };

  const handlePickSource = () => {
    Alert.alert(
      "Attach Document",
      "Choose a source",
      [
        {
          text:    "📄 Files (PDF)",
          onPress: handlePickDocument,
        },
        {
          text:    "🖼️ Photo Library",
          onPress: handlePickImage,
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  };

  const removeDocument = (index) => {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  };

  const changeDocumentType = (index, newType) => {
    setDocuments((prev) =>
      prev.map((d, i) => (i === index ? { ...d, docType: newType } : d))
    );
  };

  // ── Validation ─────────────────────────────────────────────────────────────

  const validate = () => {
    if (!schoolId?.toString().trim())
      return "No school selected. Go back and select a school.";
    if (!form.studentName.trim())
      return "Student name is required";
    if (!form.guardianName.trim())
      return "Guardian / parent name is required";
    if (!form.email.trim())
      return "Email address is required";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim()))
      return "Enter a valid email address";
    if (!form.phone.trim())
      return "Phone number is required";
    if (!selectedClass)
      return "Please select a class";
    return null;
  };

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // ── Build the text fields ────────────────────────────────────────────
      const parameters = {
        studentName:  form.studentName.trim(),
        guardianName: form.guardianName.trim(),
        email:        form.email.trim().toLowerCase(),
        phone:        form.phone.trim(),
        classId:      selectedClass.id,
        className:    selectedClass.name,
        schoolId:     String(schoolId),
      };

      if (form.notes.trim()) {
        parameters.notes = form.notes.trim();
      }

      documents.forEach((doc, index) => {
        parameters[`documentTypes[${index}]`] = doc.docType || "other";
      });

      const uploadUrl = `${API_URL}/public/students/apply`;

      // ─── CASE 1: No documents → simple JSON POST ────────────────────────
      if (documents.length === 0) {
        console.log("📤 Submitting application (no documents)");

        const res = await fetch(uploadUrl, {
          method:  "POST",
          headers: {
            "Content-Type": "application/json",
            Accept:         "application/json",
          },
          body: JSON.stringify(parameters),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          console.error("❌ Server response:", res.status, data);
          throw new Error(
            data.detail || data.message || `Submission failed (${res.status})`
          );
        }

        console.log("✅ Application submitted (no docs)");
        setStep(2);
        return;
      }

      // ─── CASE 2: With documents → use SDK 56 File API + FormData ─────────
      //
      // The new File class in expo-file-system creates a native file handle
      // that has proper read permissions granted via Expo's native module
      // bridge — bypassing Expo Go's Android sandbox restrictions.

      const firstDoc  = documents[0];
      const firstMime =
        firstDoc.mimeType && firstDoc.mimeType !== "application/octet-stream"
          ? firstDoc.mimeType
          : getMimeTypeFromName(firstDoc.name);

      console.log(
        `📤 Uploading file 1/${documents.length}:`,
        firstDoc.name,
        `(${firstMime})`
      );

      const formData = new FormData();

      // Text fields
      Object.entries(parameters).forEach(([key, value]) => {
        formData.append(key, String(value));
      });

      // ✅ SDK 56 File API — resolves URI in native code
      const file1 = new File(normalizeFileUri(firstDoc.uri));
      formData.append("documents", file1, firstDoc.name);

      const firstRes = await fetch(uploadUrl, {
        method:  "POST",
        headers: { Accept: "application/json" },
        body:    formData,
      });

      const firstBodyText = await firstRes.text();
      console.log("📥 First upload status:", firstRes.status);
      console.log("📥 First upload body:",   firstBodyText);

      let firstData;
      try {
        firstData = JSON.parse(firstBodyText || "{}");
      } catch {
        firstData = { message: firstBodyText || "Unexpected server response" };
      }

      if (!firstRes.ok) {
        throw new Error(
          firstData.detail || firstData.message ||
          `Submission failed (${firstRes.status})`
        );
      }

      const applicationId = firstData.applicationId;

      // ─── Upload additional files (if any) ───────────────────────────────
      if (documents.length > 1 && applicationId) {
        for (let i = 1; i < documents.length; i++) {
          const doc  = documents[i];
          const mime =
            doc.mimeType && doc.mimeType !== "application/octet-stream"
              ? doc.mimeType
              : getMimeTypeFromName(doc.name);

          console.log(
            `📤 Uploading file ${i + 1}/${documents.length}:`,
            doc.name,
            `(${mime})`
          );

          try {
            const fd = new FormData();
            fd.append("docType", doc.docType || "other");

            const file = new File(normalizeFileUri(doc.uri));
            fd.append("documents", file, doc.name);

            const res = await fetch(
              `${API_URL}/public/students/apply/${applicationId}/documents`,
              {
                method:  "POST",
                headers: { Accept: "application/json" },
                body:    fd,
              }
            );

            console.log(`📥 File ${i + 1} status:`, res.status);

            if (!res.ok) {
              const body = await res.text();
              console.warn(`⚠️ File ${i + 1} (${doc.name}) failed:`, body);
            }
          } catch (uploadErr) {
            console.warn(
              `⚠️ File ${i + 1} (${doc.name}) error:`,
              uploadErr.message
            );
          }
        }
      }

      console.log("✅ Application submitted successfully");
      setStep(2);
    } catch (e) {
      console.error("Submit error:", e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Success screen ──────────────────────────────────────────────────────────

  if (step === 2) {
    return (
      <View style={styles.successContainer}>
        <View style={styles.successCard}>
          <Text style={styles.successEmoji}>🎉</Text>
          <Text style={styles.successTitle}>Application Submitted!</Text>
          <Text style={styles.successMessage}>
            Thank you,{" "}
            <Text style={{ fontWeight: "700" }}>{form.studentName}</Text>!
            {"\n\n"}
            Your application to{" "}
            <Text style={{ fontWeight: "700" }}>
              {schoolName || "the school"}
            </Text>{" "}
            for{" "}
            <Text style={{ fontWeight: "700" }}>
              {selectedClass?.name}
            </Text>{" "}
            has been received.
            {"\n\n"}
            Login credentials will be sent to:
            {"\n"}
            <Text style={styles.successEmail}>{form.email}</Text>
            {"\n\n"}
            Please check your inbox and spam folder after approval.
          </Text>

          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.replace("/auth/login")}
          >
            <Text style={styles.backBtnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Application form ────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Back */}
        <TouchableOpacity
          style={styles.backArrow}
          onPress={() => router.back()}
        >
          <Text style={styles.backArrowText}>← Back</Text>
        </TouchableOpacity>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.emoji}>📋</Text>
          <Text style={styles.title}>Student Application</Text>

          {schoolName ? (
            <View style={styles.schoolBadge}>
              <Text style={styles.schoolBadgeText}>🏫 {schoolName}</Text>
            </View>
          ) : null}

          <Text style={styles.subtitle}>
            Fill in the details below. You will receive login credentials
            by email once your application is approved.
          </Text>
        </View>

        {/* Error */}
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️  {error}</Text>
          </View>
        ) : null}

        {/* ── Form ── */}
        <View style={styles.card}>

          {/* Student name */}
          <Text style={styles.label}>Student Full Name *</Text>
          <TextInput
            style={styles.input}
            value={form.studentName}
            onChangeText={(v) => updateField("studentName", v)}
            placeholder="e.g. John Doe"
            placeholderTextColor="#9CA3AF"
            autoCapitalize="words"
            returnKeyType="next"
          />

          {/* Guardian */}
          <Text style={styles.label}>Parent / Guardian Name *</Text>
          <TextInput
            style={styles.input}
            value={form.guardianName}
            onChangeText={(v) => updateField("guardianName", v)}
            placeholder="e.g. Jane Doe"
            placeholderTextColor="#9CA3AF"
            autoCapitalize="words"
            returnKeyType="next"
          />

          {/* Email */}
          <Text style={styles.label}>Email Address *</Text>
          <TextInput
            style={styles.input}
            value={form.email}
            onChangeText={(v) => updateField("email", v)}
            placeholder="student@example.com"
            placeholderTextColor="#9CA3AF"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />
          <Text style={styles.hint}>
            Login credentials will be sent to this address after approval
          </Text>

          {/* Phone */}
          <Text style={styles.label}>Phone Number *</Text>
          <TextInput
            style={styles.input}
            value={form.phone}
            onChangeText={(v) => updateField("phone", v)}
            placeholder="e.g. 08012345678"
            placeholderTextColor="#9CA3AF"
            keyboardType="phone-pad"
            returnKeyType="next"
          />

          {/* ── Class selection ── */}
          <Text style={styles.label}>Class Applying For *</Text>

          {availableClasses.length > 0 ? (
            <>
              <View style={styles.classGrid}>
                {availableClasses.map((cls) => {
                  const isSelected = selectedClass?.id === cls.id;
                  return (
                    <TouchableOpacity
                      key={cls.id}
                      style={[
                        styles.classChip,
                        isSelected && styles.classChipSelected,
                      ]}
                      onPress={() => {
                        setSelectedClass(cls);
                        if (error?.includes("class")) setError(null);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.classChipText,
                          isSelected && styles.classChipTextSelected,
                        ]}
                      >
                        {cls.name}
                      </Text>
                      {isSelected && (
                        <Text style={styles.checkmark}> ✓</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {selectedClass ? (
                <View style={styles.selectedConfirm}>
                  <Text style={styles.selectedConfirmText}>
                    ✅ Applying for:{" "}
                    <Text style={{ fontWeight: "700" }}>
                      {selectedClass.name}
                    </Text>
                    {selectedClass.level
                      ? `  ·  ${selectedClass.level}`
                      : ""}
                  </Text>
                </View>
              ) : null}
            </>
          ) : (
            <View style={styles.noClassesBox}>
              <Text style={styles.noClassesEmoji}>⚠️</Text>
              <Text style={styles.noClassesText}>
                No classes are currently available at this school.{"\n"}
                Please contact the school administration or try again later.
              </Text>
              <TouchableOpacity
                style={styles.goBackBtn}
                onPress={() => router.back()}
              >
                <Text style={styles.goBackBtnText}>
                  ← Select Another School
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Documents ── */}
          <View style={styles.sectionDivider} />

          <View style={styles.documentHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Supporting Documents</Text>
              <Text style={styles.hint2}>
                PDF or image · max {formatBytes(MAX_SIZE_BYTES)} each ·
                up to {MAX_DOCUMENTS} files
              </Text>
            </View>
            <Text style={styles.docCount}>
              {documents.length}/{MAX_DOCUMENTS}
            </Text>
          </View>

          {/* Uploaded files */}
          {documents.map((doc, index) => (
            <DocumentRow
              key={`${doc.uri}-${index}`}
              doc={doc}
              index={index}
              onRemove={removeDocument}
              onChangeType={changeDocumentType}
            />
          ))}

          {/* Add file button */}
          {documents.length < MAX_DOCUMENTS && (
            <TouchableOpacity
              style={styles.addDocBtn}
              onPress={handlePickSource}
              activeOpacity={0.7}
            >
              <Ionicons name="attach-outline" size={20} color="#4F46E5" />
              <Text style={styles.addDocBtnText}>
                {documents.length === 0
                  ? "Attach Documents (Optional)"
                  : "Attach Another Document"}
              </Text>
            </TouchableOpacity>
          )}

          {/* Document type legend */}
          {documents.length > 0 && (
            <View style={styles.legendBox}>
              <Text style={styles.legendText}>
                💡 Tap the document type badge to cycle through types:
                Birth Certificate → School Report → Medical → Photo → Other
              </Text>
            </View>
          )}

          {/* Notes */}
          <View style={styles.sectionDivider} />
          <Text style={[styles.label, { marginTop: 4 }]}>
            Additional Notes (optional)
          </Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            value={form.notes}
            onChangeText={(v) => updateField("notes", v)}
            placeholder="Any special requirements or information…"
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        {/* Submit */}
        {availableClasses.length > 0 && (
          <>
            <TouchableOpacity
              style={[
                styles.submitBtn,
                loading && styles.submitBtnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <Text style={styles.submitBtnText}>
                  Submit Application →
                </Text>
              )}
            </TouchableOpacity>

            <Text style={styles.disclaimer}>
              By submitting you agree that your information will be reviewed
              by the school administration.
            </Text>
          </>
        )}

        <View style={{ height: 20 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },
  scroll:    { padding: 24, paddingTop: 48, paddingBottom: 40 },

  backArrow:     { marginBottom: 16 },
  backArrowText: { color: "#4F46E5", fontSize: 15, fontWeight: "600" },

  header:   { alignItems: "center", marginBottom: 24 },
  emoji:    { fontSize: 40, marginBottom: 8 },
  title:    {
    fontSize:   26,
    fontWeight: "800",
    color:      "#111827",
    textAlign:  "center",
  },
  subtitle: {
    fontSize:   13,
    color:      "#6B7280",
    textAlign:  "center",
    lineHeight: 20,
    marginTop:  8,
  },

  schoolBadge: {
    backgroundColor:   "#EEF2FF",
    borderRadius:      20,
    paddingVertical:   6,
    paddingHorizontal: 14,
    marginTop:         10,
    borderWidth:       1,
    borderColor:       "#C7D2FE",
  },
  schoolBadgeText: { color: "#4338CA", fontWeight: "700", fontSize: 13 },

  errorBox: {
    backgroundColor: "#FEF2F2",
    borderRadius:    10,
    padding:         14,
    marginBottom:    16,
    borderWidth:     1,
    borderColor:     "#FECACA",
  },
  errorText: { color: "#DC2626", fontSize: 13, lineHeight: 18 },

  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         24,
    shadowColor:     "#000",
    shadowOpacity:   0.06,
    shadowRadius:    12,
    elevation:       3,
    marginBottom:    20,
  },

  label: {
    fontSize:     13,
    fontWeight:   "600",
    color:        "#374151",
    marginBottom: 6,
    marginTop:    4,
  },
  hint: {
    fontSize:     11,
    color:        "#9CA3AF",
    marginTop:    -10,
    marginBottom: 14,
  },
  hint2: {
    fontSize:  11,
    color:     "#9CA3AF",
    marginTop: 2,
  },
  input: {
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    borderRadius:    10,
    padding:         12,
    fontSize:        15,
    color:           "#111827",
    backgroundColor: "#F9FAFB",
    marginBottom:    16,
  },
  textarea: { height: 100 },

  // Class chips
  classGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           10,
    marginBottom:  12,
  },
  classChip: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      24,
    borderWidth:       1.5,
    borderColor:       "#D1D5DB",
    backgroundColor:   "#FFF",
  },
  classChipSelected: {
    backgroundColor: "#4F46E5",
    borderColor:     "#4F46E5",
  },
  classChipText:         { fontSize: 14, color: "#374151", fontWeight: "500" },
  classChipTextSelected: { color: "#FFF", fontWeight: "700" },
  checkmark:             { color: "#FFF", fontSize: 14, fontWeight: "800" },

  selectedConfirm: {
    backgroundColor: "#F0FDF4",
    borderRadius:    10,
    padding:         12,
    marginBottom:    16,
    borderWidth:     1,
    borderColor:     "#BBF7D0",
  },
  selectedConfirmText: { fontSize: 13, color: "#166534" },

  noClassesBox: {
    backgroundColor: "#FFFBEB",
    borderRadius:    12,
    padding:         20,
    alignItems:      "center",
    borderWidth:     1,
    borderColor:     "#FDE68A",
    marginBottom:    16,
  },
  noClassesEmoji: { fontSize: 32, marginBottom: 8 },
  noClassesText: {
    fontSize:     13,
    color:        "#92400E",
    textAlign:    "center",
    lineHeight:   20,
    marginBottom: 12,
  },
  goBackBtn: {
    backgroundColor:   "#F59E0B",
    borderRadius:      8,
    paddingVertical:   10,
    paddingHorizontal: 20,
  },
  goBackBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },

  // Documents
  sectionDivider: {
    height:          1,
    backgroundColor: "#F3F4F6",
    marginVertical:  16,
  },
  documentHeader: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "flex-start",
    marginBottom:   12,
  },
  docCount: {
    fontSize:   12,
    color:      "#6B7280",
    fontWeight: "600",
    marginTop:  4,
  },
  addDocBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    borderWidth:     1.5,
    borderColor:     "#C7D2FE",
    borderStyle:     "dashed",
    borderRadius:    12,
    paddingVertical: 14,
    backgroundColor: "#F5F7FF",
    marginBottom:    8,
  },
  addDocBtnText: { color: "#4F46E5", fontSize: 14, fontWeight: "600" },
  legendBox: {
    backgroundColor: "#FFF7ED",
    borderRadius:    8,
    padding:         10,
    marginTop:       4,
    marginBottom:    4,
    borderWidth:     1,
    borderColor:     "#FED7AA",
  },
  legendText: { fontSize: 11, color: "#92400E", lineHeight: 16 },

  // Submit
  submitBtn: {
    backgroundColor: "#4F46E5",
    borderRadius:    14,
    padding:         16,
    alignItems:      "center",
    marginBottom:    16,
    shadowColor:     "#4F46E5",
    shadowOpacity:   0.3,
    shadowRadius:    8,
    elevation:       4,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText:     { color: "#FFF", fontSize: 16, fontWeight: "700" },

  disclaimer: {
    fontSize:   12,
    color:      "#9CA3AF",
    textAlign:  "center",
    lineHeight: 18,
  },

  // Success
  successContainer: {
    flex:            1,
    backgroundColor: "#F9FAFB",
    justifyContent:  "center",
    padding:         24,
  },
  successCard: {
    backgroundColor: "#FFF",
    borderRadius:    24,
    padding:         32,
    alignItems:      "center",
    shadowColor:     "#000",
    shadowOpacity:   0.08,
    shadowRadius:    16,
    elevation:       4,
  },
  successEmoji: { fontSize: 64, marginBottom: 16 },
  successTitle: {
    fontSize:     24,
    fontWeight:   "800",
    color:        "#111827",
    marginBottom: 16,
    textAlign:    "center",
  },
  successMessage: {
    fontSize:     15,
    color:        "#374151",
    textAlign:    "center",
    lineHeight:   24,
    marginBottom: 24,
  },
  successEmail: { color: "#4F46E5", fontWeight: "700" },
  backBtn: {
    backgroundColor:   "#4F46E5",
    borderRadius:      12,
    paddingVertical:   14,
    paddingHorizontal: 32,
  },
  backBtnText: { color: "#FFF", fontSize: 15, fontWeight: "700" },
});