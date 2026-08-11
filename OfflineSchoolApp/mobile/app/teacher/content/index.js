import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
  TextInput,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
  Pressable,
  Share,
  Linking,
  Platform,
} from "react-native";
import { useRouter }    from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import {
  getTeacherContent,
  getTeacherSubjectsForContent,
  deleteContent,
  updateContentStatus,
} from "../../../src/services/content.service";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const CONTENT_TABS = [
  { id: "all",      label: "All",      icon: "grid-outline",          color: "#4F46E5" },
  { id: "syllabus", label: "Syllabus", icon: "list-outline",          color: "#7C3AED" },
  { id: "notes",    label: "Notes",    icon: "document-text-outline", color: "#2563EB" },
  { id: "video",    label: "Videos",   icon: "videocam-outline",      color: "#DC2626" },
  { id: "audio",    label: "Audio",    icon: "musical-notes-outline", color: "#D97706" },
  { id: "document", label: "Docs",     icon: "attach-outline",        color: "#059669" },
  { id: "image",    label: "Images",   icon: "image-outline",         color: "#DB2777" },
];

const SORT_OPTIONS = [
  { id: "newest",    label: "Newest First" },
  { id: "oldest",    label: "Oldest First" },
  { id: "az",        label: "A → Z"        },
  { id: "za",        label: "Z → A"        },
  { id: "size_desc", label: "Largest"      },
  { id: "size_asc",  label: "Smallest"     },
];

const STATUS_COLORS = {
  active:   { bg: "#ECFDF5", text: "#059669", dot: "#059669" },
  draft:    { bg: "#F3F4F6", text: "#6B7280", dot: "#9CA3AF" },
  archived: { bg: "#FEF3C7", text: "#D97706", dot: "#D97706" },
};

const SUMMARY_TYPES = [
  { id: "syllabus", icon: "list",          color: "#7C3AED", bg: "#EDE9FE", label: "Syllabus" },
  { id: "notes",    icon: "document-text", color: "#2563EB", bg: "#DBEAFE", label: "Notes"    },
  { id: "video",    icon: "videocam",      color: "#DC2626", bg: "#FEE2E2", label: "Videos"   },
  { id: "audio",    icon: "musical-notes", color: "#D97706", bg: "#FEF3C7", label: "Audio"    },
  { id: "document", icon: "attach",        color: "#059669", bg: "#ECFDF5", label: "Docs"     },
  { id: "image",    icon: "image",         color: "#DB2777", bg: "#FDF2F8", label: "Images"   },
];

const UPLOAD_ENTRY_ROUTE = "/teacher/content/select-subject";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return "—";
  const k     = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const formatDate = (dateStr) => {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day:   "2-digit",
    month: "short",
    year:  "numeric",
  });
};

const formatCount = (n) => {
  if (!n) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const getTypeConfig = (type = "") => {
  const map = {
    syllabus: { icon: "list",          color: "#7C3AED", bg: "#EDE9FE", label: "Syllabus" },
    notes:    { icon: "document-text", color: "#2563EB", bg: "#DBEAFE", label: "Notes"    },
    video:    { icon: "videocam",      color: "#DC2626", bg: "#FEE2E2", label: "Video"    },
    audio:    { icon: "musical-notes", color: "#D97706", bg: "#FEF3C7", label: "Audio"    },
    document: { icon: "attach",        color: "#059669", bg: "#ECFDF5", label: "Document" },
    image:    { icon: "image",         color: "#DB2777", bg: "#FDF2F8", label: "Image"    },
  };
  return (
    map[type?.toLowerCase()] || {
      icon:  "document-outline",
      color: "#6B7280",
      bg:    "#F3F4F6",
      label: type || "File",
    }
  );
};

// ─────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────

function SummaryCard({ icon, color, bg, count, label, onPress, active }) {
  return (
    <TouchableOpacity
      style={[
        summaryStyles.card,
        active && { borderColor: color, borderWidth: 1.5 },
      ]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View style={[summaryStyles.iconBox, { backgroundColor: bg }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <Text style={[summaryStyles.count, active && { color }]}>{count}</Text>
      <Text style={summaryStyles.label}>{label}</Text>
    </TouchableOpacity>
  );
}

function TypeTab({ tab, active, count, onPress }) {
  return (
    <TouchableOpacity
      style={[tabStyles.tab, active && { backgroundColor: tab.color }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons
        name={tab.icon}
        size={14}
        color={active ? "#FFF" : tab.color}
      />
      <Text style={[tabStyles.label, active && tabStyles.labelActive]}>
        {tab.label}
      </Text>
      {count > 0 && (
        <View
          style={[
            tabStyles.badge,
            active
              ? { backgroundColor: "rgba(255,255,255,0.3)" }
              : { backgroundColor: tab.color + "22" },
          ]}
        >
          <Text style={[tabStyles.badgeText, active && { color: "#FFF" }]}>
            {count}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function ContentCard({ item, onPress, onOptions }) {
  const cfg    = getTypeConfig(item.type);
  const status = STATUS_COLORS[item.status] || STATUS_COLORS.active;

  return (
    <TouchableOpacity
      style={cardStyles.card}
      onPress={() => onPress(item)}
      activeOpacity={0.75}
    >
      <View style={[cardStyles.iconBox, { backgroundColor: cfg.bg }]}>
        <Ionicons name={cfg.icon} size={22} color={cfg.color} />
      </View>

      <View style={cardStyles.info}>
        <View style={cardStyles.titleRow}>
          <Text style={cardStyles.title} numberOfLines={1}>
            {item.title}
          </Text>
          <View
            style={[cardStyles.statusDot, { backgroundColor: status.dot }]}
          />
        </View>

        <Text style={cardStyles.subject} numberOfLines={1}>
          {item.subjectName || "—"}
          {item.classNames?.length > 0
            ? `  ·  ${item.classNames.slice(0, 2).join(", ")}${
                item.classNames.length > 2
                  ? ` +${item.classNames.length - 2}`
                  : ""
              }`
            : ""}
        </Text>

        <View style={cardStyles.metaRow}>
          <View style={[cardStyles.typeBadge, { backgroundColor: cfg.bg }]}>
            <Text style={[cardStyles.typeText, { color: cfg.color }]}>
              {cfg.label}
            </Text>
          </View>
          <Text style={cardStyles.meta}>{formatBytes(item.fileSize)}</Text>
          <Text style={cardStyles.meta}>{formatDate(item.createdAt)}</Text>
        </View>

        {(item.viewCount > 0 || item.downloadCount > 0) && (
          <View style={cardStyles.statsRow}>
            {item.viewCount > 0 && (
              <View style={cardStyles.statItem}>
                <Ionicons name="eye-outline" size={11} color="#9CA3AF" />
                <Text style={cardStyles.statText}>
                  {formatCount(item.viewCount)}
                </Text>
              </View>
            )}
            {item.downloadCount > 0 && (
              <View style={cardStyles.statItem}>
                <Ionicons name="download-outline" size={11} color="#9CA3AF" />
                <Text style={cardStyles.statText}>
                  {formatCount(item.downloadCount)}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      <TouchableOpacity
        style={cardStyles.optionsBtn}
        onPress={() => onOptions(item)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="ellipsis-vertical" size={18} color="#9CA3AF" />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function EmptyState({ activeTab, onUpload }) {
  const cfg = getTypeConfig(activeTab === "all" ? "document" : activeTab);
  return (
    <View style={emptyStyles.container}>
      <View style={[emptyStyles.iconBox, { backgroundColor: cfg.bg }]}>
        <Ionicons
          name={cfg.icon + "-outline"}
          size={40}
          color={cfg.color}
        />
      </View>
      <Text style={emptyStyles.title}>
        {activeTab === "all" ? "No Content Yet" : `No ${cfg.label} Yet`}
      </Text>
      <Text style={emptyStyles.sub}>
        {activeTab === "all"
          ? "Your content library is empty.\nStart uploading study materials."
          : `No ${cfg.label.toLowerCase()} uploaded yet.\nTap below to add some.`}
      </Text>
      <TouchableOpacity
        style={[emptyStyles.btn, { backgroundColor: cfg.color }]}
        onPress={onUpload}
        activeOpacity={0.8}
      >
        <Ionicons name="cloud-upload-outline" size={16} color="#FFF" />
        <Text style={emptyStyles.btnText}>Upload Now</Text>
      </TouchableOpacity>
    </View>
  );
}

function OptionsSheet({
  visible, item, onClose, onOpen, onShare, onArchive, onDelete,
}) {
  if (!item) return null;
  const cfg = getTypeConfig(item.type);

  const OPTIONS = [
    {
      id:      "open",
      icon:    "open-outline",
      label:   "Open / Preview",
      color:   "#111827",
      onPress: onOpen,
    },
    {
      id:      "share",
      icon:    "share-outline",
      label:   "Share Link",
      color:   "#4F46E5",
      onPress: onShare,
    },
    {
      id:      "archive",
      icon:    item.status === "archived" ? "eye-outline" : "archive-outline",
      label:   item.status === "archived" ? "Restore (Make Active)" : "Archive",
      color:   "#D97706",
      onPress: onArchive,
    },
    {
      id:      "delete",
      icon:    "trash-outline",
      label:   "Delete",
      color:   "#DC2626",
      onPress: onDelete,
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={sheetStyles.overlay} onPress={onClose}>
        <Pressable style={sheetStyles.sheet}>
          <View style={sheetStyles.handle} />

          <View style={sheetStyles.fileHeader}>
            <View
              style={[sheetStyles.fileHeaderIcon, { backgroundColor: cfg.bg }]}
            >
              <Ionicons name={cfg.icon} size={20} color={cfg.color} />
            </View>
            <View style={sheetStyles.fileHeaderInfo}>
              <Text style={sheetStyles.fileHeaderTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={sheetStyles.fileHeaderSub}>
                {cfg.label}  ·  {formatBytes(item.fileSize)}
              </Text>
            </View>
          </View>

          <View style={sheetStyles.divider} />

          {OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.id}
              style={sheetStyles.option}
              onPress={() => { onClose(); opt.onPress(); }}
              activeOpacity={0.7}
            >
              <View
                style={[
                  sheetStyles.optionIcon,
                  { backgroundColor: opt.color + "18" },
                ]}
              >
                <Ionicons name={opt.icon} size={18} color={opt.color} />
              </View>
              <Text style={[sheetStyles.optionLabel, { color: opt.color }]}>
                {opt.label}
              </Text>
              <Ionicons name="chevron-forward" size={16} color="#E5E7EB" />
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={sheetStyles.cancelBtn}
            onPress={onClose}
            activeOpacity={0.7}
          >
            <Text style={sheetStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PickerModal({ visible, title, options, selected, onSelect, onClose }) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={sheetStyles.overlay} onPress={onClose}>
        <Pressable style={sheetStyles.sheet}>
          <View style={sheetStyles.handle} />
          <Text style={sheetStyles.sheetTitle}>{title}</Text>

          {options.map((opt, idx) => {
            const isSelected =
              typeof opt === "string" ? opt === selected : opt.id === selected;
            const label = typeof opt === "string" ? opt : opt.label;
            const id    = typeof opt === "string" ? opt : opt.id;

            return (
              <React.Fragment key={id}>
                {idx > 0 && <View style={sheetStyles.divider} />}
                <TouchableOpacity
                  style={sheetStyles.option}
                  onPress={() => { onSelect(id); onClose(); }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      sheetStyles.optionLabel,
                      { color: isSelected ? "#4F46E5" : "#111827" },
                      isSelected && { fontWeight: "700" },
                    ]}
                  >
                    {label}
                  </Text>
                  {isSelected && (
                    <Ionicons name="checkmark" size={18} color="#4F46E5" />
                  )}
                </TouchableOpacity>
              </React.Fragment>
            );
          })}

          <TouchableOpacity
            style={sheetStyles.cancelBtn}
            onPress={onClose}
            activeOpacity={0.7}
          >
            <Text style={sheetStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────

function ContentLibraryPage() {
  const router    = useRouter();
  const user      = useAuthStore((s) => s.user);
  const teacherId = user?._id || user?.id || user?.userId || null;

  // ── Data ─────────────────────────────────────────────────
  const [allItems,   setAllItems]   = useState([]);
  const [summary,    setSummary]    = useState(null);
  const [subjects,   setSubjects]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);

  // ── UI state ─────────────────────────────────────────────
  const [activeTab,       setActiveTab]       = useState("all");
  const [searchQuery,     setSearchQuery]     = useState("");
  const [searchOpen,      setSearchOpen]      = useState(false);
  const [sortBy,          setSortBy]          = useState("newest");
  const [filterSubject,   setFilterSubject]   = useState(null);
  const [showSortModal,   setShowSortModal]   = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);

  // ── Options sheet ────────────────────────────────────────
  const [selectedItem, setSelectedItem] = useState(null);
  const [sheetVisible, setSheetVisible] = useState(false);

  const searchInputRef = useRef(null);

  // ─────────────────────────────────────────────────────────
  // Load data
  // ─────────────────────────────────────────────────────────
  const loadContent = useCallback(
    async (isRefresh = false) => {
      if (!teacherId) { setLoading(false); return; }
      try {
        isRefresh ? setRefreshing(true) : setLoading(true);
        setError(null);

        const [contentData, subjectsData] = await Promise.all([
          getTeacherContent(teacherId),
          getTeacherSubjectsForContent(teacherId),
        ]);

        setAllItems(contentData?.items  || []);
        setSummary(contentData?.summary || null);
        setSubjects(subjectsData        || []);
      } catch (err) {
        console.error("Content load error:", err);
        setError("Failed to load content library");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [teacherId]
  );

  useEffect(() => { loadContent(); }, [loadContent]);

  // ─────────────────────────────────────────────────────────
  // Derived — filtered + sorted
  // ─────────────────────────────────────────────────────────
  const displayItems = useMemo(() => {
    let items = [...allItems];

    if (activeTab !== "all") {
      items = items.filter((i) => i.type?.toLowerCase() === activeTab);
    }

    if (filterSubject) {
      items = items.filter((i) => i.subjectId === filterSubject);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) =>
          i.title?.toLowerCase().includes(q)       ||
          i.subjectName?.toLowerCase().includes(q) ||
          i.description?.toLowerCase().includes(q)
      );
    }

    switch (sortBy) {
      case "newest":
        items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        break;
      case "oldest":
        items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        break;
      case "az":
        items.sort((a, b) => a.title?.localeCompare(b.title));
        break;
      case "za":
        items.sort((a, b) => b.title?.localeCompare(a.title));
        break;
      case "size_desc":
        items.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0));
        break;
      case "size_asc":
        items.sort((a, b) => (a.fileSize || 0) - (b.fileSize || 0));
        break;
      default:
        break;
    }

    return items;
  }, [allItems, activeTab, filterSubject, searchQuery, sortBy]);

  const tabCounts = useMemo(() => {
    const counts = { all: allItems.length };
    allItems.forEach((i) => {
      const t = i.type?.toLowerCase();
      if (t) counts[t] = (counts[t] || 0) + 1;
    });
    return counts;
  }, [allItems]);

  const subjectOptions = useMemo(() => {
    const all = [{ id: "__all__", label: "All Subjects" }];
    subjects.forEach((s) =>
      all.push({ id: s.subjectId, label: s.subjectName })
    );
    return all;
  }, [subjects]);

  // ─────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────

  const handleToggleSearch = useCallback(() => {
    setSearchOpen((v) => {
      if (v) setSearchQuery("");
      else   setTimeout(() => searchInputRef.current?.focus(), 50);
      return !v;
    });
  }, []);

  const handleOpenItem = useCallback((item) => {
    if (item.fileUrl) {
      Linking.openURL(item.fileUrl).catch(() =>
        Alert.alert("Error", "Could not open this file.")
      );
    } else {
      Alert.alert("No file", "This item has no file URL.");
    }
  }, []);

  const handleShareItem = useCallback(async (item) => {
    try {
      await Share.share({
        title:   item.title,
        message: `${item.title}\n${item.fileUrl || ""}`,
        url:     item.fileUrl,
      });
    } catch {
      Alert.alert("Share failed", "Could not share this file.");
    }
  }, []);

  const handleArchiveItem = useCallback((item) => {
    const newStatus = item.status === "archived" ? "active" : "archived";
    const label     = newStatus === "archived" ? "Archive" : "Restore";

    Alert.alert(`${label} Content`, `${label} "${item.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text:    label,
        onPress: async () => {
          try {
            await updateContentStatus(item._id, newStatus);
            setAllItems((prev) =>
              prev.map((i) =>
                i._id === item._id ? { ...i, status: newStatus } : i
              )
            );
          } catch {
            Alert.alert("Error", `Could not ${label.toLowerCase()} this item.`);
          }
        },
      },
    ]);
  }, []);

  const handleDeleteItem = useCallback((item) => {
    Alert.alert(
      "Delete Content",
      `Permanently delete "${item.title}"?\n\nThis cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text:  "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteContent(item._id);
              setAllItems((prev) => prev.filter((i) => i._id !== item._id));
              setSummary((prev) => {
                if (!prev) return prev;
                const t = item.type?.toLowerCase();
                return {
                  ...prev,
                  total: Math.max(0, (prev.total || 1) - 1),
                  ...(t && { [t]: Math.max(0, (prev[t] || 1) - 1) }),
                };
              });
            } catch {
              Alert.alert("Error", "Could not delete this item. Please try again.");
            }
          },
        },
      ]
    );
  }, []);

  const openOptions = useCallback((item) => {
    setSelectedItem(item);
    setSheetVisible(true);
  }, []);

  const handleSubjectSelect = useCallback((id) => {
    setFilterSubject(id === "__all__" ? null : id);
  }, []);

  const goToUpload = useCallback(() => {
    router.push(UPLOAD_ENTRY_ROUTE);
  }, [router]);

  const activeFilterSubjectLabel = useMemo(() => {
    if (!filterSubject) return "Subject";
    return (
      subjects.find((s) => s.subjectId === filterSubject)?.subjectName ||
      "Subject"
    );
  }, [filterSubject, subjects]);

  const activeSortLabel = useMemo(
    () => SORT_OPTIONS.find((s) => s.id === sortBy)?.label || "Sort",
    [sortBy]
  );

  // ─────────────────────────────────────────────────────────
  // Loading screen
  // ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>Loading content library…</Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F3F4F6" />

      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={22} color="#111827" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Content Library</Text>
          {summary?.total > 0 && (
            <Text style={styles.headerSub}>
              {summary.total} file{summary.total !== 1 ? "s" : ""}
            </Text>
          )}
        </View>

        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={handleToggleSearch}
            activeOpacity={0.7}
          >
            <Ionicons
              name={searchOpen ? "close" : "search-outline"}
              size={20}
              color="#374151"
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.uploadBtn}
            onPress={goToUpload}
            activeOpacity={0.8}
          >
            <Ionicons name="add" size={18} color="#FFF" />
            <Text style={styles.uploadBtnText}>Upload</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* SEARCH BAR */}
      {searchOpen && (
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={16} color="#9CA3AF" />
          <TextInput
            ref={searchInputRef}
            style={styles.searchInput}
            placeholder="Search by title, subject…"
            placeholderTextColor="#9CA3AF"
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            autoFocus
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery("")}>
              <Ionicons name="close-circle" size={16} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ERROR BANNER */}
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color="#DC2626" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadContent()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* TYPE TABS */}
      <View style={styles.tabsWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsRow}
        >
          {CONTENT_TABS.map((tab) => (
            <TypeTab
              key={tab.id}
              tab={tab}
              active={activeTab === tab.id}
              count={tabCounts[tab.id] || 0}
              onPress={() => setActiveTab(tab.id)}
            />
          ))}
        </ScrollView>
      </View>

      {/* FILTER / SORT ROW */}
      <View style={styles.filterRow}>
        <Text style={styles.resultCount}>
          {displayItems.length} item{displayItems.length !== 1 ? "s" : ""}
          {searchQuery.trim() ? ` for "${searchQuery}"` : ""}
        </Text>

        <View style={styles.filterActions}>
          <TouchableOpacity
            style={[
              styles.filterChip,
              filterSubject && styles.filterChipActive,
            ]}
            onPress={() => setShowFilterModal(true)}
            activeOpacity={0.7}
          >
            <Ionicons
              name="funnel-outline"
              size={13}
              color={filterSubject ? "#4F46E5" : "#6B7280"}
            />
            <Text
              style={[
                styles.filterChipText,
                filterSubject && { color: "#4F46E5" },
              ]}
            >
              {activeFilterSubjectLabel}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.filterChip}
            onPress={() => setShowSortModal(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="swap-vertical-outline" size={13} color="#6B7280" />
            <Text style={styles.filterChipText}>{activeSortLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* SUMMARY STRIP */}
      {summary && allItems.length > 0 && activeTab === "all" && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.summaryRow}
          style={styles.summaryScroll}
        >
          {SUMMARY_TYPES.map((s) => (
            <SummaryCard
              key={s.id}
              icon={s.icon}
              color={s.color}
              bg={s.bg}
              label={s.label}
              count={summary[s.id] || 0}
              active={activeTab === s.id}
              onPress={() => setActiveTab(s.id)}
            />
          ))}
        </ScrollView>
      )}

      {/* CONTENT LIST */}
      {displayItems.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyScroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadContent(true)}
              tintColor="#4F46E5"
            />
          }
        >
          <EmptyState activeTab={activeTab} onUpload={goToUpload} />
        </ScrollView>
      ) : (
        <FlatList
          data={displayItems}
          keyExtractor={(item) =>
            item._id || item.id || String(Math.random())
          }
          renderItem={({ item }) => (
            <ContentCard
              item={item}
              onPress={handleOpenItem}
              onOptions={openOptions}
            />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadContent(true)}
              tintColor="#4F46E5"
              colors={["#4F46E5"]}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListFooterComponent={<View style={{ height: 100 }} />}
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={goToUpload}
        activeOpacity={0.85}
      >
        <Ionicons name="cloud-upload-outline" size={20} color="#FFF" />
        <Text style={styles.fabText}>Upload</Text>
      </TouchableOpacity>

      {/* SORT MODAL */}
      <PickerModal
        visible={showSortModal}
        title="Sort By"
        options={SORT_OPTIONS}
        selected={sortBy}
        onSelect={(id) => setSortBy(id)}
        onClose={() => setShowSortModal(false)}
      />

      {/* SUBJECT FILTER MODAL */}
      <PickerModal
        visible={showFilterModal}
        title="Filter by Subject"
        options={subjectOptions}
        selected={filterSubject || "__all__"}
        onSelect={handleSubjectSelect}
        onClose={() => setShowFilterModal(false)}
      />

      {/* OPTIONS SHEET */}
      <OptionsSheet
        visible={sheetVisible}
        item={selectedItem}
        onClose={() => setSheetVisible(false)}
        onOpen={()    => handleOpenItem(selectedItem)}
        onShare={()   => handleShareItem(selectedItem)}
        onArchive={() => handleArchiveItem(selectedItem)}
        onDelete={()  => handleDeleteItem(selectedItem)}
      />
    </View>
  );
}

export default ContentLibraryPage;

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#F3F4F6" },
  centered: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    backgroundColor: "#F3F4F6",
  },
  loadingText: { marginTop: 12, fontSize: 14, color: "#6B7280", fontWeight: "500" },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingTop:        56,
    paddingBottom:     12,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    gap:               10,
  },
  backBtn: {
    width:           36,
    height:          36,
    borderRadius:    18,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  headerCenter:  { flex: 1 },
  headerTitle:   { fontSize: 18, fontWeight: "700", color: "#111827" },
  headerSub:     { fontSize: 12, color: "#9CA3AF", marginTop: 1 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  iconBtn: {
    width:           34,
    height:          34,
    borderRadius:    10,
    backgroundColor: "#F3F4F6",
    alignItems:      "center",
    justifyContent:  "center",
  },
  uploadBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 12,
    paddingVertical:   7,
    borderRadius:      10,
  },
  uploadBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },

  searchBar: {
    flexDirection:     "row",
    alignItems:        "center",
    backgroundColor:   "#F9FAFB",
    marginHorizontal:  16,
    marginTop:         10,
    marginBottom:      2,
    paddingHorizontal: 12,
    paddingVertical:   10,
    borderRadius:      12,
    gap:               8,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
  },
  searchInput: { flex: 1, fontSize: 14, color: "#111827" },

  errorBanner: {
    flexDirection:    "row",
    alignItems:       "center",
    backgroundColor:  "#FEE2E2",
    marginHorizontal: 16,
    marginVertical:   8,
    padding:          10,
    borderRadius:     10,
    gap:              8,
  },
  errorText: { flex: 1, fontSize: 12, color: "#991B1B" },
  retryText: { fontSize: 12, color: "#DC2626", fontWeight: "700" },

  tabsWrapper: {
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  tabsRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },

  filterRow: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 16,
    paddingVertical:   10,
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  resultCount:   { fontSize: 12, color: "#9CA3AF", fontWeight: "500" },
  filterActions: { flexDirection: "row", gap: 8 },
  filterChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   5,
    borderRadius:      20,
    borderWidth:       1,
    borderColor:       "#E5E7EB",
    backgroundColor:   "#F9FAFB",
  },
  filterChipActive: { borderColor: "#4F46E5", backgroundColor: "#EEF2FF" },
  filterChipText:   { fontSize: 12, color: "#6B7280", fontWeight: "500" },

  summaryScroll: {
    backgroundColor:   "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  summaryRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },

  listContent: { paddingHorizontal: 16, paddingTop: 12 },
  emptyScroll: { flex: 1, justifyContent: "center" },

  fab: {
    position:          "absolute",
    bottom:            28,
    right:             20,
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    backgroundColor:   "#4F46E5",
    paddingHorizontal: 18,
    paddingVertical:   13,
    borderRadius:      28,
    shadowColor:       "#4F46E5",
    shadowOffset:      { width: 0, height: 4 },
    shadowOpacity:     0.35,
    shadowRadius:      10,
    elevation:         8,
  },
  fabText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});

const summaryStyles = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius:    12,
    padding:         12,
    alignItems:      "center",
    gap:             5,
    minWidth:        76,
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    3,
    elevation:       1,
  },
  iconBox: {
    width:          36,
    height:         36,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  count: { fontSize: 18, fontWeight: "700", color: "#111827" },
  label: { fontSize: 10, color: "#9CA3AF", fontWeight: "500" },
});

const tabStyles = StyleSheet.create({
  tab: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      20,
    backgroundColor:   "#F3F4F6",
  },
  label:       { fontSize: 12, color: "#6B7280", fontWeight: "600" },
  labelActive: { color: "#FFF" },
  badge: {
    borderRadius:      10,
    paddingHorizontal: 5,
    paddingVertical:   1,
    minWidth:          18,
    alignItems:        "center",
  },
  badgeText: { fontSize: 10, color: "#374151", fontWeight: "700" },
});

const cardStyles = StyleSheet.create({
  card: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    backgroundColor: "#FFF",
    borderRadius:    14,
    padding:         14,
    shadowColor:     "#000",
    shadowOpacity:   0.04,
    shadowRadius:    4,
    elevation:       2,
  },
  iconBox: {
    width:          48,
    height:         48,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
    marginRight:    12,
    flexShrink:     0,
  },
  info:     { flex: 1, gap: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  title:    { flex: 1, fontSize: 14, fontWeight: "700", color: "#111827" },
  statusDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  subject:   { fontSize: 12, color: "#6B7280" },
  metaRow:   { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  typeBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  typeText:  { fontSize: 10, fontWeight: "700" },
  meta:      { fontSize: 11, color: "#9CA3AF" },
  statsRow:  { flexDirection: "row", alignItems: "center", gap: 10 },
  statItem:  { flexDirection: "row", alignItems: "center", gap: 3 },
  statText:  { fontSize: 11, color: "#9CA3AF" },
  optionsBtn: { padding: 6, marginLeft: 4, marginTop: -4 },
});

const emptyStyles = StyleSheet.create({
  container: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    padding:        36,
    gap:            12,
  },
  iconBox: {
    width:          80,
    height:         80,
    borderRadius:   20,
    alignItems:     "center",
    justifyContent: "center",
    marginBottom:   8,
  },
  title: { fontSize: 18, fontWeight: "700", color: "#374151" },
  sub:   { fontSize: 14, color: "#9CA3AF", textAlign: "center", lineHeight: 22 },
  btn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 20,
    paddingVertical:   12,
    borderRadius:      12,
    marginTop:         8,
  },
  btnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});

const sheetStyles = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent:  "flex-end",
  },
  sheet: {
    backgroundColor:      "#FFF",
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    paddingHorizontal:    20,
    paddingTop:           12,
    paddingBottom:        Platform.OS === "ios" ? 34 : 20,
  },
  handle: {
    width:           40,
    height:          4,
    borderRadius:    2,
    backgroundColor: "#E5E7EB",
    alignSelf:       "center",
    marginBottom:    16,
  },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginBottom: 12 },
  fileHeader: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    paddingVertical: 8,
    marginBottom:    4,
  },
  fileHeaderIcon: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     "center",
    justifyContent: "center",
  },
  fileHeaderInfo:  { flex: 1 },
  fileHeaderTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  fileHeaderSub:   { fontSize: 12, color: "#9CA3AF", marginTop: 2 },
  divider:         { height: 1, backgroundColor: "#F3F4F6", marginVertical: 8 },
  option: {
    flexDirection:   "row",
    alignItems:      "center",
    paddingVertical: 13,
    gap:             12,
  },
  optionIcon: {
    width:          38,
    height:         38,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
  },
  optionLabel: { flex: 1, fontSize: 15, fontWeight: "500" },
  cancelBtn: {
    marginTop:       12,
    paddingVertical: 14,
    alignItems:      "center",
    backgroundColor: "#F3F4F6",
    borderRadius:    12,
  },
  cancelText: { fontSize: 15, fontWeight: "700", color: "#374151" },
});