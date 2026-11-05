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
  Animated,
  KeyboardAvoidingView,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useAuthStore }    from "../../../src/store/auth.store";
import { uploadContent }   from "../../../src/services/content.service";
import { useTranslation }  from "../../../src/i18n/useTranslation";
import { errorText } from "../../../src/utils/appError";
import { COLORS, ACCENT, SEMANTIC } from "../../../src/theme/colors";
import { HeaderIcon, IconSquare } from "../../../src/components/Tinted";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const CONTENT_TYPES = [
  {
    id:     "syllabus",
    labelKey: "uploadNotes.typeSyllabus",
    icon:   "list-outline",
    color:  ACCENT.violet.solid,
    bg:     ACCENT.violet.wash,
    accent: "violet",
    accept: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    hint:  "PDF, DOC",
    maxMB: 20,
  },
  {
    id:     "notes",
    labelKey: "uploadNotes.typeNotes",
    icon:   "document-text-outline",
    color:  ACCENT.indigo.solid,
    bg:     ACCENT.indigo.wash,
    accent: "indigo",
    accept: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    hint:  "PDF, DOC, DOCX",
    maxMB: 20,
  },
  {
    id:     "image",
    labelKey: "uploadNotes.typeImage",
    icon:   "image-outline",
    color:  ACCENT.green.solid,
    bg:     ACCENT.green.wash,
    accent: "green",
    accept: ["image/jpeg", "image/png", "image/jpg", "image/webp"],
    hint:   "JPG, PNG, WEBP",
    maxMB:  20,
  },
  {
    id:     "audio",
    labelKey: "uploadNotes.typeAudio",
    icon:   "musical-notes-outline",
    color:  ACCENT.amber.solid,
    bg:     ACCENT.amber.wash,
    accent: "amber",
    accept: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/mp4"],
    hint:   "MP3, WAV, M4A",
    maxMB:  20,
  },
  {
    id:     "video",
    labelKey: "uploadNotes.typeVideo",
    icon:   "videocam-outline",
    color:  ACCENT.red.solid,
    bg:     ACCENT.red.wash,
    accent: "red",
    accept: ["video/mp4", "video/quicktime", "video/x-msvideo"],
    hint:   "MP4, MOV, AVI",
    maxMB:  20,
  },
  {
    id:     "document",
    labelKey: "uploadNotes.typeDocument",
    icon:   "attach-outline",
    color:  ACCENT.green.solid,
    bg:     ACCENT.green.wash,
    accent: "green",
    accept: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    hint:  "PDF, DOCX, XLSX",
    maxMB: 20,
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
  if (mimeType.includes("pdf"))   return { icon: "document-text", color: ACCENT.red.solid };
  if (mimeType.includes("image")) return { icon: "image",         color: ACCENT.green.solid };
  if (mimeType.includes("audio")) return { icon: "musical-notes", color: ACCENT.amber.solid };
  if (mimeType.includes("video")) return { icon: "videocam",      color: ACCENT.violet.solid };
  if (mimeType.includes("word"))  return { icon: "document",      color: ACCENT.blue.solid };
  return { icon: "attach", color: ACCENT.indigo.solid };
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

function SectionCard({ title, icon, accent, children }) {
  return (
    <View style={sectionStyles.card}>
      <View style={sectionStyles.titleRow}>
        <IconSquare icon={icon} accent={accent} size={28} />
        <Text style={sectionStyles.title}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function ErrorMsg({ msg }) {
  return (
    <View style={errStyles.row}>
      <Ionicons name="alert-circle-outline" size={13} color={SEMANTIC.error.icon} />
      <Text style={errStyles.text}>{msg}</Text>
    </View>
  );
}

function ReviewRow({ label, value, icon }) {
  return (
    <View style={reviewStyles.row}>
      <View style={reviewStyles.iconBox}>
        <Ionicons name={icon} size={14} color={ACCENT.indigo.solid} />
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
      <Ionicons name={icon} size={16} color={ACCENT.green.solid} />
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
        errorText(t, err, "uploadNotes.uploadFailedFallback");
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
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />
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
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />
        <ScrollView contentContainerStyle={styles.successScreen}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark-circle" size={72} color={ACCENT.green.solid} />
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
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.page} />

      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={handleBack}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <HeaderIcon style={styles.headerIcon} />
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
            { backgroundColor: ACCENT[currentType?.accent || "indigo"].wash, borderColor: ACCENT[currentType?.accent || "indigo"].base + "4D" },
          ]}
        >
          <Ionicons
            name={currentType?.icon || "document-outline"}
            size={12}
            color={ACCENT[currentType?.accent || "indigo"].deep}
          />
          <Text
            style={[
              styles.recapChipText,
              { color: ACCENT[currentType?.accent || "indigo"].deep },
            ]}
          >
            {currentType ? t(currentType.labelKey) : ""}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={12} color={COLORS.textSecondary} />

        <View style={[styles.recapChip, { backgroundColor: ACCENT.slate.wash, borderColor: ACCENT.slate.base + "4D" }]}>
          <Ionicons name="book-outline" size={12} color={ACCENT.slate.deep} />
          <Text
            style={[styles.recapChipText, { color: ACCENT.slate.deep }]}
            numberOfLines={1}
          >
            {presetSubject?.subjectName}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={12} color={COLORS.textSecondary} />

        <View style={styles.recapChip}>
          <Ionicons name="school-outline" size={12} color={ACCENT.indigo.deep} />
          <Text style={[styles.recapChipText, { color: ACCENT.indigo.deep }]}>
            {t("uploadNotes.classCount", { count: presetClasses.length })}
          </Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
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
                accent={currentType?.accent || "indigo"}
              >
                <View style={styles.fileInfoRow}>
                  <View
                    style={[
                      styles.fileInfoBadge,
                      { backgroundColor: ACCENT[currentType?.accent || "indigo"].wash, borderColor: ACCENT[currentType?.accent || "indigo"].base + "4D" },
                    ]}
                  >
                    <Ionicons
                      name={currentType?.icon || "attach-outline"}
                      size={14}
                      color={ACCENT[currentType?.accent || "indigo"].deep}
                    />
                    <Text
                      style={[
                        styles.fileInfoText,
                        { color: ACCENT[currentType?.accent || "indigo"].deep },
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
                        <Ionicons name="refresh" size={14} color={ACCENT.indigo.deep} />
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
                          color={SEMANTIC.error.icon}
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
                        { backgroundColor: ACCENT[currentType?.accent || "indigo"].solid },
                      ]}
                    >
                      <Ionicons
                        name="cloud-upload-outline"
                        size={32}
                        color={COLORS.onPrimary}
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
                accent="indigo"
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
                accent="slate"
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
                  accent="indigo"
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
                  <IconSquare
                    icon="cloud-upload-outline"
                    accent="indigo"
                    size={56}
                    radius={16}
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
                  <Ionicons name="alert-circle" size={36} color={SEMANTIC.error.icon} />
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
                <Ionicons name="arrow-back" size={18} color={ACCENT.indigo.solid} />
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
  container:     { flex: 1, backgroundColor: COLORS.page },
  centered:      { flex: 1, alignItems: "center", justifyContent: "center" },
  scrollContent: { paddingHorizontal: 16, paddingTop: 8 },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
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
  headerIcon:  { marginRight: 0 },
  headerTitle: { flex: 1 },
  headerText:  { fontSize: 18, fontWeight: "700", color: COLORS.text },
  headerSub:   { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },

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
    borderWidth:       1,
    borderColor:       ACCENT.indigo.base + "4D",
    backgroundColor:   ACCENT.indigo.wash,
    flexShrink:        1,
  },
  recapChipText: { fontSize: 11, fontWeight: "600" },

  input: {
    borderWidth:       1,
    borderColor:       COLORS.border,
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          14,
    color:             COLORS.text,
    backgroundColor:   COLORS.surface,
  },
  inputError: { borderColor: SEMANTIC.error.icon },
  textArea:   { height: 100, paddingTop: 12 },
  charCount:  { fontSize: 11, color: COLORS.textSecondary, textAlign: "right", marginTop: 4 },

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
    borderWidth:       1,
  },
  fileInfoText: { fontSize: 12, fontWeight: "600" },
  fileMaxSize:  { fontSize: 12, color: COLORS.textSecondary },

  dropZone: {
    borderWidth:     2,
    borderColor:     ACCENT.indigo.base + "4D",
    borderStyle:     "dashed",
    borderRadius:    14,
    paddingVertical: 36,
    alignItems:      "center",
    gap:             10,
    backgroundColor: ACCENT.indigo.wash,
  },
  dropZoneError: { borderColor: SEMANTIC.error.icon },
  dropZoneIcon: {
    width:          64,
    height:         64,
    borderRadius:   16,
    alignItems:     "center",
    justifyContent: "center",
  },
  dropZoneTitle: { fontSize: 15, fontWeight: "600", color: COLORS.text },
  dropZoneSub:   { fontSize: 12, color: COLORS.textSecondary },

  filePreview: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: ACCENT.indigo.wash,
    borderRadius:    12,
    padding:         14,
    borderWidth:     1,
    borderColor:     COLORS.border,
    gap:             12,
  },
  filePreviewIcon: {
    width:           52,
    height:          52,
    borderRadius:    12,
    backgroundColor: COLORS.surface,
    alignItems:      "center",
    justifyContent:  "center",
    borderWidth:     1,
    borderColor:     COLORS.border,
  },
  filePreviewInfo:    { flex: 1 },
  filePreviewName:    { fontSize: 13, fontWeight: "600", color: COLORS.text },
  filePreviewSize:    { fontSize: 11, color: COLORS.textSecondary, marginTop: 3 },
  filePreviewActions: { gap: 6, alignItems: "center" },
  fileChangeBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    paddingHorizontal: 8,
    paddingVertical:   4,
    borderRadius:      6,
    backgroundColor:   COLORS.surface,
  },
  fileChangeBtnText: { fontSize: 11, color: ACCENT.indigo.deep, fontWeight: "600" },
  fileRemoveBtn: {
    width:           28,
    height:          28,
    borderRadius:    8,
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: SEMANTIC.error.box,
  },

  tipsCard: {
    backgroundColor: SEMANTIC.warning.bg,
    borderRadius:    12,
    padding:         14,
    marginTop:       4,
    borderWidth:     1,
    borderColor:     SEMANTIC.warning.box,
  },
  tipsTitle: { fontSize: 13, fontWeight: "700", color: SEMANTIC.warning.text, marginBottom: 10 },
  tipRow:    { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 6 },
  tipDot: {
    width:           5,
    height:          5,
    borderRadius:    3,
    backgroundColor: SEMANTIC.warning.icon,
    marginTop:       5,
  },
  tipText: { fontSize: 12, color: SEMANTIC.warning.text, flex: 1, lineHeight: 18 },

  uploadingCard: {
    backgroundColor: ACCENT.indigo.wash,
    borderWidth:     1,
    borderColor:     COLORS.border,
    borderTopWidth:  3,
    borderTopColor:  ACCENT.indigo.base,
    borderRadius:    16,
    padding:         28,
    alignItems:      "center",
    gap:             12,
    shadowColor:     "#000",
    shadowOpacity:   0.06,
    shadowRadius:    8,
    elevation:       3,
  },
  uploadingTitle: { fontSize: 18, fontWeight: "700", color: COLORS.text },
  uploadingFile:  { fontSize: 12, color: COLORS.textSecondary, maxWidth: "80%" },
  uploadingHint:  { fontSize: 11, color: COLORS.textSecondary, marginTop: 4 },

  errorCard: {
    backgroundColor: SEMANTIC.error.bg,
    borderRadius:    16,
    padding:         24,
    alignItems:      "center",
    gap:             10,
    borderWidth:     1,
    borderColor:     SEMANTIC.error.box,
  },
  errorTitle: { fontSize: 16, fontWeight: "700", color: SEMANTIC.error.text },
  errorMsg:   { fontSize: 13, color: SEMANTIC.error.text, textAlign: "center" },
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
    backgroundColor:   COLORS.page,
  },
  successIcon:  { marginBottom: 16 },
  successTitle: { fontSize: 26, fontWeight: "800", color: COLORS.text, marginBottom: 8 },
  successMsg: {
    fontSize:     14,
    color:        COLORS.textSecondary,
    textAlign:    "center",
    lineHeight:   22,
    marginBottom: 24,
  },
  successDetails: {
    width:           "100%",
    backgroundColor: SEMANTIC.success.bg,
    borderWidth:     1,
    borderColor:     COLORS.border,
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
  successBackText:      { color: COLORS.textSecondary, fontSize: 13 },
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
  circleActive:     { backgroundColor: ACCENT.indigo.solid },
  circleText:       { fontSize: 11, fontWeight: "700", color: COLORS.textSecondary },
  circleTextActive: { color: COLORS.onPrimary },
  label:            { fontSize: 10, color: COLORS.textSecondary, fontWeight: "500" },
  labelActive:      { color: ACCENT.indigo.deep, fontWeight: "700" },
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
    backgroundColor: COLORS.surface,
    borderWidth:     1,
    borderColor:     ACCENT.indigo.base + "4D",
    borderRadius:    4,
    overflow:        "hidden",
  },
  fill:  { height: "100%", backgroundColor: ACCENT.indigo.solid, borderRadius: 4 },
  label: { fontSize: 13, fontWeight: "700", color: ACCENT.indigo.deep },
});

const sectionStyles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     COLORS.border,
    shadowColor:     COLORS.shadow,
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginBottom:  12,
  },
  title: { fontSize: 14, fontWeight: "700", color: COLORS.text },
});

const errStyles = StyleSheet.create({
  row:  { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  text: { fontSize: 12, color: SEMANTIC.error.text, flex: 1 },
});

const reviewStyles = StyleSheet.create({
  row: {
    flexDirection:     "row",
    alignItems:        "flex-start",
    paddingVertical:   10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap:               8,
  },
  iconBox: { width: 22, marginTop: 1 },
  label:   { width: 90, fontSize: 13, color: COLORS.textSecondary, fontWeight: "500" },
  value:   { flex: 1, fontSize: 13, color: COLORS.text, fontWeight: "600" },
});

const successDetailStyles = StyleSheet.create({
  row:   { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontSize: 13, color: COLORS.textSecondary, width: 70 },
  value: { flex: 1, fontSize: 13, fontWeight: "600", color: COLORS.text },
});