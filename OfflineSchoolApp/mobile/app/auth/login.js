// app/auth/login.js
//
// The photograph is a full-bleed background under a horizontal indigo scrim.
//
// The image is 3:2 landscape and a phone is about 0.45, so cover fills the
// HEIGHT and only the middle ~30% of the width survives: façade, with the
// OFFLINESCHOOL sign, the flag and the books all cropped away. Under a scrim
// this heavy that is the intent rather than a fault — the photograph is
// texture and brand colour here, not something to be read. What it must not
// do is make the form hard to read, which is what the scrim is for.
//
// The flat 62% wash it replaces dimmed everything by the same amount and
// left the picture grey. A tinted ramp keeps it indigo, and the form card
// sits on the darkest end of it.
import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ScrollView, ActivityIndicator, ImageBackground,
} from "react-native";
import { useRouter }    from "expo-router";
import { useAuthStore } from "../../src/store/auth.store";
import { useTranslation } from "../../src/i18n/useTranslation";

// The scrim across the screen — the same shape as before at about half the
// weight, so the building and the sign read as a photograph rather than as a
// dark blue texture.
const SCRIM_STOPS = [
  { at: 0,   rgb: [24, 20, 70],  alpha: 0.40 },
  { at: 0.5, rgb: [36, 30, 100], alpha: 0.32 },
  { at: 1,   rgb: [24, 20, 70],  alpha: 0.26 },
];

/**
 * A second scrim down the screen, and the reason the first one can be light.
 *
 * The header and the portal link are the only text not sitting on a card, so
 * they are the only text the photograph can defeat — and it nearly does at
 * this weight. Measured against the bright sky in the top of the frame, the
 * #E5E7EB subtitle falls to about 3.0:1 under the horizontal ramp alone,
 * where 15px text wants 4.5:1.
 *
 * Darkening everything to fix that is what the old flat 62% wash did, and it
 * costs the whole picture. Darkening the top and the foot instead costs the
 * sky and the paving, which is where nothing is happening. The two layers
 * compose to about 0.63 behind the header — comfortably legible — while the
 * middle of the screen keeps the 0.32 above.
 */
const EDGE_RGB = [24, 20, 70];
const edgeAlphaAt = (t) => {
  // Top: 0.62 at the very edge, straight down to nothing by 34%.
  //
  // Measured against the image rather than guessed at. The header sits over
  // open sky — rgb(178,209,231) where the subtitle falls — and at the 0.38
  // this replaces the subtitle came out at 3.15:1 against the 4.5:1 that 15px
  // text needs. Solving for the lightest curve that clears every threshold on
  // this photograph, with margin to survive another one, gives 0.62 over 34%.
  if (t < 0.34) return 0.62 * (1 - t / 0.34);
  // Foot: a lighter lift behind the parent-portal link.
  if (t > 0.78) return 0.52 * ((t - 0.78) / 0.22) ** 1.4;
  return 0;
};

/** The colour of the scrim at 0..1 across the screen. */
const scrimAt = (t) => {
  let i = 0;
  while (i < SCRIM_STOPS.length - 2 && t > SCRIM_STOPS[i + 1].at) i++;

  const from = SCRIM_STOPS[i];
  const to   = SCRIM_STOPS[i + 1];
  const span = to.at - from.at;
  const u    = span === 0 ? 0 : (t - from.at) / span;

  const [r, g, b] = from.rgb.map((c, k) => Math.round(c + (to.rgb[k] - c) * u));
  const alpha = (from.alpha + (to.alpha - from.alpha) * u).toFixed(3);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * A left-to-right gradient, drawn as columns.
 *
 * React Native has no CSS gradients, and expo-linear-gradient is a native
 * module — a dependency and a rebuild for one screen. Columns cost neither,
 * and at this width the step between them is about 0.008 of alpha and a
 * single unit of colour, which is below anything an eye resolves. Banding is
 * what makes this technique look cheap, and there is none at these deltas.
 */
const SCRIM_BANDS = 24;
const EDGE_BANDS  = 20;

const Scrim = () => (
  <>
    {/* Left to right: the brand ramp. */}
    <View style={styles.scrim} pointerEvents="none">
      {Array.from({ length: SCRIM_BANDS }, (_, i) => (
        // Sampled at the middle of each column, so the ramp is centred on the
        // band rather than starting one band late.
        <View
          key={i}
          style={{ flex: 1, backgroundColor: scrimAt((i + 0.5) / SCRIM_BANDS) }}
        />
      ))}
    </View>

    {/* Top to bottom: legibility for the two pieces of text that have no
        card under them. Fully transparent through the middle, so it takes
        nothing from the part of the picture anybody looks at. */}
    <View style={styles.scrimEdges} pointerEvents="none">
      {Array.from({ length: EDGE_BANDS }, (_, i) => {
        const a = edgeAlphaAt((i + 0.5) / EDGE_BANDS);
        return (
          <View
            key={i}
            style={{
              flex: 1,
              backgroundColor: `rgba(${EDGE_RGB[0]}, ${EDGE_RGB[1]}, ${EDGE_RGB[2]}, ${a.toFixed(3)})`,
            }}
          />
        );
      })}
    </View>
  </>
);
export default function LoginScreen() {
  const router    = useRouter();
  const login     = useAuthStore((s) => s.login);
  const error     = useAuthStore((s) => s.error);
  const isLoading = useAuthStore((s) => s.isLoading);
  const { t }     = useTranslation();

  const [identifier, setIdentifier] = useState("");
  const [password,   setPassword]   = useState("");
  const [showPass,   setShowPass]   = useState(false);

  const looksLikeEmail = identifier.includes("@");

  const handleLogin = async () => {
    const clean = identifier.trim();
    if (!clean || !password.trim()) return;

    const payload = clean.includes("@")
      ? { email:        clean.toLowerCase(), password: password.trim() }
      : { enrollmentNo: clean.toUpperCase(), password: password.trim() };

    const result  = await login(payload);
    const success = result === true || result?.success === true;
    if (!success) return;

    router.replace("/");
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ImageBackground
        source={require("../../assets/login-bg.jpg")}
        resizeMode="cover"
        style={styles.background}
      >
        <Scrim />
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.emoji}>🏫</Text>
          <Text style={styles.title}>{t("login.appName")}</Text>
          <Text style={styles.subtitle}>{t("login.signInToAccount")}</Text>
        </View>

        {/* ── Form ── */}
        <View style={styles.card}>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          ) : null}

          {/* Identifier field */}
          <Text style={styles.label}>{t("login.identifier")}</Text>
          <TextInput
            style={styles.input}
            value={identifier}
            onChangeText={setIdentifier}
            placeholder={t("login.identifierPh")}
            placeholderTextColor="#9CA3AF"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <Text style={styles.hint}>
            {identifier.length === 0
              ? `💡 ${t("login.identifierHint")}`
              : looksLikeEmail
                ? `✓ ${t("login.asStaff")}`
                : `✓ ${t("login.asStudent")}`}
          </Text>

          {/* Password */}
          <Text style={styles.label}>{t("login.password")}</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor="#9CA3AF"
              secureTextEntry={!showPass}
              autoCapitalize="none"
            />
            <TouchableOpacity
              style={styles.eyeBtn}
              onPress={() => setShowPass((v) => !v)}
            >
              <Text style={styles.eyeText}>{showPass ? "🙈" : "👁️"}</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.forgotNote}>
            {looksLikeEmail
              ? t("login.forgotStaff")
              : t("login.forgotStudent")}
          </Text>

          <TouchableOpacity
            style={[styles.loginBtn, isLoading && styles.loginBtnDisabled]}
            onPress={handleLogin}
            disabled={isLoading}
          >
            {isLoading
              ? <ActivityIndicator color="#FFF" />
              : <Text style={styles.loginBtnText}>{t("login.submit")}</Text>
            }
          </TouchableOpacity>
        </View>

        {/* ── Divider ── */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>{t("login.or")}</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* ── Apply CTA ── */}
        <View style={styles.applyCard}>
          <Text style={styles.applyTitle}>{t("login.newStudent")}</Text>
          <Text style={styles.applySubtitle}>
            {t("login.applyBlurb")}
          </Text>
          <TouchableOpacity
            style={styles.applyBtn}
            onPress={() => router.push("/auth/select-school")}
          >
            <Text style={styles.applyBtnText}>{t("login.applyCta")} →</Text>
          </TouchableOpacity>
        </View>

        {/* ── Parent portal ──
            A guardian has no account here — they sign in with their child's
            admission number and a code from the school office, so this is a
            separate door rather than another way through this form. */}
        <TouchableOpacity
          style={styles.portalLink}
          onPress={() => router.push("/portal")}
        >
          <Text style={styles.portalLinkText}>{t("login.parentPortal")}</Text>
        </TouchableOpacity>
        </ScrollView>
      </ImageBackground>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // The deepest stop of the scrim, so the gap a short page leaves below the
  // image is the same colour as the screen rather than a black strip.
  container: { flex: 1, backgroundColor: "#181446" },
  background: { flex: 1 },

  // A row, because the ramp runs left to right.
  scrim: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
  },

  // A column, over the top of it.
  scrimEdges: StyleSheet.absoluteFillObject,

  scroll:    { padding: 24, paddingTop: 60 },

  portalLink:     { marginTop: 18, alignItems: "center", paddingVertical: 10 },
  portalLinkText: {
    color: "#DDE3FF", fontSize: 14, fontWeight: "600",
    textShadowColor:  "rgba(12, 10, 40, 0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },

  header:    { alignItems: "center", marginBottom: 32 },
  emoji:     { fontSize: 48, marginBottom: 8 },

  // The shadow is not decoration. These two lines sit on the photograph, and
  // a shadow keeps them readable against whatever image is dropped in next —
  // which a contrast figure measured against today's sky does not.
  title: {
    fontSize: 28, fontWeight: "800", color: "#FFFFFF",
    textShadowColor:  "rgba(12, 10, 40, 0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  subtitle: {
    // White, not near-white: 15px is the smallest unprotected text here and
    // needs every point of contrast it can get.
    fontSize: 15, color: "#FFFFFF", marginTop: 4,
    textShadowColor:  "rgba(12, 10, 40, 0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },

  card: {
    backgroundColor: "#FFF",
    borderRadius:    16,
    padding:         24,
    shadowColor:     "#000",
    shadowOpacity:   0.06,
    shadowRadius:    12,
    elevation:       3,
    marginBottom:    24,
  },

  errorBox: {
    backgroundColor: "#FEF2F2",
    borderRadius:    8,
    padding:         12,
    marginBottom:    16,
  },
  errorText: { color: "#DC2626", fontSize: 13 },

  label: {
    fontSize:     13,
    fontWeight:   "600",
    color:        "#374151",
    marginBottom: 6,
  },

  input: {
    borderWidth:     1,
    borderColor:     "#E5E7EB",
    borderRadius:    10,
    padding:         12,
    fontSize:        15,
    color:           "#111827",
    backgroundColor: "#F9FAFB",
    marginBottom:    8,
  },

  hint: {
    fontSize:     12,
    color:        "#6B7280",
    marginBottom: 18,
    lineHeight:   18,
  },

  passwordRow:  { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  eyeBtn:       { padding: 12, marginLeft: 8 },
  eyeText:      { fontSize: 18 },

  forgotNote: {
    fontSize:     12,
    color:        "#6B7280",
    marginBottom: 20,
    lineHeight:   18,
  },

  loginBtn:         { backgroundColor: "#4F46E5", borderRadius: 12, padding: 14, alignItems: "center" },
  loginBtnDisabled: { opacity: 0.6 },
  loginBtnText:     { color: "#FFF", fontSize: 16, fontWeight: "700" },

  dividerRow:  { flexDirection: "row", alignItems: "center", marginBottom: 24 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#E5E7EB" },
  dividerText: {
    // Was #9CA3AF, chosen for a dark wash. On a light photograph mid-grey is
    // the one colour guaranteed to disappear, whichever way the image goes.
    //
    // It carries its own backing rather than leaning on the scrim, because it
    // sits halfway down the screen — the one place the scrim is deliberately
    // at its lightest. A chip fixes the contrast locally and costs the picture
    // the width of one word.
    marginHorizontal: 12,
    color:            "#EEF0F4",
    fontSize:         13,
    overflow:         "hidden",
    borderRadius:     10,
    paddingHorizontal: 10,
    paddingVertical:   2,
    backgroundColor:  "rgba(24, 20, 70, 0.55)",
  },

  applyCard: {
    backgroundColor: "#EEF2FF",
    borderRadius:    16,
    padding:         24,
    borderWidth:     1,
    borderColor:     "#C7D2FE",
  },
  applyTitle:    { fontSize: 18, fontWeight: "700", color: "#3730A3", marginBottom: 8 },
  applySubtitle: { fontSize: 13, color: "#4338CA", lineHeight: 20, marginBottom: 16 },
  applyBtn:      { backgroundColor: "#4F46E5", borderRadius: 10, padding: 14, alignItems: "center" },
  applyBtnText:  { color: "#FFF", fontSize: 15, fontWeight: "700" },
});