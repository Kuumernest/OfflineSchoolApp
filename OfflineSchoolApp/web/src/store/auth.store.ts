// web/src/store/auth.store.ts
import { create } from "zustand";
import api        from "@/lib/axios";

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
  logout:         () => void;
  refreshSession: () => Promise<boolean>;
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

const persistAuth = (user: AuthUser, token: string, refreshToken: string | null) => {
  storage.setItem("token", token);
  storage.setItem("user",  JSON.stringify(user));
  if (refreshToken) {
    storage.setItem("refreshToken", refreshToken);
  } else {
    storage.removeItem("refreshToken");
  }
};

const clearPersistedAuth = () => {
  storage.removeItem("token");
  storage.removeItem("user");
  storage.removeItem("refreshToken");
};

// ─────────────────────────────────────────────────────────────────────────────
// STORE
// ─────────────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => ({
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
        const user = normaliseAuthUser(parsed);
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
    set({
      user,
      token,
      refreshToken,
      isAuthenticated: true,
      hasInitialized:  true,
      error:           null,
    });
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
        const { token, refreshToken, user } = extractAuthPayload(response.data);

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
export const useToken             = () => useAuthStore((s) => s.token);
export const useIsAuthed          = () => useAuthStore((s) => s.isAuthenticated);
export const useIsReady           = () => useAuthStore((s) => s.hasInitialized);
export const useIsLoading         = () => useAuthStore((s) => s.isLoading);
export const useAuthError         = () => useAuthStore((s) => s.error);
export const useEnrollmentNo      = () => useAuthStore((s) => s.user?.enrollmentNo ?? null);
export const useMustResetPassword = () => useAuthStore((s) => s.user?.mustResetPassword ?? false);
export const useIsStudent         = () => useAuthStore((s) => s.user?.role === "student");
export const useIsAdmin           = () => useAuthStore((s) =>
  ["admin", "school_admin", "super_admin"].includes(s.user?.role ?? ""),
);
export const useIsTeacher = () => useAuthStore((s) => s.user?.role === "teacher");