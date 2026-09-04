// web/src/services/api.ts
//
// Re-export of the single axios instance in lib/axios.ts.
//
// This file used to create its OWN axios instance that read the bearer token
// from localStorage keys "auth_token" / "auth_user". The auth store writes
// "token" / "user", so every module importing from here — 13 of them, including
// the student, teacher, class and subject services — sent requests with no
// Authorization header at all and got a 401 on anything protected.
//
// Keeping the module as a re-export rather than deleting it means those imports
// keep working while all of them now share one instance, and therefore one
// token source, one refresh queue, and one 401 handler.

export { default } from "@/lib/axios";
export { default as api } from "@/lib/axios";
export { TIMEOUTS } from "@/lib/axios";
