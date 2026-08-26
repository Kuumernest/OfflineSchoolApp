import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StatusBar,
  ActivityIndicator,
  Alert,
  Platform,
  Animated,
  KeyboardAvoidingView,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useAuthStore }    from "../../../src/store/auth.store";
import { uploadContent }   from "../../../src/services/content.service";
import { useTranslation }  from "../../../src/i18n/useTranslation";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const CONTENT_TYPES = [
  {
    id:     "syllabus",
    labelKey: "uploadNotes.typeSyllabus",
    icon:   "list-outline",
    color:  "#7C3AED",
    bg:     "#EDE9FE",
    accept: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    hint:  "PDF, DOC",
    maxMB: 50,
  },
  {
    id:     "notes",
    labelKey: "uploadNotes.typeNotes",
    icon:   "document-text-outline",
    color:  "#4F46E5",
    bg:     "#EEF2FF",
    accept: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    hint:  "PDF, DOC, DOCX",
    maxMB: 50,
  },
  {
    id:     "image",
    labelKey: "uploadNotes.typeImage",
    icon:   "image-outline",
    color:  "#059669",
    bg:     "#ECFDF5",
    accept: ["image/jpeg", "image/png", "image/jpg", "image/webp"],
    hint:   "JPG, PNG, WEBP",
    maxMB:  20,
  },
  {
    id:     "audio",
    labelKey: "uploadNotes.typeAudio",
    icon:   "musical-notes-outline",
    color:  "#D97706",
    bg:     "#FEF3C7",
    accept: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/mp4"],
    hint:   "MP3, WAV, M4A",
    maxMB:  100,
  },
  {
    id:     "video",
    labelKey: "uploadNotes.typeVideo",
    icon:   "videocam-outline",
    color:  "#DC2626",
    bg:     "#FEE2E2",
    accept: ["video/mp4", "video/quicktime", "video/x-msvideo"],
    hint:   "MP4, MOV, AVI",
    maxMB:  500,
  },
  {
    id:     "document",
    labelKey: "uploadNotes.typeDocument",
    icon:   "attach-outline",
    color:  "#059669",
    bg:     "#ECFDF5",
    accept: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    hint:  "PDF, DOCX, XLSX",
    maxMB: 50,
  },
];

const DEFAULT_TYPE = CONTENT_TYPES[1]; // notes
const STEPS        = ["uploadNotes.stepFile", "uploadNotes.stepReview"];

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const formatBytes = (bytes) => {
  if (!bytes) return "0 B";
  const k     = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const getFileIcon = (mimeType = "") => {
  if (mimeType.includes("pdf"))   return { icon: "document-text", color: "#DC2626" };
  if (mimeType.includes("image")) return { icon: "image",         color: "#059669" };
  if (mimeType.includes("audio")) return { icon: "musical-notes", color: "#D97706" };
  if (mimeType.includes("video")) return { icon: "videocam",      color: "#7C3AED" };
  if (mimeType.includes("word"))  return { icon: "document",      color: "#2563EB" };
  return { icon: "attach", color: "#6B7280" };
};

const safeParseJSON = (str, fallback) => {
  if (!str) return fallback;
  try { return JSON.parse(str); }
  catch { return fallback; }
};

// ─────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────

function StepIndicator({ currentStep }) {
  const { t } = useTranslation();
  return (
    <View style={stepStyles.container}>
      {STEPS.map((stepKey, index) => {
        const done   = index < currentStep;
        const active = index === currentStep;
        return (
          <React.Fragment key={stepKey}>
            <View style={stepStyles.step}>
              <View
                style={[
                  stepStyles.circle,
                  done   && stepStyles.circleDone,
                  active && stepStyles.circleActive,
                ]}
              >
                {done ? (
                  <Ionicons name="checkmark" size={12} color="#FFF" />
                ) : (
                  <Text
                    style={[
                      stepStyles.circleText,
                      active && stepStyles.circleTextActive,
                    ]}
                  >
                    {index + 1}
                  </Text>
                )}
              </View>
              <Text
                style={[
                  stepStyles.label,
                  active && stepStyles.labelActive,
                  done   && stepStyles.labelDone,
                ]}
              >
                {t(stepKey)}
              </Text>
            </View>
            {index < STEPS.length - 1 && (
              <View
                style={[stepStyles.line, done && stepStyles.lineDone]}
              />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

function UploadProgressBar({ progress }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue:         progress,
      duration:        300,
      useNativeDriver: false,
    }).start();
  }, [progress]);
  const width = anim.interpolate({
    inputRange:  [0, 100],
    outputRange: ["0%", "100%"],
  });
  return (
    <View style={progressStyles.container}>
      <View style={progressStyles.track}>
        <Animated.View style={[progressStyles.fill, { width }]} />
      </View>
      <Text style={progressStyles.label}>{progress}%</Text>
    </View>
  );
}

function SectionCard({ title, icon, iconColor, children }) {
  return (
    <View style={sectionStyles.card}>
      <View style={sectionStyles.titleRow}>
        <Ionicons name={icon} size={16} color={iconColor} />
        <Text style={sectionStyles.title}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function ErrorMsg({ msg }) {
  return (
    <View style={errStyles.row}>
      <Ionicons name="alert-circle-outline" size={13} color="#DC2626" />
      <Text style={errStyles.text}>{msg}</Text>
    </View>
  );
}

function ReviewRow({ label, value, icon }) {
  return (
    <View style={reviewStyles.row}>
      <View style={reviewStyles.iconBox}>
        <Ionicons name={icon} size={14} color="#6B7280" />
      </View>
      <Text style={reviewStyles.label}>{label}</Text>
      <Text style={reviewStyles.value} numberOfLines={2}>
        {value || "—"}
      </Text>
    </View>
  );
}

function SuccessDetail({ icon, label, value }) {
  return (
    <View style={successDetailStyles.row}>
      <Ionicons name={icon} size={16} color="#6B7280" />
      <Text style={successDetailStyles.label}>{label}:</Text>
      <Text style={successDetailStyles.value} numberOfLines={1}>
        {value || "—"}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────

function UploadNotesPage() {
  const router = useRouter();
  const { t }  = useTranslation();
  const user   = useAuthStore((s) => s.user);
  const params = useLocalSearchParams();

  const teacherId = user?._id || user?.id || user?.userId || null;

  // ── Parse presets from select-subject ────────────────────
  const rawPresetType = String(params.presetType || "").toLowerCase().trim();
  const currentType   =
    CONTENT_TYPES.find((opt) => opt.id === rawPresetType) || DEFAULT_TYPE;

  const presetSubject = params.presetSubjectId
    ? {
        subjectId:   String(params.presetSubjectId),
        subjectName: String(params.presetSubjectName || ""),
      }
    : null;

  const presetClassIds   = safeParseJSON(params.presetClassIds,   []);
  const presetClassNames = safeParseJSON(params.presetClassNames, []);
  const presetClasses    = presetClassIds.map((id, i) => ({
    classId:   String(id),
    className: String(presetClassNames[i] || id),
  }));

  const hasPresets = !!presetSubject && presetClasses.length > 0;

  // ── Form state ────────────────────────────────────────────
  const [step,        setStep]        = useState(0);
  const [title,       setTitle]       = useState("");
  const [description, setDescription] = useState("");
  const [pickedFile,  setPickedFile]  = useState(null);
  const [uploading,   setUploading]   = useState(false);
  const [progress,    setProgress]    = useState(0);
  const [uploadDone,  setUploadDone]  = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [errors,      setErrors]      = useState({});

  // ── Guard: no presets → back to selector ─────────────────
  useEffect(() => {
    if (!hasPresets) {
      Alert.alert(
        t("uploadNotes.missingSelectionTitle"),
        t("uploadNotes.missingSelectionBody"),
        [{
          text:    t("uploadNotes.ok"),
          onPress: () =>
            router.replace("/teacher/content/select-subject"),
        }]
      );
    }
  }, [hasPresets, router, t]);

  // ── File picker ───────────────────────────────────────────
  const handlePickFile = useCallback(async () => {
    if (!currentType) {
      Alert.alert(
        t("uploadNotes.errorTitle"),
        t("uploadNotes.typeNotSetBody")
      );
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type:                 currentType.accept,
        copyToCacheDirectory: true,
        multiple:             false,
      });

      if (result.canceled) return;

      const file = result.assets?.[0];
      if (!file) return;

      const maxBytes = currentType.maxMB * 1024 * 1024;
      if (file.size && file.size > maxBytes) {
        Alert.alert(
          t("uploadNotes.fileTooLargeTitle"),
          t("uploadNotes.fileTooLargeBody", {
            type: t(currentType.labelKey),
            max:  currentType.maxMB,
            size: formatBytes(file.size),
          })
        );
        return;
      }

      if (file.mimeType && !currentType.accept.includes(file.mimeType)) {
        Alert.alert(
          t("uploadNotes.invalidTypeTitle"),
          t("uploadNotes.invalidTypeBody", {
            type:    t(currentType.labelKey),
            formats: currentType.hint,
          })
        );
        return;
      }

      setPickedFile(file);
      setErrors((e) => ({ ...e, file: undefined }));

      if (!title.trim()) {
        const nameWithoutExt = file.name?.replace(/\.[^/.]+$/, "") || "";
        if (nameWithoutExt) setTitle(nameWithoutExt);
      }
    } catch (err) {
      console.error("File pick error:", err);
      Alert.alert(
        t("uploadNotes.errorTitle"),
        t("uploadNotes.pickerErrorBody")
      );
    }
  }, [currentType, title, t]);

  const handleRemoveFile = useCallback(() => {
    Alert.alert(
      t("uploadNotes.removeFileTitle"),
      t("uploadNotes.removeFileBody"),
      [
        { text: t("uploadNotes.cancel"), style: "cancel" },
        {
          text:    t("uploadNotes.remove"),
          style:   "destructive",
          onPress: () => setPickedFile(null),
        },
      ]
    );
  }, [t]);

  // ── Navigation ────────────────────────────────────────────
  const handleNext = useCallback(() => {
    const newErrors = {};
    if (!pickedFile)
      newErrors.file = t("uploadNotes.errFileRequired");
    if (!title.trim())
      newErrors.title = t("uploadNotes.errTitleRequired");
    else if (title.trim().length < 3)
      newErrors.title = t("uploadNotes.errTitleTooShort");

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    setStep(1);
  }, [pickedFile, title, t]);

  const handleBack = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
    else          router.back();
  }, [step, router]);

  // ── Upload ────────────────────────────────────────────────
  const handleUpload = useCallback(async () => {
    if (!pickedFile || !title.trim() || !teacherId || !presetSubject) return;

    setUploading(true);
    setProgress(0);
    setUploadError(null);

    try {
      await uploadContent({
        file:        pickedFile,
        title:       title.trim(),
        description: description.trim(),
        subjectId:   presetSubject.subjectId,
        classIds:    presetClasses.map((c) => c.classId),
        contentType: currentType.id,
        teacherId,
        onProgress:  (pct) => setProgress(pct),
      });

      setProgress(100);
      setUploadDone(true);
    } catch (err) {
      console.error("Upload failed:", err);
      const msg =
        err?.response?.data?.message ||
        err?.message                 ||
        t("uploadNotes.uploadFailedFallback");
      setUploadError(msg);
      setUploading(false);
    }
  }, [
    pickedFile, title, description, teacherId,
    presetSubject, presetClasses, currentType, t,
  ]);

  const handleUploadAnother = useCallback(() => {
    setStep(0);
    setTitle("");
    setDescription("");
    setPickedFile(null);
    setProgress(0);
    setUploadDone(false);
    setUploadError(null);
    setErrors({});
  }, []);

  // ── Guard render ──────────────────────────────────────────
  if (!hasPresets) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#4F46E5" />
        </View>
      </View>
    );
  }

  // ── Success screen ────────────────────────────────────────
  if (uploadDone) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />
        <ScrollView contentContainerStyle={styles.successScreen}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark-circle" size={72} color="#059669" />
          </View>
          <Text style={styles.successTitle}>
            {t("uploadNotes.successTitle")}
          </Text>
          <Text style={styles.successMsg}>
            {t("uploadNotes.successMsg", {
              count: presetClasses.length,
              title,
            })}
          </Text>

          <View style={styles.successDetails}>
            <SuccessDetail
              icon="book-outline"
              label={t("uploadNotes.labelSubject")}
              value={presetSubject?.subjectName}
            />
            <SuccessDetail
              icon="folder-outline"
              label={t("uploadNotes.labelType")}
              value={currentType ? t(currentType.labelKey) : ""}
            />
            <SuccessDetail
              icon="document-outline"
              label={t("uploadNotes.labelFile")}
              value={pickedFile?.name}
            />
          </View>

          <TouchableOpacity
            style={styles.successPrimaryBtn}
            onPress={handleUploadAnother}
            activeOpacity={0.8}
          >
            <Ionicons name="cloud-upload-outline" size={18} color="#FFF" />
            <Text style={styles.successPrimaryText}>
              {t("uploadNotes.uploadAnother")}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.successSecondaryBtn}
            onPress={() => router.replace("/teacher/content")}
            activeOpacity={0.7}
          >
            <Text style={styles.successSecondaryText}>
              {t("uploadNotes.viewLibrary")}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.successBackBtn}
            onPress={() => router.replace("/teacher/dashboard")}
            activeOpacity={0.7}
          >
            <Text style={styles.successBackText}>
              {t("uploadNotes.backToDashboard")}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // ── Main form ─────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={handleBack}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Text style={styles.headerText}>
            {t("uploadNotes.headerTitle", {
              type: currentType ? t(currentType.labelKey) : "",
            })}
          </Text>
          <Text style={styles.headerSub}>
            {t("uploadNotes.headerSub", {
              step:  step + 1,
              total: STEPS.length,
              name:  t(STEPS[step]),
            })}
          </Text>
        </View>
      </View>

      {/* STEP INDICATOR */}
      <StepIndicator currentStep={step} />

      {/* LOCKED RECAP BAR */}
      <View style={styles.recapBar}>
        <View
          style={[
            styles.recapChip,
            { backgroundColor: currentType?.bg || "#EEF2FF" },
          ]}
        >
          <Ionicons
            name={currentType?.icon || "document-outline"}
            size={12}
            color={currentType?.color || "#4F46E5"}
          />
          <Text
            style={[
              styles.recapChipText,
              { color: currentType?.color || "#4F46E5" },
            ]}
          >
            {currentType ? t(currentType.labelKey) : ""}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={12} color="#D1D5DB" />

        <View style={styles.recapChip}>
          <Ionicons name="book-outline" size={12} color="#4F46E5" />
          <Text
            style={[styles.recapChipText, { color: "#4F46E5" }]}
            numberOfLines={1}
          >
            {presetSubject?.subjectName}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={12} color="#D1D5DB" />

        <View style={[styles.recapChip, { backgroundColor: "#ECFDF5" }]}>
          <Ionicons name="school-outline" size={12} color="#059669" />
          <Text style={[styles.recapChipText, { color: "#059669" }]}>
            {t("uploadNotes.classCount", { count: presetClasses.length })}
          </Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={80}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >

          {/* ══════════ STEP 0 — FILE + DETAILS ══════════ */}
          {step === 0 && (
            <View>
              <SectionCard
                title={t("uploadNotes.selectFile")}
                icon={currentType?.icon || "attach-outline"}
                iconColor={currentType?.color || "#4F46E5"}
              >
                <View style={styles.fileInfoRow}>
                  <View
                    style={[
                      styles.fileInfoBadge,
                      { backgroundColor: currentType?.bg || "#EEF2FF" },
                    ]}
                  >
                    <Ionicons
                      name={currentType?.icon || "attach-outline"}
                      size={14}
                      color={currentType?.color || "#4F46E5"}
                    />
                    <Text
                      style={[
                        styles.fileInfoText,
                        { color: currentType?.color || "#4F46E5" },
                      ]}
                    >
                      {currentType?.hint}
                    </Text>
                  </View>
                  <Text style={styles.fileMaxSize}>
                    {t("uploadNotes.maxSize", { max: currentType?.maxMB })}
                  </Text>
                </View>

                {pickedFile ? (
                  <View style={styles.filePreview}>
                    <View style={styles.filePreviewIcon}>
                      <Ionicons
                        name={getFileIcon(pickedFile.mimeType || "").icon}
                        size={28}
                        color={getFileIcon(pickedFile.mimeType || "").color}
                      />
                    </View>
                    <View style={styles.filePreviewInfo}>
                      <Text style={styles.filePreviewName} numberOfLines={2}>
                        {pickedFile.name}
                      </Text>
                      <Text style={styles.filePreviewSize}>
                        {formatBytes(pickedFile.size)}
                      </Text>
                    </View>
                    <View style={styles.filePreviewActions}>
                      <TouchableOpacity
                        style={styles.fileChangeBtn}
                        onPress={handlePickFile}
                        activeOpacity={0.7}
                      >
                        <Ionicons name="refresh" size={14} color="#4F46E5" />
                        <Text style={styles.fileChangeBtnText}>
                          {t("uploadNotes.change")}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.fileRemoveBtn}
                        onPress={handleRemoveFile}
                        activeOpacity={0.7}
                      >
                        <Ionicons
                          name="trash-outline"
                          size={14}
                          color="#DC2626"
                        />
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[
                      styles.dropZone,
                      errors.file && styles.dropZoneError,
                    ]}
                    onPress={handlePickFile}
                    activeOpacity={0.8}
                  >
                    <View
                      style={[
                        styles.dropZoneIcon,
                        { backgroundColor: currentType?.bg || "#EEF2FF" },
                      ]}
                    >
                      <Ionicons
                        name="cloud-upload-outline"
                        size={32}
                        color={currentType?.color || "#4F46E5"}
                      />
                    </View>
                    <Text style={styles.dropZoneTitle}>
                      {t("uploadNotes.tapToSelect")}
                    </Text>
                    <Text style={styles.dropZoneSub}>
                      {t("uploadNotes.dropZoneSub", {
                        formats: currentType?.hint,
                        max:     currentType?.maxMB,
                      })}
                    </Text>
                  </TouchableOpacity>
                )}

                {errors.file && <ErrorMsg msg={errors.file} />}
              </SectionCard>

              {/* Title */}
              <SectionCard
                title={t("uploadNotes.titleFieldLabel")}
                icon="pencil-outline"
                iconColor="#4F46E5"
              >
                <TextInput
                  style={[styles.input, errors.title && styles.inputError]}
                  placeholder={t("uploadNotes.titlePlaceholder", {
                    type: currentType ? t(currentType.labelKey) : "",
                  })}
                  placeholderTextColor="#9CA3AF"
                  value={title}
                  onChangeText={(value) => {
                    setTitle(value);
                    if (errors.title)
                      setErrors((e) => ({ ...e, title: undefined }));
                  }}
                  maxLength={120}
                  returnKeyType="next"
                />
                {errors.title && <ErrorMsg msg={errors.title} />}
                <Text style={styles.charCount}>{title.length}/120</Text>
              </SectionCard>

              {/* Description */}
              <SectionCard
                title={t("uploadNotes.descriptionFieldLabel")}
                icon="text-outline"
                iconColor="#6B7280"
              >
                <TextInput
                  style={[styles.input, styles.textArea]}
                  placeholder={t("uploadNotes.descriptionPlaceholder")}
                  placeholderTextColor="#9CA3AF"
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  numberOfLines={4}
                  maxLength={500}
                  textAlignVertical="top"
                />
                <Text style={styles.charCount}>{description.length}/500</Text>
              </SectionCard>

              {/* Tips */}
              <View style={styles.tipsCard}>
                <Text style={styles.tipsTitle}>
                  {t("uploadNotes.tipsTitle")}
                </Text>
                {[
                  "uploadNotes.tip1",
                  "uploadNotes.tip2",
                  "uploadNotes.tip3",
                ].map((tipKey) => (
                  <View key={tipKey} style={styles.tipRow}>
                    <View style={styles.tipDot} />
                    <Text style={styles.tipText}>{t(tipKey)}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* ══════════ STEP 1 — REVIEW ══════════ */}
          {step === 1 && (
            <View>
              {!uploading && !uploadError && (
                <SectionCard
                  title={t("uploadNotes.reviewConfirm")}
                  icon="eye-outline"
                  iconColor="#4F46E5"
                >
                  <ReviewRow
                    label={t("uploadNotes.labelType")}
                    value={currentType ? t(currentType.labelKey) : ""}
                    icon="layers-outline"
                  />
                  <ReviewRow
                    label={t("uploadNotes.labelTitle")}
                    value={title}
                    icon="pencil-outline"
                  />
                  {description ? (
                    <ReviewRow
                      label={t("uploadNotes.labelDescription")}
                      value={description}
                      icon="text-outline"
                    />
                  ) : null}
                  <ReviewRow
                    label={t("uploadNotes.labelSubject")}
                    value={presetSubject?.subjectName}
                    icon="book-outline"
                  />
                  <ReviewRow
                    label={t("uploadNotes.labelClasses")}
                    value={presetClasses.map((c) => c.className).join(", ")}
                    icon="school-outline"
                  />
                  <ReviewRow
                    label={t("uploadNotes.labelFile")}
                    value={`${pickedFile?.name} (${formatBytes(pickedFile?.size)})`}
                    icon="document-outline"
                  />
                </SectionCard>
              )}

              {uploading && (
                <View style={styles.uploadingCard}>
                  <Ionicons
                    name="cloud-upload-outline"
                    size={40}
                    color="#4F46E5"
                  />
                  <Text style={styles.uploadingTitle}>
                    {t("uploadNotes.uploading")}
                  </Text>
                  <Text style={styles.uploadingFile} numberOfLines={1}>
                    {pickedFile?.name}
                  </Text>
                  <UploadProgressBar progress={progress} />
                  <Text style={styles.uploadingHint}>
                    {t("uploadNotes.uploadingHint")}
                  </Text>
                </View>
              )}

              {uploadError && !uploading && (
                <View style={styles.errorCard}>
                  <Ionicons name="alert-circle" size={36} color="#DC2626" />
                  <Text style={styles.errorTitle}>
                    {t("uploadNotes.uploadFailedTitle")}
                  </Text>
                  <Text style={styles.errorMsg}>{uploadError}</Text>
                  <TouchableOpacity
                    style={styles.retryBtn}
                    onPress={handleUpload}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="refresh" size={16} color="#FFF" />
                    <Text style={styles.retryBtnText}>
                      {t("uploadNotes.tryAgain")}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* NAV BUTTONS */}
          <View style={styles.navRow}>
            {!uploading && (
              <TouchableOpacity
                style={styles.navBackBtn}
                onPress={handleBack}
                activeOpacity={0.7}
              >
                <Ionicons name="arrow-back" size={18} color="#4F46E5" />
                <Text style={styles.navBackText}>
                  {t("uploadNotes.back")}
                </Text>
              </TouchableOpacity>
            )}

            {step === 0 && (
              <TouchableOpacity
                style={styles.navNextBtn}
                onPress={handleNext}
                activeOpacity={0.8}
              >
                <Text style={styles.navNextText}>
                  {t("uploadNotes.review")}
                </Text>
                <Ionicons name="arrow-forward" size={18} color="#FFF" />
              </TouchableOpacity>
            )}

            {step === 1 && !uploading && !uploadError && (
              <TouchableOpacity
                style={styles.uploadBtn}
                onPress={handleUpload}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="cloud-upload-outline"
                  size={20}
                  color="#FFF"
                />
                <Text style={styles.uploadBtnText}>
                  {t("uploadNotes.uploadNow")}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

export default UploadNotesPage;

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: "#F3F4F6" },
  centered:      { flex: 1, alignItems: "center", justifyContent: "center" },
  scrollContent: { paddingHorizontal: 16, paddingTop: 8 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               12,
  },
  backBtn: {
    width:           38,
    height:          38,
    borderRadius:    19,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerTitle: { flex: 1 },
  headerText:  { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:   { fontSize: 12, color: "#6B7280", marginTop: 1 },

  recapBar: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               6,
    flexWrap:          "wrap",
  },
  recapChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 8,
    paddingVertical:   4,
    borderRadius:      16,
    backgroundColor:   "#EEF2FF",
    flexShrink:        1,
  },
  recapChipText: { fontSize: 11, fontWeight: "600" },

  input: {
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          14,
    color:             "#111827",
    backgroundColor:   "#FAFAFA",
  },
  inputError: { borderColor: "#DC2626" },
  textArea:   { height: 100, paddingTop: 12 },
  charCount:  { fontSize: 11, color: "#9CA3AF", textAlign: "right", marginTop: 4 },

  fileInfoRow: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   12,
  },
  fileInfoBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      20,
  },
  fileInfoText: { fontSize: 12, fontWeight: "600" },
  fileMaxSize:  { fontSize: 12, color: "#9CA3AF" },

  dropZone: {
    borderWidth:     2,
    borderColor:     "#E5E7EB",
    borderStyle:     "dashed",
    borderRadius:    14,
    paddingVertical: 36,
    alignItems:      "center",
    gap:             10,
    backgroundColor: "#FAFAFA",
  },
  dropZoneError: { borderColor: "#DC2626" },
  dropZoneIcon: {
    width:          64,
    height:         64,
    borderRadius:   16,
    alignItems:     "center",
    justifyContent: "center",
  },
  dropZoneTitle: { fontSize: 15, fontWeight: "600", color: "#374151" },
  dropZoneSub:   { fontSize: 12, color: "#9CA3AF" },

  filePreview: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#F8FAFC",
    borderRadius:    12,
    padding:         14,
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    gap:             12,
  },
  filePreviewIcon: {
    width:           52,
    height:          52,
    borderRadius:    12,
    backgroundColor: "#FFF",
    alignItems:      "center",
    justifyContent:  "center",
    borderWidth:     1,
    borderColor:     "#E5E7EB",
  },
  filePreviewInfo:    { flex: 1 },
  filePreviewName:    { fontSize: 13, fontWeight: "600", color: "#111827" },
  filePreviewSize:    { fontSize: 11, color: "#9CA3AF", marginTop: 3 },
  filePreviewActions: { gap: 6, alignItems: "center" },
  fileChangeBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    paddingHorizontal: 8,
    paddingVertical:   4,
    borderRadius:      6,
    backgroundColor:   "#EEF2FF",
  },
  fileChangeBtnText: { fontSize: 11, color: "#4F46E5", fontWeight: "600" },
  fileRemoveBtn: {
    width:           28,
    height:          28,
    borderRadius:    8,
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#FEE2E2",
  },

  tipsCard: {
    backgroundColor: "#FFFBEB",
    borderRadius:    12,
    padding:         14,
    marginTop:       4,
    borderWidth:     1,
    borderColor:     "#FDE68A",
  },
  tipsTitle: { fontSize: 13, fontWeight: "700", color: "#92400E", marginBottom: 10 },
  tipRow:    { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 6 },
  tipDot: {
    width:           5,
    height:          5,
    borderRadius:    3,
    backgroundColor: "#D97706",
    marginTop:       5,
  },
  tipText: { fontSize: 12, color: "#78350F", flex: 1, lineHeight: 18 },

  uploadingCard: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         28,
    alignItems:      "center",
    gap:             12,
    shadowColor:     "#000",
    shadowOpacity:   0.06,
    shadowRadius:    8,
    elevation:       3,
  },
  uploadingTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  uploadingFile:  { fontSize: 12, color: "#6B7280", maxWidth: "80%" },
  uploadingHint:  { fontSize: 11, color: "#9CA3AF", marginTop: 4 },

  errorCard: {
    backgroundColor: "#FEF2F2",
    borderRadius:    16,
    padding:         24,
    alignItems:      "center",
    gap:             10,
    borderWidth:     1,
    borderColor:     "#FECACA",
  },
  errorTitle: { fontSize: 16, fontWeight: "700", color: "#DC2626" },
  errorMsg:   { fontSize: 13, color: "#991B1B", textAlign: "center" },
  retryBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   "#DC2626",
    paddingHorizontal: 20,
    paddingVertical:   10,
    borderRadius:      10,
    marginTop:         6,
  },
  retryBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  navRow: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginTop:      20,
    gap:            12,
  },
  navBackBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 18,
    paddingVertical:   12,
    borderRadius:      12,
    borderWidth:       1.5,
    borderColor:       "#4F46E5",
  },
  navBackText: { color: "#4F46E5", fontWeight: "600", fontSize: 14 },
  navNextBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
    backgroundColor: "#4F46E5",
    paddingVertical: 14,
    borderRadius:    12,
  },
  navNextText: { color: "#FFF", fontWeight: "700", fontSize: 15 },
  uploadBtn: {
    flex:            1,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: "#059669",
    paddingVertical: 16,
    borderRadius:    12,
  },
  uploadBtnText: { color: "#FFF", fontWeight: "700", fontSize: 16 },

  successScreen: {
    flexGrow:          1,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: 28,
    paddingVertical:   40,
    backgroundColor:   "#F3F4F6",
  },
  successIcon:  { marginBottom: 16 },
  successTitle: { fontSize: 26, fontWeight: "800", color: "#111827", marginBottom: 8 },
  successMsg: {
    fontSize:     14,
    color:        "#6B7280",
    textAlign:    "center",
    lineHeight:   22,
    marginBottom: 24,
  },
  successDetails: {
    width:           "100%",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         16,
    gap:             12,
    marginBottom:    24,
  },
  successPrimaryBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               8,
    backgroundColor:   "#4F46E5",
    paddingVertical:   14,
    paddingHorizontal: 28,
    borderRadius:      12,
    width:             "100%",
    marginBottom:      10,
  },
  successPrimaryText:   { color: "#FFF", fontWeight: "700", fontSize: 15 },
  successSecondaryBtn:  { paddingVertical: 12, marginBottom: 6 },
  successSecondaryText: { color: "#4F46E5", fontWeight: "600", fontSize: 14 },
  successBackBtn:       { paddingVertical: 8 },
  successBackText:      { color: "#9CA3AF", fontSize: 13 },
});

const stepStyles = StyleSheet.create({
  container: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 24,
    paddingVertical:   14,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  step:   { alignItems: "center", gap: 4 },
  circle: {
    width:           24,
    height:          24,
    borderRadius:    12,
    backgroundColor: "#E5E7EB",
    alignItems:      "center",
    justifyContent:  "center",
  },
  circleDone:       { backgroundColor: "#059669" },
  circleActive:     { backgroundColor: "#4F46E5" },
  circleText:       { fontSize: 11, fontWeight: "700", color: "#9CA3AF" },
  circleTextActive: { color: "#FFF" },
  label:            { fontSize: 10, color: "#9CA3AF", fontWeight: "500" },
  labelActive:      { color: "#4F46E5", fontWeight: "700" },
  labelDone:        { color: "#059669" },
  line: {
    flex:             1,
    height:           2,
    backgroundColor:  "#E5E7EB",
    marginHorizontal: 4,
    marginBottom:     14,
  },
  lineDone: { backgroundColor: "#059669" },
});

const progressStyles = StyleSheet.create({
  container: { width: "100%", alignItems: "center", gap: 6 },
  track: {
    width:           "100%",
    height:          8,
    backgroundColor: "#E5E7EB",
    borderRadius:    4,
    overflow:        "hidden",
  },
  fill:  { height: "100%", backgroundColor: "#4F46E5", borderRadius: 4 },
  label: { fontSize: 13, fontWeight: "700", color: "#4F46E5" },
});

const sectionStyles = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
    marginBottom:  12,
  },
  title: { fontSize: 14, fontWeight: "700", color: "#374151" },
});

const errStyles = StyleSheet.create({
  row:  { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  text: { fontSize: 12, color: "#DC2626", flex: 1 },
});

const reviewStyles = StyleSheet.create({
  row: {
    flexDirection:     "row",
    alignItems:        "flex-start",
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               8,
  },
  iconBox: { width: 22, marginTop: 1 },
  label:   { width: 90, fontSize: 13, color: "#6B7280", fontWeight: "500" },
  value:   { flex: 1, fontSize: 13, color: "#111827", fontWeight: "600" },
});

const successDetailStyles = StyleSheet.create({
  row:   { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontSize: 13, color: "#6B7280", width: 70 },
  value: { flex: 1, fontSize: 13, fontWeight: "600", color: "#111827" },
});