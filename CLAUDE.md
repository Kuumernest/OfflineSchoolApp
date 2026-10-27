# OfflineSchoolApp

The app lives in `OfflineSchoolApp/` (backend, web, mobile, desktop, shared).
Pre-launch work is tracked in `OfflineSchoolApp/docs/launch-fixes.md`.

## Domain rules

- **One guardian can have many children.** Siblings sharing a guardian's name,
  email or phone (and a pupil email that is really the parent's) is normal,
  valid data — never a duplicate, never test data.
  - No uniqueness on guardian email / phone (or pupil email) across pupils.
  - One portal access code (`GuardianAccess.studentIds`) can cover several
    children, and the parent switches between them. Flag a code as "linked to
    no student" only when it has zero live children.
  - Fees, overdue flags and reminders are per child; the parent sees all their
    children.
  - Cleanup scripts clear only addresses on an explicit fake list, never an
    address because several pupils share it.
  - Test: `backend/scripts/check-guardian-siblings.js` (a guardian with three
    children).
