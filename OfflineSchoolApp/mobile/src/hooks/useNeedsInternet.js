// src/hooks/useNeedsInternet.js
"use strict";

/**
 * One way to say "this needs an internet connection".
 *
 * Most of this app works offline and queues its changes. A few actions do not
 * — the owner approved them as online-only (settings, publishing results,
 * PDFs and report cards, exports, payroll, starting a chat), and a few more
 * write straight to the server until they are made offline-capable. Those
 * used to fail with whatever the network layer said ("Network Error",
 * "Request failed…", or nothing at all). They now say, in the person's
 * language, that the action needs a connection — before trying when the
 * phone already knows it is offline, and after failing when the network
 * dropped mid-request.
 *
 *   const { isOnline, requireOnline, failureText } = useNeedsInternet();
 *   if (!(await requireOnline())) return;         // before the request
 *   catch (err) { Alert.alert(title, failureText(err, "x.saveFailed")); }
 *   <TouchableOpacity disabled={!isOnline} …/>     // and <NeedsInternetNote />
 */

import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useTranslation } from "../i18n/useTranslation";
import { errorText, SERVER_CODE_KEYS } from "../utils/appError";

export const NEEDS_INTERNET_TITLE_KEY = "common.needsInternetTitle";
export const NEEDS_INTERNET_KEY       = "common.needsInternet";

/** True when the request never got an answer: offline, DNS, timeout, refused locally. */
export const isOfflineError = (err) => {
  if (!err) return false;
  if (err.isOffline) return true;
  if (err.response) return false;
  return (
    err.code === "ERR_NETWORK" ||
    err.code === "ECONNABORTED" ||
    err.code === "ETIMEDOUT" ||
    err.message === "Network Error" ||
    /network request failed/i.test(String(err.message ?? ""))
  );
};

/** What NetInfo believes right now. Unknown counts as online: the request decides. */
export const isOnlineNow = async () => {
  try {
    const s = await NetInfo.fetch();
    return s?.isConnected !== false;
  } catch {
    return true;
  }
};

/**
 * The message for a failed online-only action: "needs an internet
 * connection" when it never reached the server; otherwise the translated
 * refusal (errorText) or the server's own sentence.
 */
export const needsInternetFailureText = (t, err, fallbackKey) => {
  if (isOfflineError(err)) return t(NEEDS_INTERNET_KEY);
  const code = err?.response?.data?.code;
  if (err?.i18nKey || (typeof code === "string" && Object.prototype.hasOwnProperty.call(SERVER_CODE_KEYS, code))) {
    return errorText(t, err, fallbackKey);
  }
  return err?.response?.data?.message || errorText(t, err, fallbackKey);
};

/** errorText, except that a failure for want of a connection says so. Drop-in. */
export const needsInternetErrorText = (t, err, fallbackKey) =>
  isOfflineError(err) ? t(NEEDS_INTERNET_KEY) : errorText(t, err, fallbackKey);

/** A screen's own failure text, unless the failure was having no connection. */
export const orNeedsInternet = (t, err, text) =>
  isOfflineError(err) ? t(NEEDS_INTERNET_KEY) : text;

/**
 * Before an online-only action: when offline, say so and answer false.
 * @param {(k:string)=>string} t
 * @param {{title?:string}} [opts]
 */
export const requireOnline = async (t, { title } = {}) => {
  if (await isOnlineNow()) return true;
  Alert.alert(title ?? t(NEEDS_INTERNET_TITLE_KEY), t(NEEDS_INTERNET_KEY));
  return false;
};

/** Live connectivity, for disabling an online-only button with an explanation. */
export const useIsOnline = () => {
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    let alive = true;
    NetInfo.fetch().then((s) => { if (alive) setIsOnline(s?.isConnected !== false); }).catch(() => {});
    const unsubscribe = NetInfo.addEventListener((s) => setIsOnline(s?.isConnected !== false));
    return () => { alive = false; unsubscribe?.(); };
  }, []);
  return isOnline;
};

export const useNeedsInternet = () => {
  const { t } = useTranslation();
  const isOnline = useIsOnline();
  const guard = useCallback((opts) => requireOnline(t, opts), [t]);
  const failureText = useCallback(
    (err, fallbackKey) => needsInternetFailureText(t, err, fallbackKey),
    [t]
  );
  return { isOnline, requireOnline: guard, failureText };
};

export default useNeedsInternet;
