// app/admin/settings/index.js

import React, {
  useState,
  useEffect,
  useCallback,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  StatusBar,
  Switch,
  Modal,
  Image,
  Platform,
} from "react-native";
import { Ionicons }        from "@expo/vector-icons";
import { useRouter }       from "expo-router";
import * as ImagePicker    from "expo-image-picker";
import { useAuthStore }    from "../../../src/store/auth.store";
import {
  fetchProfile,
  updateProfile,
  changePassword,
  fetchGradingConfig,
  saveGradingConfig,
  fetchAdmins,
  createAdmin,
  removeAdmin,
  fetchAnalytics,
  fetchSchoolSettings,
  saveSchoolSettings,
} from "../../../src/services/settings.service";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "school",    label: "School",           icon: "business-outline"      },
  { id: "profile",   label: "My Profile",       icon: "person-circle-outline" },
  { id: "grading",   label: "Grading System",   icon: "school-outline"        },
  { id: "admins",    label: "Admin Management", icon: "shield-outline"        },
  { id: "analytics", label: "Analytics",        icon: "bar-chart-outline"     },
];

const ROLE_LABELS = {
  super_admin:  "Super Admin",
  school_admin: "School Admin",
  admin:        "Admin",
  teacher:      "Teacher",
};

const ROLE_COLORS = {
  super_admin:  "#DC2626",
  school_admin: "#7C3AED",
  admin:        "#4F46E5",
  teacher:      "#059669",
};

const SCHOOL_TYPES = [
  { value: "primary",    label: "Primary"         },
  { value: "jhs",        label: "JHS"             },
  { value: "shs",        label: "SHS / Secondary" },
  { value: "combined",   label: "Combined"        },
  { value: "vocational", label: "Vocational"      },
  { value: "university", label: "University"      },
  { value: "other",      label: "Other"           },
];

const TERM_SYSTEMS = [
  { value: "trimester", label: "Trimester (3 Terms)" },
  { value: "semester",  label: "Semester (2 Terms)"  },
  { value: "quarter",   label: "Quarter (4 Terms)"   },
];

const DAYS_OF_WEEK = [
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday",
];

// ─────────────────────────────────────────────────────────
// LOGO FORMAT HELPER
// ─────────────────────────────────────────────────────────

const normaliseLogo = (raw) => {
  if (!raw || typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("http")) return trimmed;
  if (trimmed.startsWith("data:")) return trimmed;
  const mimeType = trimmed.startsWith("iVBOR") ? "image/png" : "image/jpeg";
  return `data:${mimeType};base64,${trimmed}`;
};

// ─────────────────────────────────────────────────────────
// SHARED SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

const SectionTab = React.memo(({ section, active, onPress }) => (
  <TouchableOpacity
    style={[styles.tab, active && styles.tabActive]}
    onPress={onPress}
    activeOpacity={0.75}
  >
    <Ionicons
      name={section.icon}
      size={18}
      color={active ? "#4F46E5" : "#9CA3AF"}
    />
    <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
      {section.label}
    </Text>
  </TouchableOpacity>
));

const SettingRow = React.memo(({ label, children, hint }) => (
  <View style={styles.settingRow}>
    <Text style={styles.settingLabel}>{label}</Text>
    {children}
    {!!hint && <Text style={styles.settingHint}>{hint}</Text>}
  </View>
));

const Card = React.memo(({ children, style }) => (
  <View style={[styles.card, style]}>{children}</View>
));

// ─────────────────────────────────────────────────────────
// SCHOOL SECTION
// ─────────────────────────────────────────────────────────

const SchoolSection = ({ schoolId }) => {
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  const [name,          setName]          = useState("");
  const [motto,         setMotto]         = useState("");
  const [email,         setEmail]         = useState("");
  const [phone,         setPhone]         = useState("");
  const [website,       setWebsite]       = useState("");
  const [address,       setAddress]       = useState("");
  const [city,          setCity]          = useState("");
  const [state,         setState]         = useState("");
  const [country,       setCountry]       = useState("");
  const [postalCode,    setPostalCode]    = useState("");
  const [schoolType,    setSchoolType]    = useState("primary");
  const [termSystem,    setTermSystem]    = useState("trimester");
  const [schoolCode,    setSchoolCode]    = useState("");
  const [regNumber,     setRegNumber]     = useState("");
  const [foundedYear,   setFoundedYear]   = useState("");
  const [principalName, setPrincipalName] = useState("");
  const [description,   setDescription]  = useState("");
  const [academicYearStart, setAcademicYearStart] = useState("");
  const [academicYearEnd,   setAcademicYearEnd]   = useState("");
  const [schoolDays,    setSchoolDays]    = useState([
    "Monday","Tuesday","Wednesday","Thursday","Friday",
  ]);
  const [schoolStartTime, setSchoolStartTime] = useState("07:30");
  const [schoolEndTime,   setSchoolEndTime]   = useState("15:30");

  const [logoStatus, setLogoStatus] = useState("loading");
  const [logoUri,    setLogoUri]    = useState(null);
  const [logoBase64, setLogoBase64] = useState(null);

  useEffect(() => { if (schoolId) load(); }, [schoolId]);

  const load = async () => {
    try {
      setLoading(true);
      const data = await fetchSchoolSettings(schoolId);
      if (data) populate(data);
    } catch (err) {
      console.warn("School settings load error:", err.message);
    } finally {
      setLoading(false);
    }
  };

  const populate = (d) => {
    setName(d.name                    || "");
    setMotto(d.motto                  || "");
    setEmail(d.email                  || "");
    setPhone(d.phone                  || "");
    setWebsite(d.website              || "");
    setAddress(d.address              || "");
    setCity(d.city                    || "");
    setState(d.state                  || "");
    setCountry(d.country              || "");
    setPostalCode(d.postalCode        || "");
    setSchoolType(d.schoolType        || "primary");
    setTermSystem(d.termSystem        || "trimester");
    setSchoolCode(d.schoolCode        || "");
    setRegNumber(d.registrationNumber || "");
    setFoundedYear(String(d.foundedYear || ""));
    setPrincipalName(d.principalName  || "");
    setDescription(d.description      || "");
    setAcademicYearStart(d.academicYearStart || "");
    setAcademicYearEnd(d.academicYearEnd     || "");
    setSchoolDays(
      Array.isArray(d.schoolDays) && d.schoolDays.length > 0
        ? d.schoolDays
        : ["Monday","Tuesday","Wednesday","Thursday","Friday"]
    );
    setSchoolStartTime(d.schoolStartTime || "07:30");
    setSchoolEndTime(d.schoolEndTime     || "15:30");

    const rawLogo    = d.logo || d.logoUrl || d.logo_url || null;
    const normalised = normaliseLogo(rawLogo);

    if (normalised) {
      setLogoUri(normalised);
      setLogoStatus("ready");
    } else {
      setLogoUri(null);
      setLogoStatus("empty");
    }
    setLogoBase64(null);
  };

  const pickLogo = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Required", "Please allow access to your photo library.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      setLogoUri(asset.uri);
      setLogoBase64(asset.base64 || null);
      setLogoStatus("ready");
    }
  };

  const removeLogo = () => {
    Alert.alert("Remove Logo", "Remove the school logo?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          setLogoUri(null);
          setLogoBase64(null);
          setLogoStatus("empty");
        },
      },
    ]);
  };

  const toggleDay = (day) => {
    setSchoolDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const handleSave = async () => {
    if (!name.trim()) { Alert.alert("Error", "School name is required"); return; }
    try {
      setSaving(true);
      const cleanedBase64 = logoBase64
        ? logoBase64.replace(/^data:[^;]+;base64,/, "")
        : undefined;

      const saved = await saveSchoolSettings({
        schoolId,
        name:               name.trim(),
        motto:              motto.trim(),
        email:              email.trim(),
        phone:              phone.trim(),
        website:            website.trim(),
        address:            address.trim(),
        city:               city.trim(),
        state:              state.trim(),
        country:            country.trim(),
        postalCode:         postalCode.trim(),
        schoolType,
        termSystem,
        schoolCode:         schoolCode.trim(),
        registrationNumber: regNumber.trim(),
        foundedYear:        foundedYear ? Number(foundedYear) : null,
        principalName:      principalName.trim(),
        description:        description.trim(),
        academicYearStart:  academicYearStart.trim(),
        academicYearEnd:    academicYearEnd.trim(),
        schoolDays,
        schoolStartTime:    schoolStartTime.trim(),
        schoolEndTime:      schoolEndTime.trim(),
        ...(cleanedBase64 ? { logoBase64: cleanedBase64 } : {}),
        ...(logoStatus === "empty" ? { removeLogo: true } : {}),
      });

      if (saved) {
        const norm = normaliseLogo(saved.logo || saved.logoUrl || saved.logo_url);
        if (norm) {
          setLogoUri(norm);
          setLogoStatus("ready");
          setLogoBase64(null);
        }
      }
      Alert.alert("Saved", "School settings updated successfully");
    } catch (err) {
      Alert.alert("Error", err?.response?.data?.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const LogoContent = () => {
    if (logoStatus === "loading") {
      return (
        <View style={sc.logoPlaceholder}>
          <ActivityIndicator size="small" color="#9CA3AF" />
        </View>
      );
    }
    if (logoStatus === "ready" && logoUri) {
      return (
        <Image
          key={logoUri}
          source={{ uri: logoUri }}
          style={sc.logoImage}
          resizeMode="cover"
          onError={() => setLogoStatus("error")}
        />
      );
    }
    return (
      <View style={sc.logoPlaceholder}>
        <Ionicons
          name={logoStatus === "error" ? "alert-circle-outline" : "business-outline"}
          size={34}
          color={logoStatus === "error" ? "#FCA5A5" : "#9CA3AF"}
        />
        <Text style={sc.logoPlaceholderText}>
          {logoStatus === "error" ? "Failed to load" : "No Logo"}
        </Text>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#4F46E5" />
      </View>
    );
  }

  return (
    <View>
      {/* ── Logo ── */}
      <Card>
        <Text style={styles.cardTitle}>School Logo</Text>
        <View style={sc.logoRow}>
          <TouchableOpacity style={sc.logoBox} onPress={pickLogo} activeOpacity={0.8}>
            <LogoContent />
          </TouchableOpacity>
          <View style={sc.logoActions}>
            <TouchableOpacity style={sc.logoBtn} onPress={pickLogo} activeOpacity={0.8}>
              <Ionicons name="cloud-upload-outline" size={16} color="#4F46E5" />
              <Text style={sc.logoBtnText}>
                {logoStatus === "ready" ? "Change Logo" : "Upload Logo"}
              </Text>
            </TouchableOpacity>
            {logoStatus === "ready" && (
              <TouchableOpacity
                style={[sc.logoBtn, sc.logoBtnDanger]}
                onPress={removeLogo}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={16} color="#DC2626" />
                <Text style={[sc.logoBtnText, { color: "#DC2626" }]}>Remove</Text>
              </TouchableOpacity>
            )}
            <Text style={sc.logoHint}>Square image recommended (PNG / JPG)</Text>
          </View>
        </View>
      </Card>

      {/* ── Basic Info ── */}
      <Card style={{ marginTop: 12 }}>
        <Text style={styles.cardTitle}>Basic Information</Text>
        <SettingRow label="School Name *">
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Greenfield Academy"
            autoCapitalize="words"
          />
        </SettingRow>
        <SettingRow label="School Motto / Tagline">
          <TextInput
            style={styles.input}
            value={motto}
            onChangeText={setMotto}
            placeholder="e.g. Excellence in Education"
            autoCapitalize="sentences"
          />
        </SettingRow>
        <SettingRow label="School Type">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={sc.chipRow}
          >
            {SCHOOL_TYPES.map((t) => (
              <TouchableOpacity
                key={t.value}
                style={[sc.chip, schoolType === t.value && sc.chipActive]}
                onPress={() => setSchoolType(t.value)}
              >
                <Text style={[sc.chipText, schoolType === t.value && sc.chipTextActive]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SettingRow>
        <SettingRow label="School Code">
          <TextInput
            style={[styles.input, styles.inputSmall]}
            value={schoolCode}
            onChangeText={setSchoolCode}
            placeholder="e.g. GFA"
            autoCapitalize="characters"
            maxLength={10}
          />
        </SettingRow>
        <SettingRow label="Reg Number">
          <TextInput
            style={styles.input}
            value={regNumber}
            onChangeText={setRegNumber}
            placeholder="Official registration number"
          />
        </SettingRow>
        <SettingRow label="Year Founded">
          <TextInput
            style={[styles.input, styles.inputSmall]}
            value={foundedYear}
            onChangeText={setFoundedYear}
            placeholder="e.g. 1998"
            keyboardType="numeric"
            maxLength={4}
          />
        </SettingRow>
        <SettingRow label="Principal">
          <TextInput
            style={styles.input}
            value={principalName}
            onChangeText={setPrincipalName}
            placeholder="Full name of head teacher"
            autoCapitalize="words"
          />
        </SettingRow>
        <SettingRow label="About">
          <TextInput
            style={[styles.input, sc.textarea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Brief description..."
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </SettingRow>
      </Card>

      {/* ── Contact ── */}
      <Card style={{ marginTop: 12 }}>
        <Text style={styles.cardTitle}>Contact Details</Text>
        <SettingRow label="School Email">
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="school@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </SettingRow>
        <SettingRow label="Phone">
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="+233..."
            keyboardType="phone-pad"
          />
        </SettingRow>
        <SettingRow label="Website">
          <TextInput
            style={styles.input}
            value={website}
            onChangeText={setWebsite}
            placeholder="https://..."
            keyboardType="url"
            autoCapitalize="none"
          />
        </SettingRow>
      </Card>

      {/* ── Location ── */}
      <Card style={{ marginTop: 12 }}>
        <Text style={styles.cardTitle}>Location</Text>
        <SettingRow label="Address">
          <TextInput
            style={[styles.input, sc.textarea]}
            value={address}
            onChangeText={setAddress}
            placeholder="Street address"
            multiline
            numberOfLines={2}
            textAlignVertical="top"
          />
        </SettingRow>
        <View style={sc.row2}>
          <View style={{ flex: 1 }}>
            <SettingRow label="City">
              <TextInput
                style={styles.input}
                value={city}
                onChangeText={setCity}
                placeholder="City"
                autoCapitalize="words"
              />
            </SettingRow>
          </View>
          <View style={{ width: 10 }} />
          <View style={{ flex: 1 }}>
            <SettingRow label="State">
              <TextInput
                style={styles.input}
                value={state}
                onChangeText={setState}
                placeholder="State"
                autoCapitalize="words"
              />
            </SettingRow>
          </View>
        </View>
      </Card>

      {/* ── Academic Calendar ── */}
      <Card style={{ marginTop: 12 }}>
        <Text style={styles.cardTitle}>Academic Calendar</Text>
        <SettingRow label="System">
          <View style={styles.segmented}>
            {TERM_SYSTEMS.map((t) => (
              <TouchableOpacity
                key={t.value}
                style={[styles.segment, termSystem === t.value && styles.segmentActive]}
                onPress={() => setTermSystem(t.value)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    termSystem === t.value && styles.segmentTextActive,
                  ]}
                >
                  {t.label.split(" ")[0]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </SettingRow>
        <View style={sc.row2}>
          <View style={{ flex: 1 }}>
            <SettingRow label="Year Start" hint="YYYY-MM-DD">
              <TextInput
                style={styles.input}
                value={academicYearStart}
                onChangeText={setAcademicYearStart}
                placeholder="e.g. 2025-09-01"
              />
            </SettingRow>
          </View>
          <View style={{ width: 10 }} />
          <View style={{ flex: 1 }}>
            <SettingRow label="Year End" hint="YYYY-MM-DD">
              <TextInput
                style={styles.input}
                value={academicYearEnd}
                onChangeText={setAcademicYearEnd}
                placeholder="e.g. 2026-07-31"
              />
            </SettingRow>
          </View>
        </View>
        <SettingRow label="School Days">
          <View style={sc.dayRow}>
            {DAYS_OF_WEEK.map((day) => {
              const active = schoolDays.includes(day);
              return (
                <TouchableOpacity
                  key={day}
                  style={[sc.dayChip, active && sc.dayChipActive]}
                  onPress={() => toggleDay(day)}
                >
                  <Text style={[sc.dayChipText, active && sc.dayChipTextActive]}>
                    {day.slice(0, 3)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </SettingRow>
      </Card>

      {/* ── Save ── */}
      <TouchableOpacity
        style={[
          styles.btn,
          styles.btnPrimary,
          { marginTop: 16 },
          saving && styles.btnDisabled,
        ]}
        onPress={handleSave}
        disabled={saving}
        activeOpacity={0.8}
      >
        {saving ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <>
            <Ionicons name="save-outline" size={18} color="#fff" />
            <Text style={styles.btnText}>Save School Settings</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
};

const sc = StyleSheet.create({
  logoRow:             { flexDirection: "row", alignItems: "flex-start", gap: 16 },
  logoBox:             { width: 90, height: 90, borderRadius: 14, overflow: "hidden", borderWidth: 1.5, borderColor: "#E5E7EB", backgroundColor: "#F9FAFB" },
  logoImage:           { width: "100%", height: "100%", resizeMode: "cover" },
  logoPlaceholder:     { flex: 1, alignItems: "center", justifyContent: "center", gap: 4, padding: 4 },
  logoPlaceholderText: { fontSize: 10, color: "#9CA3AF", fontWeight: "500", textAlign: "center" },
  logoActions:         { flex: 1, gap: 8 },
  logoBtn:             { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: "#E5E7EB", backgroundColor: "#F9FAFB" },
  logoBtnDanger:       { borderColor: "#FCA5A5", backgroundColor: "#FEF2F2" },
  logoBtnText:         { fontSize: 13, fontWeight: "600", color: "#4F46E5" },
  logoHint:            { fontSize: 11, color: "#9CA3AF", marginTop: 2 },
  chipRow:             { gap: 8, paddingVertical: 2 },
  chip:                { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: "#E5E7EB", backgroundColor: "#F9FAFB" },
  chipActive:          { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  chipText:            { fontSize: 13, color: "#6B7280", fontWeight: "500" },
  chipTextActive:      { color: "#4F46E5", fontWeight: "700" },
  dayRow:              { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  dayChip:             { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: "#E5E7EB", backgroundColor: "#F9FAFB" },
  dayChipActive:       { backgroundColor: "#EEF2FF", borderColor: "#4F46E5" },
  dayChipText:         { fontSize: 13, color: "#9CA3AF", fontWeight: "500" },
  dayChipTextActive:   { color: "#4F46E5", fontWeight: "700" },
  row2:                { flexDirection: "row" },
  textarea:            { height: 72, textAlignVertical: "top", paddingTop: 10 },
});

// ─────────────────────────────────────────────────────────
// PROFILE SECTION
// ─────────────────────────────────────────────────────────

const ProfileSection = ({ user, onProfileUpdated }) => {
  const [name,            setName]            = useState("");
  const [email,           setEmail]           = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword,     setNewPassword]     = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving,          setSaving]          = useState(false);
  const [changingPw,      setChangingPw]      = useState(false);
  const [showPwForm,      setShowPwForm]      = useState(false);
  const [showCurrentPw,   setShowCurrentPw]   = useState(false);
  const [showNewPw,       setShowNewPw]       = useState(false);

  useEffect(() => {
    setName(user?.name   || "");
    setEmail(user?.email || "");
  }, [user]);

  const handleSaveProfile = async () => {
    if (!name.trim()) { Alert.alert("Error", "Name is required"); return; }
    try {
      setSaving(true);
      const updated = await updateProfile({ name: name.trim(), email });
      onProfileUpdated?.(updated);
      Alert.alert("Success", "Profile updated successfully");
    } catch {
      Alert.alert("Error", "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      Alert.alert("Error", "All fields required");
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Error", "Passwords don't match");
      return;
    }
    try {
      setChangingPw(true);
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowPwForm(false);
      Alert.alert("Success", "Password changed");
    } catch {
      Alert.alert("Error", "Failed to change password");
    } finally {
      setChangingPw(false);
    }
  };

  return (
    <View>
      <Card>
        <Text style={styles.cardTitle}>Personal Information</Text>
        <SettingRow label="Full Name">
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
          />
        </SettingRow>
        <SettingRow label="Email">
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
        </SettingRow>
        <SettingRow label="Role">
          <View
            style={[
              styles.roleBadge,
              { backgroundColor: (ROLE_COLORS[user?.role] || "#6B7280") + "20" },
            ]}
          >
            <Text style={[styles.roleText, { color: ROLE_COLORS[user?.role] || "#6B7280" }]}>
              {ROLE_LABELS[user?.role] || user?.role}
            </Text>
          </View>
        </SettingRow>
        <TouchableOpacity
          style={[styles.btn, styles.btnPrimary, saving && styles.btnDisabled]}
          onPress={handleSaveProfile}
          disabled={saving}
        >
          <Text style={styles.btnText}>Save Profile</Text>
        </TouchableOpacity>
      </Card>

      <Card style={{ marginTop: 12 }}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Password</Text>
          <TouchableOpacity onPress={() => setShowPwForm(!showPwForm)}>
            <Text style={styles.linkText}>{showPwForm ? "Cancel" : "Change Password"}</Text>
          </TouchableOpacity>
        </View>
        {showPwForm && (
          <View>
            <View style={styles.pwField}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder="Current password"
                secureTextEntry={!showCurrentPw}
              />
              <TouchableOpacity
                onPress={() => setShowCurrentPw(!showCurrentPw)}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={showCurrentPw ? "eye-off-outline" : "eye-outline"}
                  size={20}
                  color="#9CA3AF"
                />
              </TouchableOpacity>
            </View>
            <View style={styles.pwField}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="New password"
                secureTextEntry={!showNewPw}
              />
              <TouchableOpacity
                onPress={() => setShowNewPw(!showNewPw)}
                style={styles.eyeBtn}
              >
                <Ionicons
                  name={showNewPw ? "eye-off-outline" : "eye-outline"}
                  size={20}
                  color="#9CA3AF"
                />
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.input}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Confirm new password"
              secureTextEntry
            />
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, changingPw && styles.btnDisabled]}
              onPress={handleChangePassword}
              disabled={changingPw}
            >
              <Text style={styles.btnText}>Update Password</Text>
            </TouchableOpacity>
          </View>
        )}
      </Card>
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// GRADING SECTION
// ─────────────────────────────────────────────────────────

const GradingSection = ({ schoolId }) => {
  const [config,  setConfig]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  useEffect(() => { loadConfig(); }, [schoolId]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const data = await fetchGradingConfig(schoolId);
      setConfig(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      await saveGradingConfig({ ...config, schoolId });
      Alert.alert("Success", "Grading system updated");
    } catch {
      Alert.alert("Error", "Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color="#4F46E5" /></View>;
  }
  if (!config) return null;

  return (
    <View>
      <Card>
        <Text style={styles.cardTitle}>Grading Settings</Text>
        <SettingRow label="Pass Mark %">
          <TextInput
            style={[styles.input, styles.inputSmall]}
            value={String(config.passMark ?? 50)}
            onChangeText={(v) => setConfig({ ...config, passMark: Number(v) || 0 })}
            keyboardType="numeric"
          />
        </SettingRow>
        <SettingRow label="GPA System">
          <Switch
            value={config.useGpa}
            onValueChange={(v) => setConfig({ ...config, useGpa: v })}
            trackColor={{ false: "#E5E7EB", true: "#4F46E5" }}
          />
        </SettingRow>
      </Card>
      <TouchableOpacity
        style={[styles.btn, styles.btnPrimary, { marginTop: 16 }, saving && styles.btnDisabled]}
        onPress={handleSave}
        disabled={saving}
      >
        <Text style={styles.btnText}>Save Grading System</Text>
      </TouchableOpacity>
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// ADMINS SECTION
// ─────────────────────────────────────────────────────────

const AdminsSection = ({ schoolId, currentUserId }) => {
  const [admins,     setAdmins]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [showModal,  setShowModal]  = useState(false);
  const [creating,   setCreating]   = useState(false);
  const [newName,    setNewName]    = useState("");
  const [newEmail,   setNewEmail]   = useState("");

  useEffect(() => { loadAdmins(); }, [schoolId]);

  const loadAdmins = async () => {
    try {
      setLoading(true);
      const data = await fetchAdmins(schoolId);
      setAdmins(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newName || !newEmail) return;
    try {
      setCreating(true);
      const res = await createAdmin({ name: newName, email: newEmail, schoolId, role: "admin" });
      setAdmins([res.admin, ...admins]);
      setShowModal(false);
      setNewName("");
      setNewEmail("");
    } catch {
      Alert.alert("Error", "Failed to create admin");
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color="#4F46E5" /></View>;
  }

  return (
    <View>
      <Card>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Admins ({admins.length})</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowModal(true)}>
            <Ionicons name="add" size={18} color="#4F46E5" />
            <Text style={styles.addBtnText}>Add Admin</Text>
          </TouchableOpacity>
        </View>
        {admins.map((a) => (
          <View key={a._id} style={styles.adminRow}>
            <View style={styles.adminInfo}>
              <Text style={styles.adminName}>
                {a.name} {a._id === currentUserId && "(You)"}
              </Text>
              <Text style={styles.adminEmail}>{a.email}</Text>
            </View>
          </View>
        ))}
      </Card>

      <Modal visible={showModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <TextInput
              style={styles.input}
              placeholder="Name"
              value={newName}
              onChangeText={setNewName}
            />
            <TextInput
              style={[styles.input, { marginTop: 10 }]}
              placeholder="Email"
              value={newEmail}
              onChangeText={setNewEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.btn} onPress={() => setShowModal(false)}>
                <Text>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, { flex: 1 }]}
                onPress={handleCreate}
                disabled={creating}
              >
                {creating
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={{ color: "#fff" }}>Create</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// ANALYTICS SECTION
// ─────────────────────────────────────────────────────────

const AnalyticsSection = ({ schoolId }) => {
  const [analytics, setAnalytics] = useState(null);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => { loadAnalytics(); }, [schoolId]);

  const loadAnalytics = async () => {
    try {
      setLoading(true);
      const data = await fetchAnalytics(schoolId);
      setAnalytics(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color="#4F46E5" /></View>;
  }
  if (!analytics) return null;

  return (
    <View>
      <Card>
        <Text style={styles.cardTitle}>School Summary</Text>
        <View style={styles.analyticsGrid}>
          <View style={[styles.analyticsCard, { backgroundColor: "#EEF2FF" }]}>
            <Text style={styles.analyticsNumber}>{analytics.summary?.totalTeachers ?? 0}</Text>
            <Text>Teachers</Text>
          </View>
          <View style={[styles.analyticsCard, { backgroundColor: "#F5F3FF" }]}>
            <Text style={styles.analyticsNumber}>{analytics.summary?.totalClasses ?? 0}</Text>
            <Text>Classes</Text>
          </View>
        </View>
      </Card>
    </View>
  );
};

// ─────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────

export default function AdminSettings() {
  const router     = useRouter();
  const user       = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  const [activeSection, setActiveSection] = useState("school");
  const [profile,       setProfile]       = useState(null);
  const [loading,       setLoading]       = useState(true);

  const schoolId   = user?.schoolId;
  const currentUser = profile || user;

  useEffect(() => { loadProfile(); }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await fetchProfile();
      setProfile(data);
    } catch {
      setProfile(user);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.fullCentered}>
        <ActivityIndicator size="large" color="#4F46E5" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#111827" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Settings</Text>
          <Text style={styles.headerSub}>{currentUser?.name || "Admin"}</Text>
        </View>
      </View>

      {/* ── Section Tabs ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabsContent}
      >
        {SECTIONS.map((s) => (
          <SectionTab
            key={s.id}
            section={s}
            active={activeSection === s.id}
            onPress={() => setActiveSection(s.id)}
          />
        ))}
      </ScrollView>

      {/* ── Content ── */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {activeSection === "school" && (
          <SchoolSection schoolId={schoolId} />
        )}
        {activeSection === "profile" && (
          <ProfileSection
            user={currentUser}
            onProfileUpdated={(upd) => { setProfile(upd); updateUser?.(upd); }}
          />
        )}
        {activeSection === "grading" && (
          <GradingSection schoolId={schoolId} />
        )}
        {activeSection === "admins" && (
          <AdminsSection
            schoolId={schoolId}
            currentUserId={currentUser?._id || currentUser?.id}
          />
        )}
        {activeSection === "analytics" && (
          <AnalyticsSection schoolId={schoolId} />
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: "#F3F4F6" },
  fullCentered:    { flex: 1, justifyContent: "center", alignItems: "center" },
  centered:        { paddingVertical: 32, alignItems: "center" },
  header:          { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14, backgroundColor: "#FFFFFF", borderBottomWidth: 1, borderBottomColor: "#E5E7EB", gap: 12 },
  backBtn:         { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  headerTitle:     { fontSize: 20, fontWeight: "700", color: "#111827" },
  headerSub:       { fontSize: 13, color: "#6B7280" },
  tabsScroll:      { backgroundColor: "#FFFFFF", maxHeight: 52 },
  tabsContent:     { paddingHorizontal: 12, gap: 4, alignItems: "center" },
  tab:             { flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, gap: 6 },
  tabActive:       { backgroundColor: "#EEF2FF" },
  tabLabel:        { fontSize: 13, color: "#9CA3AF" },
  tabLabelActive:  { color: "#4F46E5", fontWeight: "600" },
  content:         { padding: 16 },
  card:            { backgroundColor: "#FFFFFF", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#F3F4F6" },
  cardTitle:       { fontSize: 15, fontWeight: "700", marginBottom: 14 },
  cardTitleRow:    { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  settingRow:      { marginBottom: 14 },
  settingLabel:    { fontSize: 13, color: "#6B7280", marginBottom: 6 },
  settingHint:     { fontSize: 11, color: "#9CA3AF" },
  input:           { backgroundColor: "#F9FAFB", borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 10, padding: 10, fontSize: 14 },
  inputSmall:      { width: 100 },
  btn:             { paddingVertical: 13, borderRadius: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  btnPrimary:      { backgroundColor: "#4F46E5" },
  btnText:         { color: "#fff", fontWeight: "700" },
  btnDisabled:     { opacity: 0.6 },
  linkText:        { color: "#4F46E5", fontSize: 13 },
  roleBadge:       { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, alignSelf: "flex-start" },
  roleText:        { fontSize: 12, fontWeight: "600" },
  segmented:       { flexDirection: "row", backgroundColor: "#F3F4F6", borderRadius: 10, padding: 3 },
  segment:         { flex: 1, paddingVertical: 7, alignItems: "center", borderRadius: 8 },
  segmentActive:   { backgroundColor: "#FFFFFF" },
  segmentText:     { fontSize: 13, color: "#9CA3AF" },
  segmentTextActive: { color: "#111827", fontWeight: "600" },
  adminRow:        { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#F9FAFB" },
  adminInfo:       { flex: 1 },
  adminName:       { fontSize: 14, fontWeight: "600" },
  adminEmail:      { fontSize: 12, color: "#6B7280" },
  modalOverlay:    { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalContent:    { backgroundColor: "#FFFFFF", padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  modalActions:    { flexDirection: "row", gap: 10, marginTop: 10 },
  analyticsGrid:   { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  analyticsCard:   { flex: 1, minWidth: "45%", padding: 16, borderRadius: 12, alignItems: "center" },
  analyticsNumber: { fontSize: 22, fontWeight: "700" },
  addBtn:          { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#EEF2FF", padding: 6, borderRadius: 8 },
  addBtnText:      { color: "#4F46E5", fontSize: 13 },
  pwField:         { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  eyeBtn:          { padding: 5 },
});