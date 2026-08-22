// web/src/utils/unwrap.ts
//
// The backend is not consistent about how it wraps a payload. The same list can
// arrive as any of:
//
//   [ … ]                          (bare array)
//   { slots: [ … ], count: 4 }     (named key)
//   { data: [ … ] }                (generic envelope)
//   { success: true, data: [ … ] } (generic envelope with a flag)
//
// class.service.ts and subject.service.ts each grew a private copy of these two
// helpers. Sharing one copy means a new response shape only has to be taught
// here once, instead of being fixed in whichever service happened to hit it.

/** Pull a list out of any of the shapes above. Never throws; worst case: []. */
export function unwrapList<T = unknown>(data: unknown, primaryKey: string): T[] {
  if (Array.isArray(data)) return data as T[];

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj[primaryKey])) return obj[primaryKey] as T[];
    if (Array.isArray(obj.data))        return obj.data as T[];
    if (Array.isArray(obj.items))       return obj.items as T[];
  }

  return [];
}

/** Pull a single record out of an envelope, falling back to the body itself. */
export function unwrapSingle<T = unknown>(data: unknown, primaryKey: string): T {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (obj[primaryKey] !== undefined) return obj[primaryKey] as T;
    if (obj.data       !== undefined) return obj.data as T;
  }
  return data as T;
}

/**
 * Read a value that the API might send under either a camelCase or a
 * snake_case key. The mobile client writes snake_case into SQLite and some
 * endpoints echo that back, so both spellings show up in practice.
 */
export function pick<T = string>(
  row: Record<string, unknown>,
  ...keys: string[]
): T | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return null;
}
