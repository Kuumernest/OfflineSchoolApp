// web/src/utils/genderLabel.ts
//
// A pupil's gender as every screen writes it.
//
// Enrolment offered "Prefer not to say", corrections printed "(empty)", the ID
// card a dash and the pupil's page the stored word itself ("female") — four
// renderings of the same record. A gender not given is stored as nothing (the
// model allows null) and READ as one phrase everywhere: "Not specified".

type T = (key: string) => string;

export const GENDER_VALUES = ["male", "female", "other"] as const;

export const genderLabel = (t: T, value: string | null | undefined): string =>
  value && (GENDER_VALUES as readonly string[]).includes(value)
    ? t(`common.${value}`)
    : t("common.notSpecified");
