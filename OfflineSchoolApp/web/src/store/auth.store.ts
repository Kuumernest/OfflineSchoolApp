// web/src/store/auth.store.ts
import { create } from "zustand";
import api        from "@/lib/axios";
import { desktop } from "@/lib/offline/bridge";

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────────────────────

const storage = {
  getItem(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* quota */ }
  },
  removeItem(key: string): void {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthUser {
  _id:               string;
  id?:               string;
  name:              string;
  email:             string | null;
  enrollmentNo:      string | null;
  role:              string;
  schoolId:          string;
  // Login sends the school name flat on some deployments and populated on
  // others; the report card header reads whichever is present.
  schoolName?:       string;
  school?:           { name?: string } | null;
  isActive:          boolean;
  mustResetPassword: boolean;
  permissions:       string[];
}

/**
 * The school a super_admin is currently working inside.
 *
 * The server keeps no such thing: every request a super_admin makes names its
 * school in `schoolId`, and the door (middleware/auth.js) checks the school is
 * real. What this holds is the client's side of that — which school to name,
 * and what to write on the context bar. enterSchool mirrors the id into
 * user.schoolId as well, because every page reads its school from there; that
 * is what lets the operator use the ordinary school screens unchanged.
 */
export interface ActiveSchool {
  _id:           string;
  name:          string;
  code:          string | null;
  isActive:      boolean;
  academicYear?: string | null;
  currentTerm?:  string | null;
}

export interface StaffLoginCredentials {
  email:    string;
  password: string;
}

export interface StudentLoginCredentials {
  enrollmentNo: string;
  password:     string;
}

export type LoginCredentials = StaffLoginCredentials | StudentLoginCredentials;

// Public interface exposed to axios.ts to avoid circular type issues
export interface PublicAuthState {
  token:          string | null;
  refreshToken:   string | null;
  user:           AuthUser | null;
  activeSchool:   ActiveSchool | null;
  logout:         () => void;
  refreshSession: () => Promise<boolean>;
  // Exposed for the axios interceptor: a 403 PASSWORD_CHANGE_REQUIRED marks the
  // stored user so the route guard sends them to /change-password.
  setUser:        (updates: Partial<AuthUser>) => void;
}

interface AuthState {
  user:             AuthUser | null;
  token:            string   | null;
  refreshToken:     string   | null;
  hasInitialized:   boolean;
  isLoading:        boolean;
  isAuthenticated:  boolean;
  error:            string   | null;

  login:          (credentials: LoginCredentials) => Promise<void>;
  logout:         () => void;
  initAuth:       () => boolean;
  setAuth:        (user: AuthUser, token: string, refreshToken?: string | null) => void;
  setUser:        (updates: Partial<AuthUser>) => void;
  clearError:     () => void;
  refreshSession: () => Promise<boolean>;

  /** super_admin only — see ActiveSchool. */
  activeSchool:   ActiveSchool | null;
  enterSchool:    (school: ActiveSchool) => void;
  leaveSchool:    () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED AUTH STATE ACCESSOR
// Replaces the fragile registerAuthStore / _getAuthState pattern.
// Since the store is created synchronously, getState() is always available.
// axios.ts imports this directly — no registration side-effect needed.
// ─────────────────────────────────────────────────────────────────────────────

export function getAuthState(): PublicAuthState {
  return useAuthStore.getState();
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH DEDUPLICATION
// Ensures only one token-refresh call is in-flight at a time.
// All callers that arrive while a refresh is pending receive the same promise.
// ─────────────────────────────────────────────────────────────────────────────

let _refreshPromise: Promise<boolean> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const extractErrorMessage = (err: unknown): string => {
  if (!err) return "An unknown error occurred";
  const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
  if (axiosErr.response?.data?.message) return axiosErr.response.data.message;
  if (axiosErr.message)                 return axiosErr.message;
  return "An unknown error occurred";
};

/**
 * Exported because auth.service.ts needs it too. It previously cast raw
 * response bodies straight to AuthUser, producing objects with a null name or
 * schoolId that then failed to satisfy setAuth(). One normaliser, one shape.
 */
export const normaliseAuthUser = (raw: Record<string, unknown>): AuthUser => ({
  _id:          String(raw._id  || raw.id || ""),
  name:         String(raw.name  || ""),
  email:        (raw.email        as string) || null,
  enrollmentNo: (raw.enrollmentNo as string) ||
                (raw.enrollment_no as string) ||
                null,
  role:         String(raw.role     || ""),
  schoolId:     String(raw.schoolId || raw.school_id || ""),
  isActive:     raw.isActive !== false,

  // Boolean() is safer than `(value as boolean) ?? false`:
  // it correctly handles 0, "", null, undefined without casting
  mustResetPassword: Boolean(raw.mustResetPassword),

  permissions: Array.isArray(raw.permissions) ? (raw.permissions as string[]) : [],
});

const extractAuthPayload = (
  data: Record<string, unknown>,
): { token: string; refreshToken: string | null; user: AuthUser } => {
  const token =
    (data.token       as string | undefined) ??
    (data.accessToken as string | undefined) ??
    (data.jwt         as string | undefined) ??
    null;

  const refreshToken = (data.refreshToken as string | undefined) ?? null;

  // Prefer explicit user/admin keys. Only accept data.data if it
  // contains a recognisable id field — guards against error envelopes
  // like { success: false, data: { items: [] } } being misread as a user.
  let rawUser: Record<string, unknown> | null =
    (data.user  as Record<string, unknown> | undefined) ??
    (data.admin as Record<string, unknown> | undefined) ??
    null;

  if (!rawUser && data.data && typeof data.data === "object") {
    const candidate = data.data as Record<string, unknown>;
    if (candidate._id || candidate.id) {
      rawUser = candidate;
    }
  }

  if (!token)   throw new Error("Auth response is missing a token");
  if (!rawUser) throw new Error("Auth response is missing user data");

  return { token, refreshToken, user: normaliseAuthUser(rawUser) };
};

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// Keeps refresh-token storage consistent: store only when truthy,
// remove when falsy — avoids storing the empty string "" as a sentinel.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tell the desktop application about the session.
 *
 * The main process cannot sign in and deliberately keeps no credential on disk,
 * so the only way it can sync is to be handed the token by the window that
 * obtained it. Done here rather than at the three call sites because this is
 * where a token becomes the current one — login, setAuth and refresh all pass
 * through it, and hooking each separately is how one gets missed.
 *
 * Fire-and-forget, and silent on failure: syncing is not something a sign-in
 * should be able to fail on, and the engine reports its own state through
 * window.school.sync.
 */
const tellDesktop = (token: string | null, user: AuthUser | null = null) => {
  const bridge = desktop();
  if (!bridge) return;
  // The user goes with the token, because a local handler answering "show me my
  // approval requests" needs to know whose. Not a permission check — see the
  // note in the main process.
  void bridge.sync
    .setToken(token, user)
    .catch(() => { /* the engine reports its own health */ });
};

const persistAuth = (user: AuthUser, token: string, refreshToken: string | null) => {
  storage.setItem("token", token);
  storage.setItem("user",  JSON.stringify(user));
  if (refreshToken) {
    storage.setItem("refreshToken", refreshToken);
  } else {
    storage.removeItem("refreshToken");
  }
  tellDesktop(token, user);
};

const clearPersistedAuth = () => {
  storage.removeItem("token");
  storage.removeItem("user");
  storage.removeItem("refreshToken");
  // Stops the sync loop as well as clearing the token: a signed-out machine
  // should not be reaching the server on a timer.
  tellDesktop(null);
  storage.removeItem("activeSchool");
};

/** The school context survives a refresh; it is cleared by sign-out. */
const readPersistedSchool = (): ActiveSchool | null => {
  try {
    const raw = storage.getItem("activeSchool");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveSchool>;
    return parsed && typeof parsed._id === "string" && typeof parsed.name === "string"
      ? {
          _id: parsed._id, name: parsed.name, code: parsed.code ?? null,
          isActive: parsed.isActive !== false,
          academicYear: parsed.academicYear ?? null, currentTerm: parsed.currentTerm ?? null,
        }
      : null;
  } catch {
    return null;
  }
};

/**
 * A super_admin's user object, with the school they are inside mirrored in.
 *
 * The account itself has no school and never gets one; the mirror is what the
 * pages read. Any user object that arrives from the server — a refresh, a
 * restored session — has to be re-mirrored or the pages lose their school
 * while the layout still believes it is inside one. Everyone else is returned
 * untouched.
 */
const withActiveSchool = (user: AuthUser, school: ActiveSchool | null): AuthUser => {
  if (user.role !== "super_admin" || !school) return user;
  return { ...user, schoolId: school._id, schoolName: school.name, school: { name: school.name } };
};

// ─────────────────────────────────────────────────────────────────────────────
// STORE
// ─────────────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => ({
  activeSchool:    readPersistedSchool(),
  user:            null,
  token:           null,
  refreshToken:    null,
  hasInitialized:  false,
  isLoading:       false,
  isAuthenticated: false,
  error:           null,

  // ── login ──────────────────────────────────────────────────────────────────
  login: async (credentials: LoginCredentials) => {
    set({ isLoading: true, error: null });
    try {
      const payload =
        "enrollmentNo" in credentials
          ? {
              enrollmentNo: credentials.enrollmentNo.trim().toUpperCase(),
              password:     credentials.password,
            }
          : {
              email:    credentials.email.trim().toLowerCase(),
              password: credentials.password,
            };

      const response = await api.post("/auth/login", payload);
      const { token, refreshToken, user } = extractAuthPayload(response.data);

      persistAuth(user, token, refreshToken);

      set({
        user,
        token,
        refreshToken:    refreshToken,
        isAuthenticated: true,
        hasInitialized:  true,
        isLoading:       false,
        error:           null,
      });
    } catch (err) {
      const message = extractErrorMessage(err);
      set({ isLoading: false, error: message, isAuthenticated: false });
      throw err;
    }
  },

  // ── logout ─────────────────────────────────────────────────────────────────
  // Capture the token BEFORE clearing state so the server-side logout
  // request goes out with a valid Authorization header (the request
  // interceptor reads from the store, which we are about to wipe).
  logout: () => {
    const currentToken = get().token;

    api
      .post(
        "/auth/logout",
        {},
        {
          headers: currentToken
            ? { Authorization: `Bearer ${currentToken}` }
            : {},
        },
      )
      .catch(() => {});

    clearPersistedAuth();
    set({
      user:            null,
      token:           null,
      refreshToken:    null,
      activeSchool:    null,
      isAuthenticated: false,
      hasInitialized:  true,
      error:           null,
    });
  },

  // ── initAuth ───────────────────────────────────────────────────────────────
  // Call this exactly once at app bootstrap (e.g. in main.tsx or a top-level
  // layout). Using an empty-dependency useEffect guarantees a single call:
  //
  //   useEffect(() => { useAuthStore.getState().initAuth(); }, []);
  //
  // The hasInitialized guard makes repeat calls safe but they are a no-op.
  initAuth: () => {
    const state = get();
    if (state.hasInitialized) return !!(state.token && state.user);

    try {
      const token        = storage.getItem("token");
      const userRaw      = storage.getItem("user");
      // getItem returns null when absent; an absent key stored as ""
      // (legacy) is treated as missing via the || null fallback.
      const refreshToken = storage.getItem("refreshToken") || null;

      if (token && userRaw) {
        const parsed = JSON.parse(userRaw) as Record<string, unknown>;
        if (!parsed?._id && !parsed?.id) {
          throw new Error("Stored user object is missing an id");
        }
        // The stored user normally carries the mirror already; this covers a
        // user persisted by a refresh that ran before the mirror was kept.
        const user = withActiveSchool(normaliseAuthUser(parsed), get().activeSchool);
        set({
          user,
          token,
          refreshToken,
          isAuthenticated: true,
          hasInitialized:  true,
          error:           null,
        });
        return true;
      }

      set({
        user:            null,
        token:           null,
        refreshToken:    null,
        isAuthenticated: false,
        hasInitialized:  true,
        error:           null,
      });
      return false;

    } catch (err) {
      console.error("[auth] initAuth failed:", extractErrorMessage(err));
      clearPersistedAuth();
      set({
        user:            null,
        token:           null,
        refreshToken:    null,
        isAuthenticated: false,
        hasInitialized:  true,
        error:           null,
      });
      return false;
    }
  },

  // ── setAuth ────────────────────────────────────────────────────────────────
  setAuth: (user: AuthUser, token: string, refreshToken: string | null = null) => {
    persistAuth(user, token, refreshToken);
    // A fresh sign-in starts outside any school.
    storage.removeItem("activeSchool");
    set({
      activeSchool: null,
      user,
      token,
      refreshToken,
      isAuthenticated: true,
      hasInitialized:  true,
      error:           null,
    });
  },

  // ── enterSchool / leaveSchool ──────────────────────────────────────────────
  // super_admin only. The id is mirrored into user.schoolId because that is
  // where every page reads its school from; the platform's own pages do not
  // read it, and the axios interceptor fills it in for any request that forgot.
  enterSchool: (school: ActiveSchool) => {
    const current = get().user;
    if (!current || current.role !== "super_admin") return;
    const user: AuthUser = {
      ...current,
      schoolId:   school._id,
      schoolName: school.name,
      school:     { name: school.name },
    };
    storage.setItem("activeSchool", JSON.stringify(school));
    storage.setItem("user", JSON.stringify(user));
    set({ activeSchool: school, user });
  },

  leaveSchool: () => {
    const current = get().user;
    storage.removeItem("activeSchool");
    if (!current || current.role !== "super_admin") {
      set({ activeSchool: null });
      return;
    }
    const user: AuthUser = { ...current, schoolId: "", schoolName: undefined, school: null };
    storage.setItem("user", JSON.stringify(user));
    set({ activeSchool: null, user });
  },

  // ── setUser ────────────────────────────────────────────────────────────────
  setUser: (updates: Partial<AuthUser>) => {
    const current = get().user;
    if (!current) return;
    const updated: AuthUser = { ...current, ...updates };
    storage.setItem("user", JSON.stringify(updated));
    set({ user: updated });
  },

  // ── refreshSession ─────────────────────────────────────────────────────────
  // Deduplicated: concurrent callers share a single in-flight promise so the
  // refresh endpoint is never hit more than once per expiry cycle.
  refreshSession: async (): Promise<boolean> => {
    if (_refreshPromise) return _refreshPromise;

    _refreshPromise = (async () => {
      try {
        const currentRefreshToken = get().refreshToken;
        const response = await api.post(
          "/auth/refresh",
          currentRefreshToken ? { refreshToken: currentRefreshToken } : {},
        );
        const { token, refreshToken, user: fresh } = extractAuthPayload(response.data);

        // The server's copy of a super_admin has no school — schoolId is null
        // on the account, by design. The school they are working inside lives
        // only in this store, mirrored into user.schoolId, which is where every
        // page reads its school from. Taking the server's user as-is here wiped
        // that mirror on every token refresh: activeSchool stayed set, so the
        // page stayed inside the school, but every query gated on user.schoolId
        // went quiet and the dashboard read as an empty school.
        const user = withActiveSchool(fresh, get().activeSchool);

        persistAuth(user, token, refreshToken);
        set({
          token,
          refreshToken: refreshToken ?? null,
          user,
          isAuthenticated: true,
        });
        return true;
      } catch (err) {
        console.warn("[auth] refreshSession failed:", extractErrorMessage(err));
        get().logout();
        return false;
      } finally {
        // Always release the lock so the next expiry cycle can refresh again
        _refreshPromise = null;
      }
    })();

    return _refreshPromise;
  },

  // ── clearError ─────────────────────────────────────────────────────────────
  clearError: () => set({ error: null }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// SELECTORS
// Fine-grained subscriptions — each component only re-renders when its
// specific slice of state changes.
// ─────────────────────────────────────────────────────────────────────────────

export const useUser              = () => useAuthStore((s) => s.user);
export const useActiveSchool      = () => useAuthStore((s) => s.activeSchool);
export const useToken             = () => useAuthStore((s) => s.token);
export const useIsAuthed          = () => useAuthStore((s) => s.isAuthenticated);
export const useIsReady           = () => useAuthStore((s) => s.hasInitialized);
export const useIsLoading         = () => useAuthStore((s) => s.isLoading);
export const useAuthError         = () => useAuthStore((s) => s.error);
export const useEnrollmentNo      = () => useAuthStore((s) => s.user?.enrollmentNo ?? null);
export const useMustResetPassword = () => useAuthStore((s) => s.user?.mustResetPassword ?? false);
export const useIsStudent         = () => useAuthStore((s) => s.user?.role === "student");
// The bursar is NOT an admin, which is the entire point of the role — do not
// widen this to cover them. Somebody wanting "may see the money" wants a
// separate selector, because the two questions have different answers.
//
// "admin" is gone from the list: it was never a role the User schema could
// store, and the API canonicalises whatever it is given before it answers.
export const useIsAdmin           = () => useAuthStore((s) =>
  ["school_admin", "super_admin"].includes(s.user?.role ?? ""),
);
export const useIsTeacher = () => useAuthStore((s) => s.user?.role === "teacher");