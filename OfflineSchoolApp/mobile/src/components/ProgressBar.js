// src/components/ProgressBar.js
"use strict";

/**
 * Determinate progress for work that runs long enough to watch.
 *
 * An ActivityIndicator says "something is happening". It cannot say how much
 * is left, so it cannot answer the only question the person holding the phone
 * has — wait, or put it in a pocket and come back. On a school's connection
 * that difference is minutes. Where the count is known, this shows it: a
 * percentage, the running tally, and the name of the item in flight.
 *
 * The percentage is never invented. Without a total it sweeps instead of
 * filling, promising nothing: a made-up number that parks at 90% costs more
 * than an honest sweep, because after seeing it once nobody believes the
 * first 90% either.
 *
 *   <ProgressBar done={7} total={40} label="Generating report cards"
 *                detail="Ateba Marie" />
 *   <ProgressBar label="Uploading" />        // indeterminate
 */

import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, Animated, Easing, AccessibilityInfo,
} from "react-native";

const C = {
  track: "#E5E7EB",
  fill:  "#4F46E5",
  label: "#6B7280",
  value: "#111827",
};

export const ProgressBar = ({
  done = 0,
  total = 0,
  label,
  detail,
  hideCount = false,
  color = C.fill,
  // Overridable because this also renders on the coloured sync strip,
  // where the default indigo-on-grey is invisible and the near-black
  // label is unreadable.
  trackColor = C.track,
  textColor,
  style,
}) => {
  const determinate = Number(total) > 0;

  // Clamped: a caller that reports `done` after an early continue can
  // overshoot, and a fill wider than its track escapes the rounded corners.
  const pct = determinate
    ? Math.min(100, Math.max(0, Math.round((Number(done) / Number(total)) * 100)))
    : 0;

  // Hooks run unconditionally, before any early return — the indeterminate
  // branch is decided in the render, not by skipping a hook.
  const sweep = useRef(new Animated.Value(0)).current;
  const fill  = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((on) => { if (alive) setReduceMotion(Boolean(on)); })
      .catch(() => { /* older platforms simply do not answer */ });
    return () => { alive = false; };
  }, []);

  // The sweep, for the indeterminate case only.
  useEffect(() => {
    if (determinate || reduceMotion) return undefined;
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue:         1,
        duration:        1400,
        easing:          Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [determinate, reduceMotion, sweep]);

  // Animate the fill rather than jumping it, so a batch that finishes several
  // items between renders still reads as movement.
  useEffect(() => {
    if (!determinate) return undefined;
    const anim = Animated.timing(fill, {
      toValue:         pct,
      duration:        reduceMotion ? 0 : 250,
      easing:          Easing.out(Easing.ease),
      // width is not a transform, so this one cannot use the native driver.
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [determinate, pct, reduceMotion, fill]);

  return (
    <View style={[styles.wrap, style]}>
      {(label || determinate) && (
        <View style={styles.head}>
          {label ? (
            <Text
              style={[styles.label, textColor ? { color: textColor } : null]}
              numberOfLines={1}
            >{label}</Text>
          ) : <View />}

          {determinate && (
            <Text style={[styles.value, textColor ? { color: textColor } : null]}>
              {pct}%
              {!hideCount && (
                <Text
                  style={[styles.count, textColor ? { color: textColor, opacity: 0.85 } : null]}
                >{`  ${done} / ${total}`}</Text>
              )}
            </Text>
          )}
        </View>
      )}

      <View
        style={[styles.track, { backgroundColor: trackColor }]}
        accessible
        accessibilityLabel={label}
        accessibilityRole="progressbar"
        // An indeterminate bar reports only that it is busy: no `now`, which
        // is how a screen reader is told the total is unknown.
        accessibilityValue={
          determinate ? { min: 0, max: 100, now: pct } : {}
        }
      >
        {determinate ? (
          <Animated.View
            style={[
              styles.fill,
              {
                backgroundColor: color,
                width: fill.interpolate({
                  inputRange:  [0, 100],
                  outputRange: ["0%", "100%"],
                }),
              },
            ]}
          />
        ) : reduceMotion ? (
          <View style={[styles.fill, { backgroundColor: color, width: "100%", opacity: 0.45 }]} />
        ) : (
          <Animated.View
            style={[
              styles.fill,
              {
                backgroundColor: color,
                width: "35%",
                transform: [{
                  translateX: sweep.interpolate({
                    inputRange:  [0, 1],
                    // Percentages are not accepted by translateX, so the sweep
                    // is expressed against a nominal track width. It overshoots
                    // on a wide tablet, which the track's overflow hides.
                    outputRange: [-140, 420],
                  }),
                }],
              },
            ]}
          />
        )}
      </View>

      {detail ? (
        <Text
          style={[styles.detail, textColor ? { color: textColor, opacity: 0.85 } : null]}
          numberOfLines={1}
        >{detail}</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { width: "100%" },
  head: {
    flexDirection:  "row",
    alignItems:     "baseline",
    justifyContent: "space-between",
    gap:            12,
    marginBottom:   6,
  },
  label:  { flex: 1, fontSize: 12, color: C.label },
  value:  { fontSize: 12, fontWeight: "700", color: C.value, fontVariant: ["tabular-nums"] },
  count:  { fontWeight: "400", color: C.label },
  track: {
    height:          8,
    borderRadius:    4,
    backgroundColor: C.track,
    overflow:        "hidden",
  },
  fill:   { height: 8, borderRadius: 4 },
  detail: { marginTop: 6, fontSize: 12, color: C.label },
});

export default ProgressBar;
