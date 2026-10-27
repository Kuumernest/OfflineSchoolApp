// shared/dateFormat.d.ts — types for shared/dateFormat.js (web imports it).
type DateInput = string | number | Date | null | undefined;
export declare const formatDay: (value: DateInput, fallback?: string) => string;
export declare const formatTime: (value: DateInput, fallback?: string) => string;
export declare const formatDayTime: (value: DateInput, fallback?: string) => string;
