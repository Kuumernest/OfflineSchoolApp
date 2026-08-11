// app/admin/reports/templates/index.js
"use strict";

import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Alert, ActivityIndicator, RefreshControl,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons }        from "@expo/vector-icons";
import { useAuthStore }    from "../../../../src/store/auth.store";
import { TemplateService } from "../../../../src/services/template.service";

// ─────────────────────────────────────────────────────────
// COLORS
// ─────────────────────────────────────────────────────────

const C = {
  primary:   "#2563EB",
  primaryBg: "#EFF6FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  warning:   "#D97706",
  error:     "#DC2626",
  purple:    "#7C3AED",
  purpleBg:  "#F5F3FF",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray700:   "#374151",
  gray900:   "#111827",
};

// ─────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────

export default function TemplatesScreen() {
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [templates,  setTemplates]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Load ──────────────────────────────────────────────
  const load = useCallback(async (isRefresh = false) => {
    try {
      isRefresh ? setRefreshing(true) : setLoading(true);
      const data = await TemplateService.getAll(schoolId);
      setTemplates(data);
    } catch (err) {
      Alert.alert("Error", err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Set default ───────────────────────────────────────
  const handleSetDefault = useCallback((id, name) => {
    Alert.alert(
      "Set as Default",
      `Use "${name}" as the default template for all reports?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Set Default",
          onPress: async () => {
            try {
              await TemplateService.setDefault(id);
              load();
            } catch (err) {
              Alert.alert("Error", err?.response?.data?.error || err.message);
            }
          },
        },
      ]
    );
  }, [load]);

  // ── Duplicate ─────────────────────────────────────────
  const handleDuplicate = useCallback(async (id) => {
    try {
      await TemplateService.duplicate(id, schoolId);
      load();
    } catch (err) {
      Alert.alert("Error", err?.response?.data?.error || err.message);
    }
  }, [schoolId, load]);

  // ── Delete ────────────────────────────────────────────
  const handleDelete = useCallback((id, name, isDefault) => {
    if (isDefault) {
      Alert.alert(
        "Cannot Delete",
        "This is your default template. Set another template as default first."
      );
      return;
    }
    Alert.alert(
      "Delete Template",
      `Delete "${name}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text:  "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await TemplateService.delete(id);
              load();
            } catch (err) {
              Alert.alert("Error", err?.response?.data?.error || err.message);
            }
          },
        },
      ]
    );
  }, [load]);

  if (loading) {
    return (
      <View style={s.screen}>
        <Header />
        <View style={s.centered}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadingText}>Loading templates…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Header />

      <View style={s.banner}>
        <Ionicons name="information-circle-outline" size={18} color={C.primary} />
        <Text style={s.bannerText}>
          Paste any HTML layout here. Set one as default and it will be
          used automatically when generating reports.
        </Text>
      </View>

      <FlatList
        data={templates}
        keyExtractor={(item) => String(item._id)}
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            colors={[C.primary]}
            tintColor={C.primary}
          />
        }
        ListEmptyComponent={<EmptyState />}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item }) => (
          <TemplateCard
            item={item}
            onEdit={() =>
              router.push({
                pathname: "/admin/reports/templates/builder",
                params:   { templateId: item._id },
              })
            }
            onPreview={() =>
              router.push({
                pathname: "/admin/reports/templates/preview",
                params:   { templateId: item._id },
              })
            }
            onSetDefault={() => handleSetDefault(item._id, item.name)}
            onDuplicate={() => handleDuplicate(item._id)}
            onDelete={() => handleDelete(item._id, item.name, item.isDefault)}
          />
        )}
      />

      <TouchableOpacity
        style={s.fab}
        onPress={() => router.push("/admin/reports/templates/builder")}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={28} color={C.white} />
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

function Header() {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
        <Ionicons name="arrow-back" size={24} color={C.gray900} />
      </TouchableOpacity>
      <View style={s.headerCenter}>
        <Text style={s.headerTitle}>Report Templates</Text>
        <Text style={s.headerSub}>Manage your report card designs</Text>
      </View>
      <TouchableOpacity
        style={s.newBtn}
        onPress={() => router.push("/admin/reports/templates/builder")}
      >
        <Ionicons name="add" size={18} color={C.white} />
        <Text style={s.newBtnText}>New</Text>
      </TouchableOpacity>
    </View>
  );
}

function TemplateCard({
  item, onEdit, onPreview, onSetDefault, onDuplicate, onDelete,
}) {
  return (
    <View style={[s.card, item.isDefault && s.cardDefault]}>
      <View style={s.cardTop}>
        <View style={[
          s.cardIcon,
          { backgroundColor: item.isDefault ? C.primaryBg : C.gray100 },
        ]}>
          <Ionicons
            name="document-text"
            size={24}
            color={item.isDefault ? C.primary : C.gray400}
          />
        </View>
        <View style={{ flex: 1 }}>
          <View style={s.cardTitleRow}>
            <Text style={s.cardName} numberOfLines={1}>{item.name}</Text>
            {item.isDefault && (
              <View style={s.defaultBadge}>
                <Ionicons name="star" size={10} color={C.primary} />
                <Text style={s.defaultBadgeText}>Default</Text>
              </View>
            )}
          </View>
          <Text style={s.cardMeta}>
            Version {item.version || 1}
            {item.variables?.length
              ? `  •  ${item.variables.length} placeholders`
              : ""}
          </Text>
        </View>
      </View>

      {item.variables?.length > 0 && (
        <View style={s.varsRow}>
          {item.variables.slice(0, 4).map((v, i) => (
            <View key={i} style={s.varChip}>
              <Text style={s.varChipText} numberOfLines={1}>{v}</Text>
            </View>
          ))}
          {item.variables.length > 4 && (
            <View style={s.varChip}>
              <Text style={s.varChipText}>
                +{item.variables.length - 4} more
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={s.cardActions}>
        <ActionBtn icon="eye-outline"    label="Preview" color={C.gray700} onPress={onPreview}    />
        <ActionBtn icon="create-outline" label="Edit"    color={C.primary} onPress={onEdit}       />
        {!item.isDefault && (
          <ActionBtn icon="star-outline" label="Default" color={C.warning} onPress={onSetDefault} />
        )}
        <ActionBtn icon="copy-outline"   label="Copy"   color={C.purple}  onPress={onDuplicate}  />
        <ActionBtn icon="trash-outline"  label="Delete" color={C.error}   onPress={onDelete}     />
      </View>
    </View>
  );
}

function ActionBtn({ icon, label, color, onPress }) {
  return (
    <TouchableOpacity
      style={[s.actionBtn, { borderColor: color + "30" }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons name={icon} size={15} color={color} />
      <Text style={[s.actionBtnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function EmptyState() {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Ionicons name="document-text-outline" size={48} color={C.gray300} />
      </View>
      <Text style={s.emptyTitle}>No Templates Yet</Text>
      <Text style={s.emptyBody}>
        Create your first report card template by pasting your
        school's HTML layout.
      </Text>
      <TouchableOpacity
        style={s.emptyBtn}
        onPress={() => router.push("/admin/reports/templates/builder")}
        activeOpacity={0.8}
      >
        <Ionicons name="add-circle-outline" size={18} color={C.white} />
        <Text style={s.emptyBtnText}>Create Template</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: C.gray50 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: C.gray500 },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     14,
    backgroundColor:   C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.gray100,
    gap:               10,
  },
  backBtn: {
    width:           40,
    height:          40,
    borderRadius:    12,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },
  newBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   C.primary,
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   8,
  },
  newBtnText: { fontSize: 13, fontWeight: "700", color: C.white },
  banner: {
    flexDirection:     "row",
    alignItems:        "flex-start",
    gap:               8,
    backgroundColor:   C.primaryBg,
    margin:            16,
    borderRadius:      10,
    padding:           12,
    borderWidth:       1,
    borderColor:       C.primary + "30",
  },
  bannerText: { fontSize: 12, color: C.primary, flex: 1, lineHeight: 18 },
  list:        { paddingHorizontal: 16, paddingBottom: 100 },
  card: {
    backgroundColor: C.white,
    borderRadius:    14,
    padding:         14,
    gap:             12,
    borderWidth:     1,
    borderColor:     C.gray200,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    6,
    elevation:       2,
  },
  cardDefault:  { borderColor: C.primary, borderWidth: 1.5 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardIcon: {
    width:           48,
    height:          48,
    borderRadius:    12,
    alignItems:      "center",
    justifyContent:  "center",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    flexWrap:      "wrap",
  },
  cardName: { fontSize: 15, fontWeight: "700", color: C.gray900, flex: 1 },
  defaultBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
    backgroundColor:   C.primaryBg,
    borderRadius:      6,
    paddingHorizontal: 7,
    paddingVertical:   3,
  },
  defaultBadgeText: { fontSize: 10, fontWeight: "700", color: C.primary },
  cardMeta:         { fontSize: 11, color: C.gray500, marginTop: 2 },
  varsRow:          { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  varChip: {
    backgroundColor:   C.gray100,
    borderRadius:      4,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  varChipText:  { fontSize: 10, color: C.gray500, fontFamily: "monospace" },
  cardActions:  { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  actionBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   6,
    borderRadius:      8,
    borderWidth:       1,
    backgroundColor:   C.gray50,
  },
  actionBtnText: { fontSize: 11, fontWeight: "600" },
  empty: {
    alignItems:        "center",
    paddingVertical:   60,
    paddingHorizontal: 32,
    gap:               12,
  },
  emptyIcon: {
    width:           90,
    height:          90,
    borderRadius:    45,
    backgroundColor: C.gray100,
    alignItems:      "center",
    justifyContent:  "center",
    marginBottom:    4,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: C.gray700 },
  emptyBody: {
    fontSize:   13,
    color:      C.gray500,
    textAlign:  "center",
    lineHeight: 20,
  },
  emptyBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               8,
    backgroundColor:   C.primary,
    borderRadius:      12,
    paddingHorizontal: 20,
    paddingVertical:   12,
    marginTop:         8,
  },
  emptyBtnText: { fontSize: 14, fontWeight: "700", color: C.white },
  fab: {
    position:        "absolute",
    bottom:          30,
    right:           20,
    width:           58,
    height:          58,
    borderRadius:    29,
    backgroundColor: C.primary,
    alignItems:      "center",
    justifyContent:  "center",
    shadowColor:     C.primary,
    shadowOpacity:   0.4,
    shadowRadius:    10,
    elevation:       6,
  },
});