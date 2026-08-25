// mobile/src/components/DateField.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED DATE FIELD — native calendar picker, never a text input
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One implementation of the "tap to pick a date" field, extracted from the
 * student/teacher profile setups where it was duplicated. Forms hand it a
 * YYYY-MM-DD string value and get a YYYY-MM-DD string back — storage and API
 * formats stay unchanged, only the entry method becomes a real picker.
 *
 *   Android: native inline calendar dialog.
 *   iOS:     spinner inside a bottom sheet with Cancel / Done.
 *
 * Props:
 *   label, value ("YYYY-MM-DD"), onChange(ymd), required, error, hint,
 *   maximumDate, minimumDate
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, Modal, StyleSheet, Platform,
} from "react-native";
import DateTimePicker      from "@react-native-community/datetimepicker";
import { Ionicons }        from "@expo/vector-icons";

const C = {
  primary: "#4F46E5",
  error:   "#DC2626",
  white:   "#FFFFFF",
  gray100: "#F3F4F6",
  gray200: "#E5E7EB",
  gray400: "#9CA3AF",
  gray700: "#374151",
  gray900: "#111827",
};

// ── Date helpers ─────────────────────────────────────────────────────────────

const toYMD = (date) => {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const toDisplay = (date) => {
  if (!date) return "";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

const parseYMD = (str) => {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date();
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// ── Component ────────────────────────────────────────────────────────────────

export default function DateField({
  label,
  value,
  onChange,
  required,
  error,
  hint,
  maximumDate,
  minimumDate,
}) {
  const [show,     setShow]     = useState(false);
  const [tempDate, setTempDate] = useState(() =>
    value ? parseYMD(value) : new Date()
  );

  useEffect(() => {
    setTempDate(value ? parseYMD(value) : new Date());
  }, [value]);

  const pickerDate  = value ? parseYMD(value) : new Date();
  const displayText = value ? toDisplay(parseYMD(value)) : null;

  const openPicker = () => { setTempDate(pickerDate); setShow(true); };
  const dismiss    = () => setShow(false);

  // Android — native inline picker
  const onAndroidChange = (_event, selectedDate) => {
    setShow(false);
    if (selectedDate) onChange(toYMD(selectedDate));
  };

  // iOS — spinner inside bottom-sheet modal
  const onIOSChange = (_event, selectedDate) => {
    if (selectedDate) setTempDate(selectedDate);
  };

  const confirmIOS = () => { onChange(toYMD(tempDate)); setShow(false); };

  const TriggerBtn = (
    <TouchableOpacity
      style={[dp.inputWrap, !!error && dp.inputError]}
      onPress={openPicker}
      activeOpacity={0.7}
    >
      <Ionicons
        name="calendar-outline"
        size={18}
        color={displayText ? C.primary : C.gray400}
      />
      <View style={dp.textBlock}>
        <Text style={[dp.inputText, !displayText && dp.placeholder]}>
          {displayText || "Select date"}
        </Text>
        {!!displayText && <Text style={dp.rawDate}>{value}</Text>}
      </View>
      <Ionicons name="chevron-down" size={16} color={C.gray400} />
    </TouchableOpacity>
  );

  if (Platform.OS === "android") {
    return (
      <View style={dp.wrap}>
        <Text style={dp.label}>
          {label}{required && <Text style={{ color: C.error }}> *</Text>}
        </Text>
        {TriggerBtn}
        {!!hint  && !error && <Text style={dp.hint}>{hint}</Text>}
        {!!error            && <Text style={dp.errorText}>{error}</Text>}
        {show && (
          <DateTimePicker
            value={pickerDate}
            mode="date"
            display="default"
            maximumDate={maximumDate}
            minimumDate={minimumDate}
            onChange={onAndroidChange}
          />
        )}
      </View>
    );
  }

  return (
    <View style={dp.wrap}>
      <Text style={dp.label}>
        {label}{required && <Text style={{ color: C.error }}> *</Text>}
      </Text>
      {TriggerBtn}
      {!!hint  && !error && <Text style={dp.hint}>{hint}</Text>}
      {!!error            && <Text style={dp.errorText}>{error}</Text>}
      <Modal
        visible={show}
        transparent
        animationType="slide"
        onRequestClose={dismiss}
      >
        <TouchableOpacity
          style={dp.modalOverlay}
          activeOpacity={1}
          onPress={dismiss}
        />
        <View style={dp.modalSheet}>
          <View style={dp.sheetHeader}>
            <TouchableOpacity onPress={dismiss} hitSlop={8}>
              <Text style={dp.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dp.sheetTitle}>{label}</Text>
            <TouchableOpacity onPress={confirmIOS} hitSlop={8}>
              <Text style={dp.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
          <DateTimePicker
            value={tempDate}
            mode="date"
            display="spinner"
            maximumDate={maximumDate}
            minimumDate={minimumDate}
            onChange={onIOSChange}
            style={dp.picker}
          />
          <View style={dp.previewRow}>
            <Ionicons name="calendar-outline" size={15} color={C.primary} />
            <Text style={dp.previewText}>
              {toDisplay(tempDate)}
              <Text style={dp.previewRaw}>{"  "}({toYMD(tempDate)})</Text>
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const dp = StyleSheet.create({
  wrap:         { marginBottom: 16 },
  label:        { fontSize: 13, fontWeight: "600", color: C.gray700, marginBottom: 6 },
  inputWrap:    { flexDirection: "row", alignItems: "center", borderWidth: 1.5, borderColor: C.gray200, borderRadius: 12, backgroundColor: C.white, paddingHorizontal: 12, paddingVertical: 12, gap: 8 },
  inputError:   { borderColor: C.error },
  textBlock:    { flex: 1 },
  inputText:    { fontSize: 14, color: C.gray900, fontWeight: "500" },
  placeholder:  { color: C.gray400, fontWeight: "400" },
  rawDate:      { fontSize: 11, color: C.gray400, marginTop: 1 },
  hint:         { fontSize: 11, color: C.gray400, marginTop: 4 },
  errorText:    { fontSize: 11, color: C.error, marginTop: 4, fontWeight: "500" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  modalSheet:   { backgroundColor: C.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 34 },
  sheetHeader:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.gray100 },
  sheetTitle:   { fontSize: 15, fontWeight: "700", color: C.gray900 },
  cancelText:   { fontSize: 15, color: C.gray500 },
  doneText:     { fontSize: 15, color: C.primary, fontWeight: "700" },
  picker:       { width: "100%", backgroundColor: C.white },
  previewRow:   { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 8 },
  previewText:  { fontSize: 14, color: C.gray700, fontWeight: "600" },
  previewRaw:   { fontSize: 12, color: C.gray400, fontWeight: "400" },
});

