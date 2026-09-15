// mobile/src/components/MarkInputRow.js

import React, { memo, useCallback, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";

/**
 * One student's row on a marks-entry screen: name, ABS toggle, mark box.
 *
 * ── The box owns its text ───────────────────────────────────────────────────
 *
 * What the teacher is typing lives in this row's own `draft` state and is on
 * screen the moment the key lands. It reaches the screen's `scores` through
 * `onDraft`, which is a ref write and a 200 ms timer — see useMarkDrafts for
 * the whole story. The screen never controls the box's text while it is being
 * typed into, so no slow render up there can push a stale value back down.
 *
 * ── The box never changes shape while typing ────────────────────────────────
 *
 * With `selectTextOnFocus`, Android's ReactEditText selects everything on the
 * first layout pass that happens while it is focused (ReactEditText.kt,
 * onLayout). The old row thickened the border from 1 to 1.5 and added a "%"
 * badge the moment a digit arrived — a layout pass, so the first digit got
 * selected and the second replaced it: "16" became "6". Here the border keeps
 * one width and only changes colour, and the badge line is always there,
 * blank when there is nothing to say, so nothing about the box's frame depends
 * on what has been typed.
 *
 * ── Memoised ────────────────────────────────────────────────────────────────
 *
 * A keystroke in one row re-renders that row and nothing else. Every prop is a
 * primitive, a module-level object or a stable callback, so the shallow
 * comparison holds. A screen that passes a fresh object or closure per render
 * silently switches the whole list back on; check-marks-entry.js counts.
 */

const identity = (v) => v;

function MarkInputRowInner({
  student, score, isAbsent, generation, maxScore,
  styles, rateColor, neutralColor, placeholderTextColor,
  absLabel, unknownName,
  sanitize = identity,
  onDraft, onToggleAbsent, onBlur, onSubmit, registerInput, readPending,
}) {
  const sid = student._id;

  // Seeded from anything typed before this row was last mounted — a fast
  // scroll can recycle a row inside the commit delay — else from the
  // committed mark.
  const [draft, setDraft] = useState(() => readPending?.(sid) ?? score);

  // Adopt the committed mark only when the sheet was replaced or this row's
  // absent state flipped. Never on a plain change to `score`: that is usually
  // this row's own typing arriving back, and the teacher may have typed more.
  const adoptKey = `${generation}|${isAbsent}`;
  const [seenKey, setSeenKey] = useState(adoptKey);
  if (seenKey !== adoptKey) {
    setSeenKey(adoptKey);
    setDraft(score);
  }

  // Display only. The mark stays text until the save converts it.
  const numScore = !isAbsent && draft !== "" ? Number(draft) : null;
  const scorePct = numScore !== null ? Math.round((numScore / maxScore) * 100) : null;
  const color    = scorePct !== null ? rateColor(scorePct) : neutralColor;

  const handleChange = useCallback((v) => {
    if (isAbsent) return;
    const text = sanitize(v);
    setDraft(text);
    onDraft(sid, text);
  }, [isAbsent, sanitize, onDraft, sid]);

  return (
    <View style={[styles.row, isAbsent && styles.rowAbsent]}>
      <View style={[styles.avatar, { backgroundColor: color + "20" }]}>
        <Text style={[styles.avatarText, { color }]}>
          {(student.studentName || "?").charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {student.studentName || unknownName}
        </Text>
        <Text style={styles.sub}>
          {student.admissionNo ? `#${student.admissionNo}` : student.email || ""}
        </Text>
      </View>
      <TouchableOpacity
        style={[styles.absBtn, isAbsent && styles.absBtnActive]}
        onPress={() => onToggleAbsent(sid)}
        activeOpacity={0.7}
      >
        <Text style={[styles.absBtnText, isAbsent && styles.absBtnTextActive]}>
          {absLabel}
        </Text>
      </TouchableOpacity>
      <View style={styles.scoreWrap}>
        <TextInput
          ref={registerInput ? (el) => registerInput(sid, el) : undefined}
          testID={`mark-${sid}`}
          style={[
            styles.scoreInput,
            isAbsent && styles.scoreInputAbsent,
            scorePct !== null && { borderColor: color },
          ]}
          value={isAbsent ? absLabel : draft}
          onChangeText={handleChange}
          onBlur={onBlur}
          keyboardType="numeric"
          editable={!isAbsent}
          placeholder="—"
          placeholderTextColor={placeholderTextColor}
          selectTextOnFocus
          maxLength={5}
          {...(onSubmit
            ? {
                returnKeyType:   "next",
                onSubmitEditing: () => onSubmit(sid),
                blurOnSubmit:    false,
              }
            : {})}
        />
        <Text style={[styles.scorePct, { color }]}>
          {scorePct !== null ? `${scorePct}%` : " "}
        </Text>
      </View>
    </View>
  );
}

export const MarkInputRow = memo(MarkInputRowInner);
export default MarkInputRow;
