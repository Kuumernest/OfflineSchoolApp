// app/auth/apply.js

import React, { useState, useMemo, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker    from "expo-image-picker";
// SDK 57 moved the default export of expo-file-system to the new File/Directory
// API, and the old helpers imported from the package root now THROW at runtime
// rather than warn. Importing them from "/legacy" is what keeps this working;
// without it every call here fails with a deprecation error at the moment a
// user asks for a PDF.
import * as FileSystem     from "expo-file-system/legacy";
import { Ionicons }        from "@expo/vector-icons";
import { API_URL }         from "../../src/services/api";
import { useTranslation }  from "../../src/i18n/useTranslation";
import { useScreenInsets } from "../../src/hooks/useScreenInsets";
import { errorText } from "../../src/utils/appError";
import {
  COLORS, ACCENT, SEMANTIC, accentBadge, categoryAccent, levelAccent,
} from "../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../src/components/Tinted";

const SCHOOL_BADGE = accentBadge("indigo");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DOCUMENTS  = 5;
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

const DOCUMENT_TYPES = [
  { value: "birth_certificate"   },
  { value: "school_report"       },
  { value: "medical_certificate" },
  { value: "passport_photo"      },
  { value: "other"               },
];

/** Visible label for a document type — falls back to "Other". */
const docTypeLabel = (t, value) =>
  DOCUMENT_TYPES.some((d) => d.value === value)
    ? t(`applyForm.docType.${value}`)
    : t("applyForm.docType.other");

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const formatBytes = (bytes) => {
  if (!bytes) return "";
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

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

const isAllowedMime = (mime) =>
  ALLOWED_MIME_TYPES.has(mime) || Boolean(mime?.startsWith("image/"));

/**
 * Reads a file URI and returns its base64-encoded content.
 * Works with both file:// and content:// URIs via expo-file-system.
 *
 * This is the ONLY reliable way to read files in Expo Go on Android —
 * the fetch bridge's FormData file-object support is broken in Expo Go.
 */
const readFileAsBase64 = async (uri) => {
  try {
    // expo-file-system handles both file:// and content:// URIs
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return base64;
  } catch (err) {
    console.warn("readFileAsBase64 failed:", err.message);
    throw new Error(`Could not read file: ${err.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FIELD ERROR
// ─────────────────────────────────────────────────────────────────────────────

const FieldError = ({ message }) =>
  message ? <Text style={styles.fieldError}>{message}</Text> : null;

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT ROW
// ─────────────────────────────────────────────────────────────────────────────

const DocumentRow = ({ doc, index, onRemove, onChangeType }) => {
  const { t } = useTranslation();

  return (
  <View style={docStyles.row}>
    <IconSquare
      icon={doc.mimeType?.startsWith("image/") ? "image-outline" : "document-outline"}
      accent="indigo"
      size={40}
      radius={10}
    />

    <View style={docStyles.info}>
      <Text style={docStyles.fileName} numberOfLines={1}>{doc.name}</Text>
      <Text style={docStyles.fileSize}>{formatBytes(doc.size)}</Text>

      <TouchableOpacity
        onPress={() => {
          const cur  = DOCUMENT_TYPES.findIndex((d) => d.value === doc.docType);
          const next = DOCUMENT_TYPES[(cur + 1) % DOCUMENT_TYPES.length];
          onChangeType(index, next.value);
        }}
        style={[docStyles.typeChip, typeChipColours(doc.docType)]}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={t("applyForm.changeDocType", {
          label: docTypeLabel(t, doc.docType),
        })}
      >
        <Text style={[docStyles.typeChipText, { color: accentBadge(categoryAccent(doc.docType)).text }]}>
          {docTypeLabel(t, doc.docType)} ↺
        </Text>
      </TouchableOpacity>
    </View>

    <TouchableOpacity
      onPress={() => onRemove(index)}
      style={docStyles.removeBtn}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={t("applyForm.removeDoc", { name: doc.name })}
    >
      <Ionicons name="close-circle" size={22} color={SEMANTIC.error.icon} />
    </TouchableOpacity>
  </View>
  );
};

/** A document type's chip: its category colour, never grey. */
const typeChipColours = (docType) => {
  const b = accentBadge(categoryAccent(docType));
  return { backgroundColor: b.bg, borderColor: b.border };
};

const docStyles = StyleSheet.create({
  row: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: ACCENT.indigo.wash,
    borderRadius:    12,
    padding:         12,
    marginBottom:    8,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: ACCENT.indigo.base,
    gap:             10,
  },
  info:         { flex: 1 },
  fileName:     { fontSize: 13, fontWeight: "600", color: COLORS.text },
  fileSize:     { fontSize: 11, color: COLORS.textSecondary, marginTop: 1 },
  typeChip: {
    marginTop:         4,
    alignSelf:         "flex-start",
    borderWidth:       1,
    borderRadius:      20,
    paddingVertical:   3,
    paddingHorizontal: 10,
  },
  typeChipText: { fontSize: 11, fontWeight: "600" },
  removeBtn:    { padding: 4 },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

export default function ApplyScreen() {
  const router  = useRouter();
  const { t }   = useTranslation();
  const screenPad = useScreenInsets({ top: 24, bottom: 32 });

  const {
    schoolId,
    schoolName,
    classes: classesParam,
  } = useLocalSearchParams();

  const availableClasses = useMemo(() => {
    try {
      const parsed = classesParam ? JSON.parse(classesParam) : [];
      return parsed.map((c) => ({ ...c, id: String(c.id || c._id || "") }));
    } catch {
      return [];
    }
  }, [classesParam]);

  const [step,          setStep]          = useState(1);
  const [loading,       setLoading]       = useState(false);
  const [uploadStage,   setUploadStage]   = useState("");
  const [error,         setError]         = useState(null);
  const [fieldErrors,   setFieldErrors]   = useState({});
  const [selectedClass, setSelectedClass] = useState(null);
  const [documents,     setDocuments]     = useState([]);

  const [form, setForm] = useState({
    studentName:  "",
    guardianName: "",
    email:        "",
    phone:        "",
    notes:        "",
  });

  const updateField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) {
      setFieldErrors((prev) => ({ ...prev, [key]: null }));
    }
  }, [fieldErrors]);

  // ── Validation ─────────────────────────────────────────────────────────────

  const validate = useCallback(() => {
    const errs = {};
    if (!schoolId?.toString().trim()) errs.school       = t("applyForm.errNoSchool");
    if (!form.studentName.trim())     errs.studentName  = t("applyForm.errStudentName");
    if (!form.guardianName.trim())    errs.guardianName = t("applyForm.errGuardian");
    if (!form.email.trim())           errs.email        = t("applyForm.errEmailRequired");
    else if (!EMAIL_REGEX.test(form.email.trim())) errs.email = t("applyForm.errEmailInvalid");
    if (!form.phone.trim())           errs.phone        = t("applyForm.errPhone");
    if (!selectedClass)               errs.class        = t("applyForm.errClass");
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }, [form, selectedClass, schoolId, t]);

  // ── Document helpers ───────────────────────────────────────────────────────

  const addDocument = useCallback((file) => {
    if (documents.length >= MAX_DOCUMENTS) {
      Alert.alert(
        t("applyForm.alertLimitTitle"),
        t("applyForm.alertLimitBody", { count: MAX_DOCUMENTS })
      );
      return;
    }
    if (file.size && file.size > MAX_SIZE_BYTES) {
      Alert.alert(
        t("applyForm.alertTooLargeTitle"),
        t("applyForm.alertTooLargeBody", {
          name: file.name,
          size: formatBytes(file.size),
          max:  formatBytes(MAX_SIZE_BYTES),
        })
      );
      return;
    }
    const mime = file.mimeType || getMimeTypeFromName(file.name);
    if (!isAllowedMime(mime)) {
      Alert.alert(
        t("applyForm.alertUnsupportedTitle"),
        t("applyForm.alertUnsupportedBody", { name: file.name })
      );
      return;
    }
    const alreadyAdded = documents.some(
      (d) =>
        (d.uri && file.uri && d.uri === file.uri) ||
        (d.name === file.name && d.size === file.size)
    );
    if (alreadyAdded) {
      Alert.alert(
        t("applyForm.alertAlreadyTitle"),
        t("applyForm.alertAlreadyBody", { name: file.name })
      );
      return;
    }
    setDocuments((prev) => [...prev, { ...file, mimeType: mime, docType: "other" }]);
  }, [documents, t]);

  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type:                 ["application/pdf", "image/*"],
        copyToCacheDirectory: true,
        multiple:             false,
      });
      if (result.canceled) return;
      const asset    = result.assets?.[0];
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
      Alert.alert(t("applyForm.alertErrorTitle"), t("applyForm.alertPickDocFailed"));
      console.warn("DocumentPicker error:", err.message);
    }
  };

  const handlePickImage = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          t("applyForm.alertPermissionTitle"),
          t("applyForm.alertPermissionBody")
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
      const uriParts = asset.uri.split("/");
      let   fileName = uriParts[uriParts.length - 1] || `photo_${Date.now()}.jpg`;
      if (!fileName.includes(".")) {
        const ext = asset.mimeType?.split("/")[1] || "jpg";
        fileName  = `${fileName}.${ext}`;
      }
      const mimeType = asset.mimeType || getMimeTypeFromName(fileName);
      addDocument({
        name:     fileName,
        uri:      asset.uri,
        size:     asset.fileSize || 0,
        mimeType,
      });
    } catch (err) {
      Alert.alert(t("applyForm.alertErrorTitle"), t("applyForm.alertPickImageFailed"));
      console.warn("ImagePicker error:", err.message);
    }
  };

  const handlePickSource = () => {
    Alert.alert(
      t("applyForm.alertAttachTitle"),
      t("applyForm.alertAttachBody"),
      [
        { text: `📄 ${t("applyForm.sourceFiles")}`,  onPress: handlePickDocument },
        { text: `🖼️ ${t("applyForm.sourcePhotos")}`, onPress: handlePickImage    },
        { text: t("applyForm.cancel"),               style:   "cancel"           },
      ]
    );
  };

  const removeDocument = useCallback((index) => {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const changeDocumentType = useCallback((index, newType) => {
    setDocuments((prev) =>
      prev.map((d, i) => (i === index ? { ...d, docType: newType } : d))
    );
  }, []);

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!validate()) {
      setError(t("applyForm.fixErrors"));
      return;
    }

    setLoading(true);
    setError(null);
    setUploadStage(
      documents.length > 0
        ? t("applyForm.stageReadingFiles")
        : t("applyForm.stageSubmitting")
    );

    try {
      const uploadUrl = `${API_URL}/public/students/apply`;

      const payload = {
        studentName:  form.studentName.trim(),
        guardianName: form.guardianName.trim(),
        email:        form.email.trim().toLowerCase(),
        phone:        form.phone.trim(),
        classId:      selectedClass.id,
        className:    selectedClass.name,
        schoolId:     String(schoolId),
      };
      if (form.notes.trim()) payload.notes = form.notes.trim();

      // ── No documents → plain JSON POST ────────────────────────────────────
      if (documents.length === 0) {
        console.log("📤 Submitting (no documents)");
        setUploadStage(t("applyForm.stageSubmitting"));

        const res  = await fetch(uploadUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body:    JSON.stringify(payload),
        });

        const text = await res.text();
        let   data;
        try   { data = JSON.parse(text); }
        catch { data = { message: text || t("applyForm.unexpectedResponse") }; }

        if (!res.ok) {
          throw new Error(
            data.detail ||
            data.message ||
            t("applyForm.submissionFailed", { status: res.status })
          );
        }

        console.log("✅ Submitted (no documents)");
        setStep(2);
        return;
      }

      // ── With documents ─────────────────────────────────────────────────────
      //
      // Expo Go's fetch bridge on Android does NOT support the
      // { uri, name, type } FormData file-object pattern — it throws
      // "Unsupported FormDataPart implementation".
      //
      // Solution: read each file as base64 via expo-file-system and send
      // everything as a JSON payload. The server decodes and saves the files.
      //
      console.log(`📤 Submitting with ${documents.length} document(s) via base64`);

      const files = [];
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        setUploadStage(t("applyForm.stageReadingFile", {
          index: i + 1,
          total: documents.length,
        }));

        console.log(`  ↳ reading: ${doc.name} (${doc.mimeType})`);

        const base64 = await readFileAsBase64(doc.uri);

        files.push({
          name:     doc.name,
          mimeType: doc.mimeType,
          docType:  doc.docType || "other",
          size:     doc.size    || 0,
          base64,                          // server decodes this to a Buffer
        });
      }

      setUploadStage(t("applyForm.stageUploading"));

      const res = await fetch(uploadUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body:    JSON.stringify({ ...payload, files }),
      });

      const text = await res.text();
      console.log("📥 Status:", res.status);
      console.log("📥 Body:",   text.slice(0, 300));

      let data;
      try   { data = JSON.parse(text); }
      catch { data = { message: text || t("applyForm.unexpectedResponse") }; }

      if (!res.ok) {
        throw new Error(
          data.detail ||
          data.message ||
          t("applyForm.submissionFailed", { status: res.status })
        );
      }

      console.log("✅ Application submitted successfully");
      setStep(2);
    } catch (e) {
      console.error("Submit error:", e);
      setError(errorText(t, e));
    } finally {
      setLoading(false);
      setUploadStage("");
    }
  };

  // ── Success screen ─────────────────────────────────────────────────────────

  if (step === 2) {
    return (
      <View style={styles.successContainer}>
        <View style={styles.successCard}>
          <IconSquare icon="checkmark-circle" accent="green" size={64} radius={18} style={styles.successIcon} />
          <Text style={styles.successTitle}>{t("applyForm.successTitle")}</Text>
          <Text style={styles.successMessage}>
            {t("applyForm.successThanksPre")}
            <Text style={{ fontWeight: "700" }}>{form.studentName}</Text>
            {t("applyForm.successThanksPost")}
            {"\n\n"}
            {t("applyForm.successAppPre")}
            <Text style={{ fontWeight: "700" }}>
              {schoolName || t("applyForm.schoolFallback")}
            </Text>
            {t("applyForm.successAppMid")}
            <Text style={{ fontWeight: "700" }}>{selectedClass?.name}</Text>
            {t("applyForm.successAppPost")}
            {"\n\n"}
            {t("applyForm.successCredentials")}{"\n"}
            <Text style={styles.successEmail}>{form.email}</Text>
            {"\n\n"}
            {t("applyForm.successCheckInbox")}
          </Text>

          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.replace("/auth/login")}
            accessibilityRole="button"
            accessibilityLabel={t("applyForm.backToLogin")}
          >
            <Text style={styles.backBtnText}>{t("applyForm.backToLogin")}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Application form ───────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      // "padding" on Android too. Edge-to-edge stopped the window resizing
      // for the keyboard, so an undefined behaviour left this doing nothing
      // and the field being typed into sat underneath the keys.
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, screenPad]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          style={styles.backArrow}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t("applyForm.goBack")}
        >
          <Text style={styles.backArrowText}>← {t("applyForm.back")}</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <View style={styles.titleRow}>
            <HeaderIcon icon="document-text" />
            <Text style={styles.title}>{t("applyForm.heading")}</Text>
          </View>
          {schoolName ? (
            <View style={styles.schoolBadge}>
              <Text style={styles.schoolBadgeText}>🏫 {schoolName}</Text>
            </View>
          ) : null}
          <Text style={styles.subtitle}>{t("applyForm.subtitle")}</Text>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️  {error}</Text>
          </View>
        ) : null}

        {fieldErrors.school ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️  {fieldErrors.school}</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.sectionHead}>
            <IconSquare icon="person" accent="blue" size={28} />
            <Text style={[styles.label, styles.labelInHead]}>{t("applyForm.labelStudentName")} *</Text>
          </View>
          <TextInput
            style={[styles.input, fieldErrors.studentName && styles.inputError]}
            value={form.studentName}
            onChangeText={(v) => updateField("studentName", v)}
            placeholder={t("applyForm.phStudentName")}
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="words"
            returnKeyType="next"
            accessibilityLabel={t("applyForm.a11yStudentName")}
          />
          <FieldError message={fieldErrors.studentName} />

          <Text style={styles.label}>{t("applyForm.labelGuardian")} *</Text>
          <TextInput
            style={[styles.input, fieldErrors.guardianName && styles.inputError]}
            value={form.guardianName}
            onChangeText={(v) => updateField("guardianName", v)}
            placeholder={t("applyForm.phGuardian")}
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="words"
            returnKeyType="next"
            accessibilityLabel={t("applyForm.a11yGuardian")}
          />
          <FieldError message={fieldErrors.guardianName} />

          <Text style={styles.label}>{t("applyForm.labelEmail")} *</Text>
          <TextInput
            style={[styles.input, fieldErrors.email && styles.inputError]}
            value={form.email}
            onChangeText={(v) => updateField("email", v)}
            placeholder="student@example.com"
            placeholderTextColor={COLORS.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            accessibilityLabel={t("applyForm.a11yEmail")}
          />
          <FieldError message={fieldErrors.email} />
          {!fieldErrors.email && (
            <Text style={styles.hint}>{t("applyForm.emailHint")}</Text>
          )}

          <Text style={styles.label}>{t("applyForm.labelPhone")} *</Text>
          <TextInput
            style={[styles.input, fieldErrors.phone && styles.inputError]}
            value={form.phone}
            onChangeText={(v) => updateField("phone", v)}
            placeholder={t("applyForm.phPhone")}
            placeholderTextColor={COLORS.textMuted}
            keyboardType="phone-pad"
            returnKeyType="next"
            accessibilityLabel={t("applyForm.a11yPhone")}
          />
          <FieldError message={fieldErrors.phone} />

          <View style={styles.sectionHead}>
            <IconSquare icon="school" accent="indigo" size={28} />
            <Text style={[styles.label, styles.labelInHead]}>{t("applyForm.labelClass")} *</Text>
          </View>
          <FieldError message={fieldErrors.class} />

          {availableClasses.length > 0 ? (
            <>
              <View style={styles.classGrid}>
                {availableClasses.map((cls) => {
                  const isSelected = selectedClass?.id === cls.id;
                  const ca = ACCENT[levelAccent(cls.level)];
                  return (
                    <TouchableOpacity
                      key={cls.id}
                      style={[
                        styles.classChip,
                        isSelected && { backgroundColor: ca.wash, borderColor: ca.base },
                        fieldErrors.class && styles.classChipError,
                      ]}
                      onPress={() => {
                        setSelectedClass(cls);
                        if (fieldErrors.class) {
                          setFieldErrors((prev) => ({ ...prev, class: null }));
                        }
                        if (error) setError(null);
                      }}
                      activeOpacity={0.7}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={t("applyForm.a11ySelectClass", { name: cls.name })}
                    >
                      <Text style={[styles.classChipText, isSelected && { color: ca.deep, fontWeight: "700" }]}>
                        {cls.name}
                      </Text>
                      {isSelected && <Text style={[styles.checkmark, { color: ca.deep }]}> ✓</Text>}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {selectedClass ? (
                <View style={styles.selectedConfirm}>
                  <Text style={styles.selectedConfirmText}>
                    ✅ {t("applyForm.applyingFor")}{" "}
                    <Text style={{ fontWeight: "700" }}>{selectedClass.name}</Text>
                    {selectedClass.level ? `  ·  ${selectedClass.level}` : ""}
                  </Text>
                </View>
              ) : null}
            </>
          ) : (
            <View style={styles.noClassesBox}>
              <IconSquare icon="warning" accent="amber" size={40} radius={12} style={styles.noClassesIcon} />
              <Text style={styles.noClassesText}>{t("applyForm.noClasses")}</Text>
              <TouchableOpacity
                style={styles.goBackBtn}
                onPress={() => router.back()}
                accessibilityRole="button"
                accessibilityLabel={t("applyForm.selectAnotherSchool")}
              >
                <Text style={styles.goBackBtnText}>
                  ← {t("applyForm.selectAnotherSchool")}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.sectionDivider} />

          <View style={styles.documentHeader}>
            <IconSquare icon="attach" accent="indigo" size={28} style={styles.docHeadIcon} />
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{t("applyForm.labelDocuments")}</Text>
              <Text style={styles.hint2}>
                {t("applyForm.docsHint", {
                  size:  formatBytes(MAX_SIZE_BYTES),
                  count: MAX_DOCUMENTS,
                })}
              </Text>
            </View>
            <Text style={styles.docCount}>{documents.length}/{MAX_DOCUMENTS}</Text>
          </View>

          {documents.map((doc, index) => (
            <DocumentRow
              key={`${doc.uri}-${index}`}
              doc={doc}
              index={index}
              onRemove={removeDocument}
              onChangeType={changeDocumentType}
            />
          ))}

          {documents.length < MAX_DOCUMENTS && (
            <TouchableOpacity
              style={styles.addDocBtn}
              onPress={handlePickSource}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={
                documents.length === 0
                  ? t("applyForm.a11yAttachDocs")
                  : t("applyForm.a11yAttachAnother")
              }
            >
              <Ionicons name="attach-outline" size={20} color={ACCENT.indigo.solid} />
              <Text style={styles.addDocBtnText}>
                {documents.length === 0
                  ? t("applyForm.attachDocs")
                  : t("applyForm.attachAnother")}
              </Text>
            </TouchableOpacity>
          )}

          {documents.length > 0 && (
            <View style={styles.legendBox}>
              <Text style={styles.legendText}>
                💡 {t("applyForm.docLegend")}
              </Text>
            </View>
          )}

          <View style={styles.sectionDivider} />
          <Text style={[styles.label, { marginTop: 4 }]}>{t("applyForm.labelNotes")}</Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            value={form.notes}
            onChangeText={(v) => updateField("notes", v)}
            placeholder={t("applyForm.phNotes")}
            placeholderTextColor={COLORS.textMuted}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            accessibilityLabel={t("applyForm.a11yNotes")}
          />
        </View>

        {availableClasses.length > 0 && (
          <>
            <TouchableOpacity
              style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityState={{ disabled: loading, busy: loading }}
              accessibilityLabel={t("applyForm.a11ySubmit")}
            >
              {loading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color={COLORS.onPrimary} />
                  {uploadStage ? (
                    <Text style={styles.uploadStageText}>{uploadStage}</Text>
                  ) : null}
                </View>
              ) : (
                <Text style={styles.submitBtnText}>{t("applyForm.submit")} →</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.disclaimer}>{t("applyForm.disclaimer")}</Text>
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
  container: { flex: 1, backgroundColor: COLORS.page },
  scroll:    { paddingHorizontal: 24 },

  backArrow:     { marginBottom: 16 },
  backArrowText: { color: COLORS.primary, fontSize: 15, fontWeight: "600" },

  header:   { alignItems: "center", marginBottom: 24 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  title:    { fontSize: 26, fontWeight: "800", color: COLORS.text, textAlign: "center", flexShrink: 1 },
  subtitle: { fontSize: 13, color: COLORS.textSecondary, textAlign: "center", lineHeight: 20, marginTop: 8 },

  schoolBadge: {
    backgroundColor:   SCHOOL_BADGE.bg,
    borderRadius:      20,
    paddingVertical:   6,
    paddingHorizontal: 14,
    marginTop:         10,
    borderWidth:       1,
    borderColor:       SCHOOL_BADGE.border,
  },
  schoolBadgeText: { color: SCHOOL_BADGE.text, fontWeight: "700", fontSize: 13 },

  errorBox: {
    backgroundColor: SEMANTIC.error.bg,
    borderRadius:    10,
    padding:         14,
    marginBottom:    16,
    borderWidth:     1,
    borderColor:     SEMANTIC.error.box,
  },
  errorText: { color: SEMANTIC.error.text, fontSize: 13, lineHeight: 18 },

  card: {
    backgroundColor: COLORS.surface,
    borderRadius:    16,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.blue.base,
    padding:         24,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.06,
    shadowRadius:    12,
    elevation:       3,
    marginBottom:    20,
  },

  label:      { fontSize: 13, fontWeight: "600", color: COLORS.text, marginBottom: 6, marginTop: 4 },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6, marginTop: 4 },
  labelInHead: { flex: 1, marginBottom: 0, marginTop: 0 },
  hint:       { fontSize: 11, color: COLORS.textSecondary, marginTop: -2, marginBottom: 14 },
  hint2:      { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  fieldError: { color: SEMANTIC.error.text, fontSize: 11, marginTop: 0, marginBottom: 12 },

  input: {
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderRadius:    10,
    padding:         12,
    fontSize:        15,
    color:           COLORS.text,
    backgroundColor: COLORS.surface,
    marginBottom:    6,
  },
  inputError: { borderColor: SEMANTIC.error.icon, backgroundColor: SEMANTIC.error.bg },
  textarea:   { height: 100, marginBottom: 6 },

  classGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           10,
    marginBottom:  12,
    marginTop:     4,
  },
  classChip: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      24,
    borderWidth:       1.5,
    borderColor:       COLORS.border,
    backgroundColor:   COLORS.surface,
  },
  classChipError:        { borderColor: SEMANTIC.error.icon },
  classChipText:         { fontSize: 14, color: COLORS.text, fontWeight: "500" },
  checkmark:             { fontSize: 14, fontWeight: "800" },

  selectedConfirm: {
    backgroundColor: SEMANTIC.success.bg,
    borderRadius:    10,
    padding:         12,
    marginBottom:    16,
    borderWidth:     1,
    borderColor:     SEMANTIC.success.box,
  },
  selectedConfirmText: { fontSize: 13, color: SEMANTIC.success.text },

  noClassesBox: {
    backgroundColor: SEMANTIC.warning.bg,
    borderRadius:    12,
    padding:         20,
    alignItems:      "center",
    borderWidth:     1,
    borderColor:     SEMANTIC.warning.box,
    marginBottom:    16,
  },
  noClassesIcon: { marginBottom: 8 },
  noClassesText: {
    fontSize:     13,
    color:        SEMANTIC.warning.text,
    textAlign:    "center",
    lineHeight:   20,
    marginBottom: 12,
  },
  goBackBtn: {
    backgroundColor:   ACCENT.amber.solid,
    borderRadius:      8,
    paddingVertical:   10,
    paddingHorizontal: 20,
  },
  goBackBtnText: { color: COLORS.onPrimary, fontWeight: "700", fontSize: 13 },

  sectionDivider: { height: 1, backgroundColor: COLORS.border, marginVertical: 16 },
  documentHeader: {
    flexDirection:  "row",
    justifyContent: "space-between",
    alignItems:     "flex-start",
    marginBottom:   12,
  },
  docHeadIcon: { marginRight: 8 },
  docCount:   { fontSize: 12, color: ACCENT.indigo.deep, fontWeight: "600", marginTop: 4 },
  addDocBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    borderWidth:     1.5,
    borderColor:     ACCENT.indigo.base,
    borderStyle:     "dashed",
    borderRadius:    12,
    paddingVertical: 14,
    backgroundColor: ACCENT.indigo.wash,
    marginBottom:    8,
  },
  addDocBtnText: { color: ACCENT.indigo.deep, fontSize: 14, fontWeight: "600" },
  legendBox: {
    backgroundColor: SEMANTIC.warning.bg,
    borderRadius:    8,
    padding:         10,
    marginTop:       4,
    marginBottom:    4,
    borderWidth:     1,
    borderColor:     SEMANTIC.warning.box,
  },
  legendText: { fontSize: 11, color: SEMANTIC.warning.text, lineHeight: 16 },

  submitBtn: {
    backgroundColor: COLORS.primary,
    borderRadius:    14,
    padding:         16,
    alignItems:      "center",
    marginBottom:    16,
    shadowColor:     COLORS.primary,
    shadowOpacity:   0.3,
    shadowRadius:    8,
    elevation:       4,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText:     { color: COLORS.onPrimary, fontSize: 16, fontWeight: "700" },
  loadingRow:        { flexDirection: "row", alignItems: "center", gap: 10 },
  uploadStageText:   { color: COLORS.onPrimary, fontSize: 13, fontWeight: "600" },

  disclaimer: { fontSize: 12, color: COLORS.textSecondary, textAlign: "center", lineHeight: 18 },

  successContainer: {
    flex:            1,
    backgroundColor: COLORS.page,
    justifyContent:  "center",
    padding:         24,
  },
  successCard: {
    backgroundColor: SEMANTIC.success.bg,
    borderRadius:    24,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.green.base,
    padding:         32,
    alignItems:      "center",
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.08,
    shadowRadius:    16,
    elevation:       4,
  },
  successIcon:    { marginBottom: 16 },
  successTitle:   { fontSize: 24, fontWeight: "800", color: COLORS.text, marginBottom: 16, textAlign: "center" },
  successMessage: { fontSize: 15, color: COLORS.text, textAlign: "center", lineHeight: 24, marginBottom: 24 },
  successEmail:   { color: ACCENT.green.deep, fontWeight: "700" },
  backBtn: {
    backgroundColor:   COLORS.primary,
    borderRadius:      12,
    paddingVertical:   14,
    paddingHorizontal: 32,
  },
  backBtnText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: "700" },
});