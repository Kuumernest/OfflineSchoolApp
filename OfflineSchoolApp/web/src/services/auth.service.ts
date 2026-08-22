// web/src/services/auth.service.ts
import api from "@/lib/axios";
import {
  useAuthStore,
  normaliseAuthUser,
  type AuthUser,
} from "@/store/auth.store";

// AuthUser is re-exported so existing importers of this module keep working.
export type { AuthUser };

export interface StaffLoginPayload {
  email:    string;
  password: string;
}

export interface StudentLoginPayload {
  enrollmentNo: string;
  password:     string;
}

export type LoginPayload = StaffLoginPayload | StudentLoginPayload;

export interface AuthResult {
  user:         AuthUser;
  token:        string;
  refreshToken: string | null;
}

export interface ChangePasswordPayload {
  currentPassword:  string;
  newPassword:      string;
  confirmPassword:  string;
}

const extractTokenAndUser = (data: Record<string, unknown>): AuthResult => {
  const token =
    (data.token        as string | undefined) ??
    (data.accessToken  as string | undefined) ??
    (data.jwt          as string | undefined) ??
    null;

  const refreshToken = (data.refreshToken as string | undefined) ?? null;

  // Only accept data.data as the user when it actually looks like one — an
  // error envelope such as { success: false, data: { items: [] } } would
  // otherwise be read as a user object.
  let rawUser =
    (data.user as Record<string, unknown> | undefined) ?? null;

  if (!rawUser && data.data && typeof data.data === "object") {
    const candidate = data.data as Record<string, unknown>;
    if (candidate._id || candidate.id) rawUser = candidate;
  }

  if (!token)   throw new Error("Auth response is missing a token");
  if (!rawUser) throw new Error("Auth response is missing user data");

  return { token, refreshToken, user: normaliseAuthUser(rawUser) };
};

export async function login(payload: LoginPayload): Promise<AuthResult> {
  const { data } = await api.post<Record<string, unknown>>("/auth/login", payload);
  const result   = extractTokenAndUser(data);
  useAuthStore.getState().setAuth(result.user, result.token);
  return result;
}

export async function staffLogin(email: string, password: string): Promise<AuthResult> {
  return login({ email: email.trim().toLowerCase(), password });
}

export async function studentLogin(enrollmentNo: string, password: string): Promise<AuthResult> {
  return login({ enrollmentNo: enrollmentNo.trim().toUpperCase(), password });
}

export async function logout(): Promise<void> {
  try { await api.post("/auth/logout"); } catch { /* ignore */ }
  useAuthStore.getState().logout();
}

export async function getMe(): Promise<AuthUser> {
  const { data } = await api.get<Record<string, unknown>>("/auth/me");
  const user  = normaliseAuthUser(
    (data.user as Record<string, unknown> | undefined) ?? data,
  );
  const store = useAuthStore.getState();
  if (store.token) store.setAuth(user, store.token);
  return user;
}

export async function refreshToken(currentRefreshToken?: string | null): Promise<AuthResult> {
  const { data } = await api.post<Record<string, unknown>>(
    "/auth/refresh",
    currentRefreshToken ? { refreshToken: currentRefreshToken } : {}
  );
  const result = extractTokenAndUser(data);
  useAuthStore.getState().setAuth(result.user, result.token);
  return result;
}

export async function changePassword(payload: ChangePasswordPayload): Promise<AuthResult> {
  const { data } = await api.post<Record<string, unknown>>("/auth/change-password", payload);
  const result   = extractTokenAndUser(data);
  useAuthStore.getState().setAuth(result.user, result.token);
  return result;
}

export const isStaffPayload   = (p: LoginPayload): p is StaffLoginPayload   => "email"        in p;
export const isStudentPayload = (p: LoginPayload): p is StudentLoginPayload => "enrollmentNo" in p;