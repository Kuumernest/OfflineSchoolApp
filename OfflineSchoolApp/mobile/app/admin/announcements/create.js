// app/admin/announcements/create.js
"use strict";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useRouter }        from "expo-router";
import { Ionicons }         from "@expo/vector-icons";
import AnnouncementService  from "../../../src/services/announcement.service";
import { ClassService }     from "../../../src/services/class.service";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const PRIORITY_COLORS = {
  normal:    { bg: "#F0FDF4", text: "#15803D", border: "#BBF7D0" },
  important: { bg: "#FEF3C7", text: "#92400E", border: "#FDE68A" },
  urgent:    { bg: "#FEE2E2", text: "#991B1B", border: "#FECACA" },
};

const AUDIENCES = [
  {
    key:   "all",
    label: "Everyone",
    desc:  "All staff and students",
    icon:  "globe-outline",
    color: "#4F46E5",
  },
  {
    key:   "teachers",
    label: "Teachers Only",
    desc:  "Only teaching staff",
    icon:  "people-outline",
    color: "#0891B2",
  },
  {
    key:   "students",
    label: "Students Only",
    desc:  "All students",
    icon:  "school-outline",
    color: "#7C3AED",
  },
  {
    key:   "class",
    label: "Specific Class",
    desc:  "Select target class(es)",
    icon:  "layers-outline",
    color: "#EA580C",
  },
];

const PRIORITIES = [
  {
    key:   "normal",
    label: "Normal",
    icon:  "information-circle-outline",
    color: "#15803D",
    bg:    "#F0FDF4",
  },
  {
    key:   "important",
    label: "Important",
    icon:  "alert-circle-outline",
    color: "#92400E",
    bg:    "#FEF3C7",
  },
  {
    key:   "urgent",
    label: "Urgent",
    icon:  "warning-outline",
    color: "#991B1B",
    bg:    "#FEE2E2",
  },
];

const MAX_BODY = 5000;

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function CreateAnnouncementScreen() {
  const router   = useRouter();
  const titleRef = useRef(null);

  // ── Form state ──────────────────────────────────────────
  const [title,           setTitle]           = useState("");
  const [body,            setBody]            = useState("");
  const [audience,        setAudience]        = useState("all");
  const [priority,        setPriority]        = useState("normal");
  const [isPinned,        setIsPinned]        = useState(false);
  const [selectedClasses, setSelectedClasses] = useState([]);

  // ── Data state ──────────────────────────────────────────
  const [classes,        setClasses]        = useState([]);
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [saving,         setSaving]         = useState(false);

  // ── Load classes on mount ───────────────────────────────
  useEffect(() => {
    const loadClasses = async () => {
      setLoadingClasses(true);
      try {
        const data = await ClassService.getAll();
        setClasses(
          (data || []).filter(
            (c) => c.isActive !== false && c.isActive !== 0
          )
        );
      } catch (err) {
        console.warn("loadClasses failed:", err.message);
        setClasses([]);
      } finally {
        setLoadingClasses(false);
      }
    };

    loadClasses();

    // Auto-focus title after screen transition
    const t = setTimeout(() => titleRef.current?.focus(), 400);
    return () => clearTimeout(t);
  }, []);

  // ── Clear class selection when audience changes ─────────
  useEffect(() => {
    if (audience !== "class") setSelectedClasses([]);
  }, [audience]);

  // ── Toggle single class ─────────────────────────────────
  const toggleClass = useCallback((classId) => {
    setSelectedClasses((prev) =>
      prev.includes(classId)
        ? prev.filter((id) => id !== classId)
        : [...prev, classId]
    );
  }, []);

  // ── Toggle all classes ──────────────────────────────────
  const toggleAllClasses = useCallback(() => {
    const allIds = classes.map((c) => c.id || c._id);
    setSelectedClasses((prev) =>
      prev.length === allIds.length ? [] : allIds
    );
  }, [classes]);

  // ── Validation ──────────────────────────────────────────
  const validate = () => {
    if (!title.trim()) {
      Alert.alert("Required", "Please enter a title");
      return false;
    }
    if (title.trim().length < 3) {
      Alert.alert("Too Short", "Title must be at least 3 characters");
      return false;
    }
    if (!body.trim()) {
      Alert.alert("Required", "Please enter the announcement message");
      return false;
    }
    if (audience === "class" && selectedClasses.length === 0) {
      Alert.alert("Required", "Please select at least one class");
      return false;
    }
    return true;
  };

  // ── Submit ──────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      await AnnouncementService.createAnnouncement({
        title:         title.trim(),
        body:          body.trim(),
        audience,
        targetClasses: audience === "class" ? selectedClasses : [],
        priority,
        isPinned,
      });

      Alert.alert(
        "Announcement Sent ✓",
        "Your announcement has been created successfully.",
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (err) {
      Alert.alert("Error", err.message || "Failed to create announcement");
    } finally {
      setSaving(false);
    }
  };

  // ── Derived values ──────────────────────────────────────
  const selAudience = AUDIENCES.find((a) => a.key === audience) || AUDIENCES[0];
  const canPreview  = title.trim().length > 0;
  const allSelected =
    classes.length > 0 && selectedClasses.length === classes.length;

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
          disabled={saving}
        >
          <Ionicons name="close" size={24} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>New Announcement</Text>
        </View>

        <TouchableOpacity
          onPress={handleSubmit}
          style={[styles.sendBtn, saving && styles.sendBtnDisabled]}
          disabled={saving}
          activeOpacity={0.7}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#9CA3AF" />
          ) : (
            <>
              <Ionicons name="send" size={18} color="#FFF" />
              <Text style={styles.sendText}>Send</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Title ── */}
          <Text style={styles.label}>Title *</Text>
          <TextInput
            ref={titleRef}
            style={styles.titleInput}
            value={title}
            onChangeText={setTitle}
            placeholder="Enter announcement title…"
            placeholderTextColor="#9CA3AF"
            maxLength={200}
            returnKeyType="next"
          />

          {/* ── Body ── */}
          <Text style={styles.label}>Message *</Text>
          <TextInput
            style={styles.bodyInput}
            value={body}
            onChangeText={setBody}
            placeholder="Write your announcement here…"
            placeholderTextColor="#9CA3AF"
            multiline
            textAlignVertical="top"
            maxLength={MAX_BODY}
          />
          <Text style={[
            styles.charCount,
            body.length > MAX_BODY * 0.9 && { color: "#DC2626" },
          ]}>
            {body.length}/{MAX_BODY}
          </Text>

          {/* ── Audience ── */}
          <Text style={styles.label}>Target Audience</Text>
          <View style={styles.optionsGrid}>
            {AUDIENCES.map((a) => (
              <TouchableOpacity
                key={a.key}
                style={[
                  styles.optionCard,
                  audience === a.key && {
                    borderColor:     a.color,
                    backgroundColor: `${a.color}08`,
                  },
                ]}
                onPress={() => setAudience(a.key)}
                activeOpacity={0.7}
              >
                <View style={[
                  styles.optionIcon,
                  {
                    backgroundColor:
                      audience === a.key ? `${a.color}15` : "#F3F4F6",
                  },
                ]}>
                  <Ionicons
                    name={a.icon}
                    size={18}
                    color={audience === a.key ? a.color : "#9CA3AF"}
                  />
                </View>
                <Text style={[
                  styles.optionLabel,
                  audience === a.key && { color: a.color },
                ]}>
                  {a.label}
                </Text>
                <Text style={styles.optionDesc}>{a.desc}</Text>
                {audience === a.key && (
                  <View style={[styles.checkMark, { backgroundColor: a.color }]}>
                    <Ionicons name="checkmark" size={10} color="#FFF" />
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>

          {/* ── Class selection (only when audience === "class") ── */}
          {audience === "class" && (
            <>
              <View style={styles.classTitleRow}>
                <Text style={styles.label}>Select Class(es) *</Text>
                {classes.length > 0 && (
                  <TouchableOpacity
                    onPress={toggleAllClasses}
                    style={styles.selectAllBtn}
                  >
                    <Text style={styles.selectAllText}>
                      {allSelected ? "Deselect All" : "Select All"}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              {loadingClasses ? (
                <View style={styles.classesLoader}>
                  <ActivityIndicator size="small" color="#4F46E5" />
                  <Text style={styles.classesLoaderText}>
                    Loading classes…
                  </Text>
                </View>
              ) : classes.length === 0 ? (
                <Text style={styles.noClassText}>
                  No active classes found. Configure classes first.
                </Text>
              ) : (
                <View style={styles.classGrid}>
                  {classes.map((c) => {
                    const cid = c.id || c._id;
                    const sel = selectedClasses.includes(cid);
                    return (
                      <TouchableOpacity
                        key={cid}
                        style={[
                          styles.classChip,
                          sel && styles.classChipSelected,
                        ]}
                        onPress={() => toggleClass(cid)}
                        activeOpacity={0.7}
                      >
                        <Ionicons
                          name={sel ? "checkbox" : "square-outline"}
                          size={16}
                          color={sel ? "#4F46E5" : "#9CA3AF"}
                        />
                        <Text style={[
                          styles.classChipText,
                          sel && styles.classChipTextSelected,
                        ]}>
                          {c.name}
                          {c.section ? ` ${c.section}` : ""}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {selectedClasses.length > 0 && (
                <Text style={styles.selectedCount}>
                  {selectedClasses.length} class
                  {selectedClasses.length > 1 ? "es" : ""} selected
                </Text>
              )}
            </>
          )}

          {/* ── Priority ── */}
          <Text style={styles.label}>Priority</Text>
          <View style={styles.priorityRow}>
            {PRIORITIES.map((p) => (
              <TouchableOpacity
                key={p.key}
                style={[
                  styles.priorityChip,
                  priority === p.key && {
                    backgroundColor: p.bg,
                    borderColor:     p.color,
                  },
                ]}
                onPress={() => setPriority(p.key)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={p.icon}
                  size={14}
                  color={priority === p.key ? p.color : "#9CA3AF"}
                />
                <Text style={[
                  styles.priorityText,
                  priority === p.key && { color: p.color, fontWeight: "700" },
                ]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* ── Pin toggle ── */}
          <View style={styles.optionRow}>
            <View style={styles.optionLeft}>
              <Ionicons name="pin-outline" size={18} color="#6B7280" />
              <View>
                <Text style={styles.optionTitle}>Pin Announcement</Text>
                <Text style={styles.optionSubtitle}>
                  Stays at top of everyone's feed
                </Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={() => setIsPinned(!isPinned)}
              style={[styles.toggle, isPinned && styles.toggleActive]}
              activeOpacity={0.7}
            >
              <View style={[
                styles.toggleDot,
                isPinned && styles.toggleDotActive,
              ]} />
            </TouchableOpacity>
          </View>

          {/* ── Preview ── */}
          {canPreview && (
            <View style={styles.previewSection}>
              <Text style={styles.previewLabel}>Preview</Text>
              <View style={styles.previewCard}>
                {isPinned && (
                  <View style={styles.previewPin}>
                    <Ionicons name="pin" size={10} color="#4F46E5" />
                    <Text style={styles.previewPinText}>Pinned</Text>
                  </View>
                )}
                <Text style={styles.previewTitle} numberOfLines={2}>
                  {title.trim()}
                </Text>
                {body.trim().length > 0 && (
                  <Text style={styles.previewBody} numberOfLines={3}>
                    {body.trim()}
                  </Text>
                )}
                <View style={styles.previewMeta}>
                  <View style={[
                    styles.previewBadge,
                    { backgroundColor: PRIORITY_COLORS[priority]?.bg },
                  ]}>
                    <Text style={{
                      fontSize:      10,
                      fontWeight:    "700",
                      color:         PRIORITY_COLORS[priority]?.text,
                      textTransform: "capitalize",
                    }}>
                      {priority}
                    </Text>
                  </View>
                  <Text style={styles.previewAudience}>
                    → {selAudience.label}
                  </Text>
                  {audience === "class" && selectedClasses.length > 0 && (
                    <Text style={styles.previewAudience}>
                      ({selectedClasses.length} class
                      {selectedClasses.length > 1 ? "es" : ""})
                    </Text>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* ── Submit ── */}
          <TouchableOpacity
            style={[
              styles.submitBtn,
              { backgroundColor: PRIORITY_COLORS[priority]?.text || "#4F46E5" },
              saving && { opacity: 0.6 },
            ]}
            onPress={handleSubmit}
            disabled={saving}
            activeOpacity={0.85}
          >
            {saving ? (
              <ActivityIndicator color="#FFF" size="small" />
            ) : (
              <>
                <Ionicons name="megaphone-outline" size={20} color="#FFF" />
                <Text style={styles.submitText}>
                  Send Announcement
                  {audience === "class" && selectedClasses.length > 0
                    ? ` · ${selectedClasses.length} Class${selectedClasses.length > 1 ? "es" : ""}`
                    : audience !== "all"
                    ? ` · ${selAudience.label}`
                    : ""}
                </Text>
              </>
            )}
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9FAFB" },

  // ── Header ──────────────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 20,
    paddingTop:        60,
    paddingBottom:     16,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: {
    flex:              1,
    alignItems:        "center",
    justifyContent:    "center",
    paddingHorizontal: 12,
  },
  headerTitle: {
    fontSize:   17,
    fontWeight: "700",
    color:      "#111827",
  },
  sendBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               6,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      12,
    minWidth:          80,
    shadowColor:       "#4F46E5",
    shadowOpacity:     0.3,
    shadowRadius:      6,
    shadowOffset:      { width: 0, height: 2 },
    elevation:         3,
  },
  sendBtnDisabled: {
    backgroundColor: "#E5E7EB",
    shadowOpacity:   0,
    elevation:       0,
  },
  sendText: {
    color:      "#FFF",
    fontSize:   14,
    fontWeight: "700",
  },

  // ── Scroll content ──────────────────────────────────────
  scrollContent: {
    padding:       20,
    paddingBottom: 40,
  },

  // ── Field labels ────────────────────────────────────────
  label: {
    fontSize:      13,
    fontWeight:    "700",
    color:         "#374151",
    marginTop:     20,
    marginBottom:  8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  // ── Inputs ──────────────────────────────────────────────
  titleInput: {
    borderWidth:       1.5,
    borderColor:       "#E5E7EB",
    borderRadius:      12,
    paddingHorizontal: 14,
    paddingVertical:   14,
    fontSize:          16,
    fontWeight:        "600",
    color:             "#111827",
    backgroundColor:   "#FFF",
  },
  bodyInput: {
    borderWidth:       1.5,
    borderColor:       "#E5E7EB",
    borderRadius:      12,
    paddingHorizontal: 14,
    paddingVertical:   14,
    fontSize:          15,
    color:             "#111827",
    backgroundColor:   "#FFF",
    minHeight:         160,
    maxHeight:         320,
    lineHeight:        22,
  },
  charCount: {
    fontSize:   11,
    color:      "#9CA3AF",
    textAlign:  "right",
    marginTop:  6,
    fontWeight: "600",
  },

  // ── Audience cards grid ─────────────────────────────────
  optionsGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           10,
  },
  optionCard: {
    width:           "48%",
    borderWidth:     1.5,
    borderColor:     "#E5E7EB",
    borderRadius:    14,
    padding:         14,
    backgroundColor: "#FFF",
    position:        "relative",
    gap:             6,
  },
  optionIcon: {
    width:          34,
    height:         34,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
    marginBottom:   4,
  },
  optionLabel: {
    fontSize:   14,
    fontWeight: "700",
    color:      "#111827",
  },
  optionDesc: {
    fontSize:   11,
    color:      "#6B7280",
    lineHeight: 15,
  },
  checkMark: {
    position:       "absolute",
    top:            10,
    right:          10,
    width:          18,
    height:         18,
    borderRadius:   9,
    alignItems:     "center",
    justifyContent: "center",
  },

  // ── Class selection ─────────────────────────────────────
  classTitleRow: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
  },
  selectAllBtn: {
    marginTop:         12,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      8,
    backgroundColor:   "#EEF2FF",
  },
  selectAllText: {
    fontSize:   12,
    color:      "#4F46E5",
    fontWeight: "700",
  },
  classesLoader: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             10,
    paddingVertical: 20,
  },
  classesLoaderText: {
    fontSize: 13,
    color:    "#6B7280",
  },
  noClassText: {
    fontSize:          13,
    color:             "#6B7280",
    fontStyle:         "italic",
    textAlign:         "center",
    paddingVertical:   20,
    paddingHorizontal: 14,
    backgroundColor:   "#F9FAFB",
    borderRadius:      12,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    borderStyle:       "dashed",
  },
  classGrid: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           8,
  },
  classChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 12,
    paddingVertical:   9,
    borderRadius:      10,
    borderWidth:       1.5,
    borderColor:       "#E5E7EB",
    backgroundColor:   "#FFF",
  },
  classChipSelected: {
    borderColor:     "#4F46E5",
    backgroundColor: "#EEF2FF",
  },
  classChipText: {
    fontSize:   13,
    color:      "#6B7280",
    fontWeight: "600",
  },
  classChipTextSelected: {
    color:      "#4F46E5",
    fontWeight: "700",
  },
  selectedCount: {
    fontSize:   12,
    color:      "#4F46E5",
    fontWeight: "700",
    marginTop:  10,
    textAlign:  "right",
  },

  // ── Priority chips row ──────────────────────────────────
  priorityRow: {
    flexDirection: "row",
    gap:           8,
    flexWrap:      "wrap",
  },
  priorityChip: {
    flex:              1,
    minWidth:          90,
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "center",
    gap:               6,
    paddingVertical:   11,
    paddingHorizontal: 12,
    borderRadius:      10,
    borderWidth:       1.5,
    borderColor:       "#E5E7EB",
    backgroundColor:   "#FFF",
  },
  priorityText: {
    fontSize:   13,
    color:      "#6B7280",
    fontWeight: "600",
  },

  // ── Pin toggle row ──────────────────────────────────────
  optionRow: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    padding:           14,
    marginTop:         20,
    borderRadius:      12,
    borderWidth:       1.5,
    borderColor:       "#E5E7EB",
    backgroundColor:   "#FFF",
  },
  optionLeft: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           12,
    flex:          1,
  },
  optionTitle: {
    fontSize:   14,
    fontWeight: "700",
    color:      "#111827",
  },
  optionSubtitle: {
    fontSize:  11,
    color:     "#6B7280",
    marginTop: 2,
  },
  toggle: {
    width:           46,
    height:          26,
    borderRadius:    13,
    backgroundColor: "#E5E7EB",
    padding:         3,
    justifyContent:  "center",
  },
  toggleActive: {
    backgroundColor: "#4F46E5",
  },
  toggleDot: {
    width:           20,
    height:          20,
    borderRadius:    10,
    backgroundColor: "#FFF",
    shadowColor:     "#000",
    shadowOpacity:   0.15,
    shadowRadius:    2,
    shadowOffset:    { width: 0, height: 1 },
    elevation:       2,
  },
  toggleDotActive: {
    transform: [{ translateX: 20 }],
  },

  // ── Preview section ─────────────────────────────────────
  previewSection: {
    marginTop: 24,
  },
  previewLabel: {
    fontSize:      12,
    fontWeight:    "700",
    color:         "#9CA3AF",
    marginBottom:  8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  previewCard: {
    borderRadius:    14,
    borderWidth:     1.5,
    borderColor:     "#E5E7EB",
    backgroundColor: "#FFF",
    padding:         14,
    gap:             8,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    shadowOffset:    { width: 0, height: 2 },
    elevation:       1,
  },
  previewPin: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    alignSelf:         "flex-start",
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
    backgroundColor:   "#EEF2FF",
  },
  previewPinText: {
    fontSize:   10,
    color:      "#4F46E5",
    fontWeight: "700",
  },
  previewTitle: {
    fontSize:   15,
    fontWeight: "700",
    color:      "#111827",
    lineHeight: 20,
  },
  previewBody: {
    fontSize:   13,
    color:      "#4B5563",
    lineHeight: 19,
  },
  previewMeta: {
    flexDirection: "row",
    alignItems:    "center",
    flexWrap:      "wrap",
    gap:           8,
    marginTop:     4,
  },
  previewBadge: {
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      6,
  },
  previewAudience: {
    fontSize:   11,
    color:      "#6B7280",
    fontWeight: "600",
  },

  // ── Submit button ───────────────────────────────────────
  submitBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             10,
    paddingVertical: 16,
    borderRadius:    14,
    marginTop:       28,
    shadowColor:     "#000",
    shadowOpacity:   0.15,
    shadowRadius:    8,
    shadowOffset:    { width: 0, height: 4 },
    elevation:       4,
  },
  submitText: {
    color:      "#FFF",
    fontSize:   15,
    fontWeight: "700",
  },
});