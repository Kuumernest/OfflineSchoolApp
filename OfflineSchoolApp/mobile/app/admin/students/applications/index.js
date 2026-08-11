// app/admin/students/applications/index.js

import React, {
  useCallback,
  useState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  Linking,
  Alert,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter }  from "expo-router";
import { Ionicons }   from "@expo/vector-icons";
import { StudentApplicationsService } from "../../../../src/services/studentApplications.service";
import { ClassService }               from "../../../../src/services/class.service";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const STALE_DAYS = 3;
const STALE_MS   = STALE_DAYS * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const isStaleApplication = (created_at) => {
  if (!created_at) return false;
  const t = new Date(created_at).getTime();
  return !Number.isNaN(t) && t < Date.now() - STALE_MS;
};

const formatDate = (value) => {
  if (!value) return "Unknown date";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "Unknown date"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const normalizeApplication = (raw) => {
  if (!raw) return null;
  const id = String(raw._id || raw.id || "");

  const name =
    raw.studentName  ||
    raw.student_name ||
    raw.name         ||
    [raw.firstName, raw.lastName].filter(Boolean).join(" ").trim() ||
    "Unknown Student";

  const email =
    (raw.email || raw.studentEmail || raw.parentEmail || "").trim().toLowerCase();

  const phone =
    raw.phone || raw.phoneNumber || raw.phone_number ||
    raw.parentPhone || raw.guardianPhone || "";

  const guardianName =
    raw.guardianName  || raw.guardian_name ||
    raw.parentName    || raw.parent_name   || raw.guardian || "";

  const className =
    raw.className  || raw.class_name || raw.grade ||
    (raw.class && typeof raw.class === "object" ? raw.class.name : null) || "";

  const classId =
    raw.classId  || raw.class_id ||
    (raw.class && typeof raw.class === "object"
      ? String(raw.class._id || raw.class.id)
      : null) || null;

  const enrollmentNo =
    raw.enrollmentNo    || raw.enrollment_no   ||
    raw.admissionNo     || raw.admissionNumber || null;

  const created_at = raw.createdAt || raw.created_at || null;
  const updated_at = raw.updatedAt || raw.updated_at || null;

  return {
    id, name, email, phone, guardianName, className, classId,
    enrollmentNo,
    status:    raw.status    || "pending",
    address:   raw.address   || raw.homeAddress || "",
    notes:     raw.notes     || "",
    schoolId:  raw.schoolId  || null,
    documents: Array.isArray(raw.documents) ? raw.documents : [],
    created_at,
    updated_at,
  };
};

const safeResultField = (result, key) => {
  if (!result || typeof result !== "object") return null;
  const val = result[key];
  return val !== undefined && val !== null ? val : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const SummaryCard = React.memo(({ bg, icon, iconColor, value, label }) => (
  <View style={[styles.summaryCard, { backgroundColor: bg }]}>
    <Ionicons name={icon} size={20} color={iconColor} />
    <Text style={styles.summaryNumber}>{value}</Text>
    <Text style={styles.summaryLabel}>{label}</Text>
  </View>
));

const ApplicationCard = React.memo(({ application, onReview }) => {
  const stale    = isStaleApplication(application.created_at);
  const docCount = application.documents?.length ?? 0;

  return (
    <View style={[styles.applicationCard, stale && styles.applicationCardStale]}>
      <View style={styles.applicationTop}>
        <View style={[styles.avatarBox, { backgroundColor: stale ? "#FEE2E2" : "#FEF3C7" }]}>
          <Ionicons name="person-outline" size={22} color={stale ? "#DC2626" : "#D97706"} />
        </View>
        <View style={styles.applicationInfo}>
          <Text style={styles.studentName} numberOfLines={1}>{application.name}</Text>
          <Text style={styles.studentEmail} numberOfLines={1}>
            {application.email || "No email provided"}
          </Text>
        </View>
        <View style={[styles.statusBadge, stale ? styles.staleBadge : styles.pendingBadge]}>
          <Text style={[styles.statusBadgeText, stale ? styles.staleBadgeText : styles.pendingBadgeText]}>
            {stale ? "Stale" : "Pending"}
          </Text>
        </View>
      </View>

      <View style={styles.metaGrid}>
        <View style={styles.metaItem}>
          <Ionicons name="school-outline" size={14} color="#4F46E5" />
          <Text style={styles.metaText} numberOfLines={1}>
            {application.className || application.grade || "No class selected"}
          </Text>
        </View>
        <View style={styles.metaItem}>
          <Ionicons name="people-outline" size={14} color="#6B7280" />
          <Text style={styles.metaText} numberOfLines={1}>
            {application.guardianName || "No guardian provided"}
          </Text>
        </View>
        <View style={styles.metaItem}>
          <Ionicons name="calendar-outline" size={14} color="#6B7280" />
          <Text style={styles.metaText}>{formatDate(application.created_at)}</Text>
        </View>
        {application.phone ? (
          <View style={styles.metaItem}>
            <Ionicons name="call-outline" size={14} color="#059669" />
            <Text style={styles.metaText} numberOfLines={1}>{application.phone}</Text>
          </View>
        ) : null}
        <View style={styles.metaItem}>
          <Ionicons name="document-attach-outline" size={14} color="#059669" />
          <Text style={styles.metaText}>
            {docCount} {docCount === 1 ? "document" : "documents"}
          </Text>
        </View>
      </View>

      <TouchableOpacity style={styles.reviewButton} onPress={() => onReview(application)} activeOpacity={0.7}>
        <Ionicons name="eye-outline" size={18} color="#FFFFFF" />
        <Text style={styles.reviewButtonText}>Review Application</Text>
      </TouchableOpacity>
    </View>
  );
});

const DetailRow = React.memo(({ icon, iconColor, label, value }) => (
  <View style={styles.detailRow}>
    <Ionicons name={icon} size={18} color={iconColor} />
    <View style={styles.detailTextBox}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value || "Not provided"}</Text>
    </View>
  </View>
));

const DocumentCard = React.memo(({ doc, index, onOpen }) => (
  <TouchableOpacity style={styles.documentCard} onPress={() => onOpen(doc)} activeOpacity={0.7}>
    <View style={styles.documentIcon}>
      <Ionicons name="document-attach-outline" size={18} color="#059669" />
    </View>
    <View style={{ flex: 1 }}>
      <Text style={styles.documentTitle} numberOfLines={1}>
        {doc.title || `Document ${index + 1}`}
      </Text>
      <Text style={styles.documentSubtitle} numberOfLines={1}>
        {doc.type || "Attached document"}
      </Text>
    </View>
    <Ionicons name="open-outline" size={18} color="#9CA3AF" />
  </TouchableOpacity>
));

const ClassOption = React.memo(({ classItem, isSelected, onSelect }) => (
  <TouchableOpacity
    style={[styles.classOption, isSelected && styles.classOptionActive]}
    onPress={() => onSelect(classItem)}
    activeOpacity={0.7}
  >
    <Ionicons name="school-outline" size={16} color={isSelected ? "#4F46E5" : "#6B7280"} />
    <Text style={[styles.classOptionText, isSelected && styles.classOptionTextActive]}>
      {classItem.name}
    </Text>
    {isSelected && (
      <Ionicons name="checkmark-circle" size={18} color="#4F46E5" style={{ marginLeft: "auto" }} />
    )}
  </TouchableOpacity>
));

// ── Credentials card ──────────────────────────────────────────────────────────

const CredentialsCard = React.memo(({ enrollmentNo, tempPassword, onCopy }) => {
  if (!enrollmentNo && !tempPassword) return null;

  return (
    <View style={styles.credentialsCard}>
      <View style={styles.credentialsHeader}>
        <Ionicons name="key-outline" size={16} color="#4F46E5" />
        <Text style={styles.credentialsTitle}>Student Login Credentials</Text>
      </View>

      {enrollmentNo ? (
        <View style={styles.credentialRow}>
          <View style={styles.credentialLabelBox}>
            <Ionicons name="id-card-outline" size={14} color="#6B7280" />
            <Text style={styles.credentialLabel}>Enrollment No.</Text>
          </View>
          <Text style={styles.credentialValue}>{enrollmentNo}</Text>
          <TouchableOpacity style={styles.copyChip} onPress={() => onCopy(enrollmentNo, "Enrollment number")} activeOpacity={0.7}>
            <Ionicons name="copy-outline" size={13} color="#4F46E5" />
            <Text style={styles.copyChipText}>Copy</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {tempPassword ? (
        <View style={styles.credentialRow}>
          <View style={styles.credentialLabelBox}>
            <Ionicons name="lock-closed-outline" size={14} color="#6B7280" />
            <Text style={styles.credentialLabel}>Temp Password</Text>
          </View>
          <Text style={styles.credentialValue}>{tempPassword}</Text>
          <TouchableOpacity style={styles.copyChip} onPress={() => onCopy(tempPassword, "Password")} activeOpacity={0.7}>
            <Ionicons name="copy-outline" size={13} color="#4F46E5" />
            <Text style={styles.copyChipText}>Copy</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Text style={styles.credentialsHint}>
        📱 Share these details with the student. The default password is their
        enrollment number — they will be asked to change it on first login.
      </Text>
    </View>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentApplicationsScreen() {
  const router       = useRouter();
  const isMountedRef = useRef(true);

  const [applications,        setApplications]        = useState([]);
  const [classes,             setClasses]             = useState([]);
  const [selectedApplication, setSelectedApplication] = useState(null);
  const [selectedClassId,     setSelectedClassId]     = useState(null);
  const [rejectReason,        setRejectReason]        = useState("");
  const [showClassPicker,     setShowClassPicker]     = useState(false);
  const [approvalCredentials, setApprovalCredentials] = useState(null);

  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  const [approving,  setApproving]  = useState(false);
  const [rejecting,  setRejecting]  = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Load data ─────────────────────────────────────────────────────────────

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const [rawApplications, classRows] = await Promise.all([
        StudentApplicationsService.getPendingApplications(),
        ClassService.getAll(false),
      ]);

      if (!isMountedRef.current) return;

      const normalised = (rawApplications || []).map(normalizeApplication).filter(Boolean);
      setApplications(normalised);
      setClasses(classRows || []);
    } catch (err) {
      console.error("Failed to load applications:", err);
      if (isMountedRef.current) {
        setError("Failed to load applications. Pull down to retry.");
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const staleCount = useMemo(
    () => applications.filter((a) => isStaleApplication(a.created_at)).length,
    [applications]
  );

  const selectedClass = useMemo(
    () => classes.find((c) => String(c.id) === String(selectedClassId)) || null,
    [classes, selectedClassId]
  );

  // ── Modal helpers ─────────────────────────────────────────────────────────

  const openReviewModal = useCallback((application) => {
    setSelectedApplication(application);
    setSelectedClassId(application.classId ? String(application.classId) : null);
    setRejectReason("");
    setShowClassPicker(false);
    setApprovalCredentials(null);
  }, []);

  const closeReviewModal = useCallback(() => {
    if (approving || rejecting) return;
    setSelectedApplication(null);
    setSelectedClassId(null);
    setRejectReason("");
    setShowClassPicker(false);
    setApprovalCredentials(null);
  }, [approving, rejecting]);

  const handleClassSelect = useCallback((classItem) => {
    setSelectedClassId(String(classItem.id));
    setShowClassPicker(false);
  }, []);

  // ── Copy ──────────────────────────────────────────────────────────────────

  const handleCopy = useCallback(async (text, label) => {
    try {
      await Clipboard.setStringAsync(String(text));
      Alert.alert("Copied!", `${label} copied to clipboard.`);
    } catch {
      Alert.alert("Copy Failed", `Could not copy. Value: ${text}`);
    }
  }, []);

  // ── Approve ───────────────────────────────────────────────────────────────

  const handleApprove = useCallback(() => {
    if (!selectedApplication) return;
    if (!selectedClassId) {
      Alert.alert("Class Required", "Please select a class before approving this application.");
      return;
    }

    Alert.alert(
      "Approve Application",
      `Approve ${selectedApplication.name} and assign them to "${selectedClass?.name}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve",
          onPress: async () => {
            const appId     = selectedApplication.id;
            const appName   = selectedApplication.name;
            const className = selectedClass?.name ?? "the selected class";

            try {
              setApproving(true);
              const result = await StudentApplicationsService.approveApplication(appId, selectedClassId);
              if (!isMountedRef.current) return;

              setApplications((prev) => prev.filter((a) => a.id !== appId));

              const enrollmentNo  = safeResultField(result, "enrollmentNo");
              const tempPassword  = safeResultField(result, "tempPassword");
              const emailSent     = safeResultField(result, "emailSent");
              const synced        = safeResultField(result, "synced");
              const warning       = safeResultField(result, "warning");

              setApprovalCredentials({
                enrollmentNo, tempPassword, className,
                studentName: appName, synced, emailSent, warning,
              });
            } catch (err) {
              if (!isMountedRef.current) return;
              Alert.alert(
                "Approval Failed",
                err?.response?.data?.message || err?.message || "Failed to approve application"
              );
              loadData(true);
            } finally {
              if (isMountedRef.current) setApproving(false);
            }
          },
        },
      ]
    );
  }, [selectedApplication, selectedClassId, selectedClass, loadData]);

  // ── Reject ────────────────────────────────────────────────────────────────

  const handleReject = useCallback(() => {
    if (!selectedApplication) return;

    Alert.alert(
      "Reject Application",
      `Reject ${selectedApplication.name}'s application? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reject", style: "destructive",
          onPress: async () => {
            const appId   = selectedApplication.id;
            const appName = selectedApplication.name;
            try {
              setRejecting(true);
              await StudentApplicationsService.rejectApplication(appId, rejectReason);
              if (!isMountedRef.current) return;

              setApplications((prev) => prev.filter((a) => a.id !== appId));
              setSelectedApplication(null);
              setSelectedClassId(null);
              setRejectReason("");
              setShowClassPicker(false);
              setApprovalCredentials(null);
              Alert.alert("Rejected", `${appName}'s application has been rejected.`);
            } catch (err) {
              if (!isMountedRef.current) return;
              Alert.alert("Rejection Failed", err?.response?.data?.message || err?.message || "Failed to reject");
              loadData(true);
            } finally {
              if (isMountedRef.current) setRejecting(false);
            }
          },
        },
      ]
    );
  }, [selectedApplication, rejectReason, loadData]);

  // ── Document opener ───────────────────────────────────────────────────────

  const openDocument = useCallback(async (doc) => {
    const uri = doc?.uri || doc?.url || doc?.fileUrl || doc?.path;
    if (!uri) { Alert.alert("Unavailable", "No document link is available."); return; }
    try {
      const supported = await Linking.canOpenURL(uri);
      if (!supported) { Alert.alert("Error", "This document type cannot be opened on this device."); return; }
      await Linking.openURL(uri);
    } catch {
      Alert.alert("Error", "Unable to open this document.");
    }
  }, []);

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading applications…</Text>
      </View>
    );
  }

  const isActionBusy = approving || rejecting;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Applications</Text>
          <Text style={styles.headerSubtitle}>
            {applications.length} {applications.length === 1 ? "pending application" : "pending applications"}
          </Text>
        </View>
        <TouchableOpacity style={styles.refreshButton} onPress={() => loadData(true)} activeOpacity={0.7}>
          <Ionicons name="refresh" size={20} color="#D97706" />
        </TouchableOpacity>
      </View>

      {/* Summary */}
      <View style={styles.summaryRow}>
        <SummaryCard bg="#FEF3C7" icon="person-add-outline" iconColor="#D97706" value={applications.length} label="Pending" />
        <SummaryCard bg="#FEE2E2" icon="alert-circle-outline" iconColor="#DC2626" value={staleCount} label={`Over ${STALE_DAYS}d`} />
        <SummaryCard bg="#EEF2FF" icon="school-outline" iconColor="#4F46E5" value={classes.length} label="Classes" />
      </View>

      {/* List */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} tintColor="#D97706" colors={["#D97706"]} />}
      >
        {!!error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={18} color="#DC2626" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => loadData()} activeOpacity={0.75} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {applications.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="checkmark-circle-outline" size={48} color="#059669" />
            <Text style={styles.emptyTitle}>All caught up!</Text>
            <Text style={styles.emptySubtitle}>
              No pending applications at the moment. New submissions will appear here for review.
            </Text>
          </View>
        ) : (
          applications.map((app) => (
            <ApplicationCard key={app.id} application={app} onReview={openReviewModal} />
          ))
        )}
        <View style={{ height: 32 }} />
      </ScrollView>

      {/* Review / Credentials Modal */}
      <Modal visible={!!selectedApplication} animationType="slide" transparent onRequestClose={closeReviewModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHandle} />

            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  {approvalCredentials ? "Approval Successful 🎉" : "Review Application"}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {approvalCredentials
                    ? `${approvalCredentials.studentName} → ${approvalCredentials.className}`
                    : "Approve or reject this application"}
                </Text>
              </View>
              <TouchableOpacity onPress={closeReviewModal} style={styles.closeButton} disabled={isActionBusy} activeOpacity={0.7}>
                <Ionicons name="close" size={22} color="#6B7280" />
              </TouchableOpacity>
            </View>

            {/* Credentials view */}
            {approvalCredentials ? (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalContent}>
                {approvalCredentials.synced === false && (
                  <View style={styles.offlineBanner}>
                    <Ionicons name="cloud-offline-outline" size={18} color="#92400E" />
                    <Text style={styles.offlineBannerText}>
                      Approved offline — the student account will be fully created once you reconnect.
                    </Text>
                  </View>
                )}
                {approvalCredentials.emailSent === true && (
                  <View style={styles.emailSentBanner}>
                    <Ionicons name="mail-outline" size={18} color="#065F46" />
                    <Text style={styles.emailSentText}>Login details have been emailed to the student.</Text>
                  </View>
                )}
                {approvalCredentials.warning ? (
                  <View style={styles.warningBanner}>
                    <Ionicons name="warning-outline" size={18} color="#92400E" />
                    <Text style={styles.warningBannerText}>{approvalCredentials.warning}</Text>
                  </View>
                ) : null}
                <CredentialsCard
                  enrollmentNo={approvalCredentials.enrollmentNo}
                  tempPassword={approvalCredentials.tempPassword}
                  onCopy={handleCopy}
                />
                <TouchableOpacity style={styles.doneButton} onPress={closeReviewModal} activeOpacity={0.8}>
                  <Ionicons name="checkmark" size={20} color="#FFFFFF" />
                  <Text style={styles.doneButtonText}>Done</Text>
                </TouchableOpacity>
              </ScrollView>
            ) : (

            /* Review view */
            selectedApplication && (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">

                {/* Student details */}
                <View style={styles.detailSection}>
                  <View style={styles.detailSectionHeader}>
                    <Ionicons name="person" size={16} color="#4F46E5" />
                    <Text style={styles.detailSectionTitle}>Student Details</Text>
                  </View>
                  <DetailRow icon="person-outline" iconColor="#D97706" label="Full Name" value={selectedApplication.name} />
                  <DetailRow icon="mail-outline" iconColor="#4F46E5" label="Email Address" value={selectedApplication.email || "No email provided"} />
                  <DetailRow icon="call-outline" iconColor="#059669" label="Phone Number" value={selectedApplication.phone} />
                  <DetailRow icon="people-outline" iconColor="#4F46E5" label="Guardian / Parent" value={selectedApplication.guardianName} />
                  {selectedApplication.address ? <DetailRow icon="home-outline" iconColor="#6B7280" label="Address" value={selectedApplication.address} /> : null}
                  {selectedApplication.notes   ? <DetailRow icon="document-text-outline" iconColor="#6B7280" label="Notes" value={selectedApplication.notes} /> : null}
                  <DetailRow icon="school-outline" iconColor="#7C3AED" label="Applied for Class" value={selectedApplication.className || selectedApplication.grade || "Not specified"} />
                  <DetailRow icon="calendar-outline" iconColor="#4F46E5" label="Applied On" value={formatDate(selectedApplication.created_at)} />
                </View>

                {/* Documents */}
                <View style={styles.detailSection}>
                  <View style={styles.detailSectionHeader}>
                    <Ionicons name="document-text" size={16} color="#059669" />
                    <Text style={styles.detailSectionTitle}>Documents</Text>
                  </View>
                  {selectedApplication.documents?.length > 0 ? (
                    selectedApplication.documents.map((doc, index) => (
                      <DocumentCard key={doc.id || `doc-${index}`} doc={doc} index={index} onOpen={openDocument} />
                    ))
                  ) : (
                    <View style={styles.emptyDocuments}>
                      <Ionicons name="document-outline" size={20} color="#9CA3AF" />
                      <Text style={styles.emptyDocumentsText}>No documents attached</Text>
                    </View>
                  )}
                </View>

                {/* Class assignment */}
                <View style={styles.detailSection}>
                  <View style={styles.detailSectionHeader}>
                    <Ionicons name="school" size={16} color="#4F46E5" />
                    <Text style={styles.detailSectionTitle}>Assign Class Upon Approval</Text>
                  </View>
                  {classes.length === 0 ? (
                    <View style={styles.noClassesBox}>
                      <Ionicons name="alert-circle-outline" size={18} color="#D97706" />
                      <Text style={styles.noClassesText}>No active classes found. Create a class before approving.</Text>
                    </View>
                  ) : (
                    <>
                      <TouchableOpacity
                        style={[styles.classSelector, selectedClass && styles.classSelectorSelected]}
                        onPress={() => setShowClassPicker((p) => !p)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.classSelectorText, !selectedClass && styles.classSelectorPlaceholder]}>
                          {selectedClass ? selectedClass.name : "Select a class…"}
                        </Text>
                        <Ionicons name={showClassPicker ? "chevron-up" : "chevron-down"} size={18} color="#6B7280" />
                      </TouchableOpacity>
                      {showClassPicker && (
                        <View style={styles.classOptionsBox}>
                          {classes.map((classItem) => (
                            <ClassOption
                              key={classItem.id}
                              classItem={classItem}
                              isSelected={String(selectedClassId) === String(classItem.id)}
                              onSelect={handleClassSelect}
                            />
                          ))}
                        </View>
                      )}
                    </>
                  )}
                </View>

                {/* Rejection reason */}
                <View style={styles.detailSection}>
                  <View style={styles.detailSectionHeader}>
                    <Ionicons name="chatbubble-ellipses" size={16} color="#DC2626" />
                    <Text style={styles.detailSectionTitle}>
                      Rejection Reason <Text style={styles.optional}>(Optional)</Text>
                    </Text>
                  </View>
                  <TextInput
                    style={styles.reasonInput}
                    placeholder="Write a reason for rejection…"
                    placeholderTextColor="#9CA3AF"
                    multiline
                    numberOfLines={3}
                    value={rejectReason}
                    onChangeText={setRejectReason}
                    autoCapitalize="sentences"
                    editable={!isActionBusy}
                  />
                </View>

                {/* Action buttons */}
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={[styles.rejectButton, isActionBusy && styles.actionButtonDisabled]}
                    onPress={handleReject}
                    disabled={isActionBusy}
                    activeOpacity={0.7}
                  >
                    {rejecting
                      ? <ActivityIndicator size="small" color="#FFFFFF" />
                      : <><Ionicons name="close-circle-outline" size={18} color="#FFFFFF" /><Text style={styles.actionButtonText}>Reject</Text></>
                    }
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.approveButton, (isActionBusy || classes.length === 0) && styles.actionButtonDisabled]}
                    onPress={handleApprove}
                    disabled={isActionBusy || classes.length === 0}
                    activeOpacity={0.7}
                  >
                    {approving
                      ? <ActivityIndicator size="small" color="#FFFFFF" />
                      : <><Ionicons name="checkmark-circle-outline" size={18} color="#FFFFFF" /><Text style={styles.actionButtonText}>Approve</Text></>
                    }
                  </TouchableOpacity>
                </View>
              </ScrollView>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F9FAFB" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F9FAFB" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16, backgroundColor: "#FFFFFF", borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  backButton: { width: 40, height: 40, borderRadius: 12, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  headerCenter:   { flex: 1, marginLeft: 12, marginRight: 8 },
  headerTitle:    { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  refreshButton: { width: 40, height: 40, borderRadius: 12, backgroundColor: "#FEF3C7", alignItems: "center", justifyContent: "center" },

  errorBanner: { flexDirection: "row", alignItems: "center", backgroundColor: "#FEE2E2", marginHorizontal: 20, marginTop: 16, padding: 12, borderRadius: 10, gap: 8 },
  errorText:   { flex: 1, fontSize: 13, color: "#991B1B", fontWeight: "500" },
  retryText:   { fontSize: 13, color: "#DC2626", fontWeight: "700" },

  summaryRow:    { flexDirection: "row", paddingHorizontal: 20, gap: 8, marginTop: 20, marginBottom: 8 },
  summaryCard:   { flex: 1, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 6, alignItems: "center", gap: 4 },
  summaryNumber: { fontSize: 18, fontWeight: "700", color: "#111827" },
  summaryLabel:  { fontSize: 10, color: "#6B7280", fontWeight: "600", textAlign: "center" },

  scrollContent: { paddingTop: 12, paddingBottom: 40 },

  applicationCard: { backgroundColor: "#FFFFFF", borderRadius: 14, padding: 16, marginHorizontal: 20, marginBottom: 10, borderWidth: 1, borderColor: "#E5E7EB" },
  applicationCardStale: { borderColor: "#FECACA", borderWidth: 1.5 },
  applicationTop:  { flexDirection: "row", alignItems: "center" },
  avatarBox:       { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", marginRight: 12 },
  applicationInfo: { flex: 1, marginRight: 8 },
  studentName:     { fontSize: 15, fontWeight: "700", color: "#111827" },
  studentEmail:    { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  statusBadge:     { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  pendingBadge:    { backgroundColor: "#FEF3C7" },
  staleBadge:      { backgroundColor: "#FEE2E2" },
  statusBadgeText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  pendingBadgeText:{ color: "#92400E" },
  staleBadgeText:  { color: "#991B1B" },
  metaGrid:        { marginTop: 12, gap: 6 },
  metaItem:        { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText:        { fontSize: 13, color: "#374151", fontWeight: "500", flexShrink: 1 },
  reviewButton:    { marginTop: 14, backgroundColor: "#D97706", borderRadius: 12, paddingVertical: 12, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 },
  reviewButtonText:{ color: "#FFFFFF", fontWeight: "700", fontSize: 14 },

  emptyState:    { alignItems: "center", justifyContent: "center", paddingVertical: 60, paddingHorizontal: 40 },
  emptyTitle:    { fontSize: 16, fontWeight: "600", color: "#374151", marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: "#9CA3AF", marginTop: 4, textAlign: "center", lineHeight: 18 },

  modalOverlay:    { flex: 1, backgroundColor: "rgba(17, 24, 39, 0.45)", justifyContent: "flex-end" },
  modalContainer:  { maxHeight: "92%", backgroundColor: "#F9FAFB", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10 },
  modalHandle:     { width: 44, height: 5, borderRadius: 99, backgroundColor: "#D1D5DB", alignSelf: "center", marginBottom: 14 },
  modalHeader:     { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: "#F3F4F6", marginBottom: 4 },
  modalTitle:      { fontSize: 20, fontWeight: "700", color: "#111827" },
  modalSubtitle:   { fontSize: 13, color: "#6B7280", marginTop: 2 },
  closeButton:     { width: 36, height: 36, borderRadius: 10, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  modalContent:    { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 30 },

  detailSection:       { backgroundColor: "#FFFFFF", borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  detailSectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  detailSectionTitle:  { fontSize: 15, fontWeight: "700", color: "#111827" },
  optional:            { fontSize: 13, fontWeight: "400", color: "#9CA3AF" },
  detailRow:           { flexDirection: "row", alignItems: "flex-start", marginBottom: 12, gap: 10 },
  detailTextBox:       { flex: 1 },
  detailLabel:         { fontSize: 12, color: "#9CA3AF", fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3 },
  detailValue:         { fontSize: 14, color: "#111827", fontWeight: "600", marginTop: 2 },

  documentCard:     { flexDirection: "row", alignItems: "center", backgroundColor: "#F9FAFB", borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "#E5E7EB" },
  documentIcon:     { width: 36, height: 36, borderRadius: 10, backgroundColor: "#ECFDF5", alignItems: "center", justifyContent: "center", marginRight: 10 },
  documentTitle:    { fontSize: 14, fontWeight: "600", color: "#111827" },
  documentSubtitle: { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  emptyDocuments:   { flexDirection: "row", alignItems: "center", backgroundColor: "#F9FAFB", borderRadius: 12, padding: 12, gap: 8, borderWidth: 1, borderColor: "#E5E7EB" },
  emptyDocumentsText:{ fontSize: 13, color: "#6B7280", fontWeight: "500" },

  noClassesBox:  { flexDirection: "row", alignItems: "flex-start", backgroundColor: "#FEF3C7", borderRadius: 10, padding: 12, gap: 8 },
  noClassesText: { flex: 1, fontSize: 13, color: "#92400E", fontWeight: "500" },
  classSelector: { backgroundColor: "#F9FAFB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, borderWidth: 1.5, borderColor: "#E5E7EB", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  classSelectorSelected:    { borderColor: "#4F46E5", backgroundColor: "#FAFAFF" },
  classSelectorText:        { fontSize: 15, color: "#111827", fontWeight: "600" },
  classSelectorPlaceholder: { color: "#9CA3AF" },
  classOptionsBox: { marginTop: 8, backgroundColor: "#FFFFFF", borderRadius: 12, borderWidth: 1, borderColor: "#E5E7EB", overflow: "hidden" },
  classOption:     { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  classOptionActive:     { backgroundColor: "#EEF2FF" },
  classOptionText:       { fontSize: 14, color: "#374151", fontWeight: "500", flex: 1 },
  classOptionTextActive: { color: "#4F46E5", fontWeight: "700" },

  reasonInput: { minHeight: 90, textAlignVertical: "top", backgroundColor: "#F9FAFB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: "#111827", borderWidth: 1, borderColor: "#E5E7EB" },

  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  rejectButton:  { flex: 1, backgroundColor: "#DC2626", borderRadius: 12, paddingVertical: 14, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 },
  approveButton: { flex: 1, backgroundColor: "#059669", borderRadius: 12, paddingVertical: 14, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 },
  actionButtonDisabled: { backgroundColor: "#9CA3AF" },
  actionButtonText:     { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },

  credentialsCard:   { backgroundColor: "#EEF2FF", borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: "#C7D2FE" },
  credentialsHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  credentialsTitle:  { fontSize: 15, fontWeight: "700", color: "#3730A3" },
  credentialRow:     { flexDirection: "row", alignItems: "center", backgroundColor: "#FFFFFF", borderRadius: 10, paddingVertical: 10, paddingLeft: 12, paddingRight: 8, marginBottom: 8, borderWidth: 1, borderColor: "#E0E7FF", gap: 8 },
  credentialLabelBox:{ flexDirection: "row", alignItems: "center", gap: 4, width: 110 },
  credentialLabel:   { fontSize: 12, color: "#6B7280", fontWeight: "600" },
  credentialValue:   { flex: 1, fontSize: 14, fontWeight: "700", color: "#111827", letterSpacing: 0.5 },
  copyChip:          { flexDirection: "row", alignItems: "center", backgroundColor: "#EEF2FF", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, gap: 4 },
  copyChipText:      { fontSize: 11, fontWeight: "700", color: "#4F46E5" },
  credentialsHint:   { fontSize: 12, color: "#4338CA", lineHeight: 18, marginTop: 4 },

  offlineBanner:     { flexDirection: "row", alignItems: "flex-start", backgroundColor: "#FEF3C7", borderRadius: 10, padding: 12, marginBottom: 12, gap: 8 },
  offlineBannerText: { flex: 1, fontSize: 13, color: "#92400E", fontWeight: "500" },
  emailSentBanner:   { flexDirection: "row", alignItems: "center", backgroundColor: "#ECFDF5", borderRadius: 10, padding: 12, marginBottom: 12, gap: 8 },
  emailSentText:     { flex: 1, fontSize: 13, color: "#065F46", fontWeight: "500" },
  warningBanner:     { flexDirection: "row", alignItems: "flex-start", backgroundColor: "#FEF3C7", borderRadius: 10, padding: 12, marginBottom: 12, gap: 8 },
  warningBannerText: { flex: 1, fontSize: 13, color: "#92400E", fontWeight: "500" },
  doneButton:        { backgroundColor: "#4F46E5", borderRadius: 12, paddingVertical: 14, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 4 },
  doneButtonText:    { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
});