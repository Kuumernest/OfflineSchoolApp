/**
 * Maps local timetable slot (SQLite) to backend payload format
 */
export const mapLocalSlotToBackend = (localSlot) => {
  return {
    _id: localSlot._id || localSlot.id,
    schoolId: localSlot.schoolId,
    classId: localSlot.classId,
    subjectId: localSlot.subjectId,
    teacherId: localSlot.teacherId,
    dayOfWeek: localSlot.dayOfWeek,
    periodId: localSlot.periodId,
    room: localSlot.room || "",
    version: localSlot.version || 1,
    createdAt: localSlot.createdAt,
    updatedAt: localSlot.updatedAt || new Date().toISOString(),
    deletedAt: localSlot.deletedAt || null,
  };
};

/**
 * Maps backend timetable slot response to local SQLite format
 */
export const mapBackendSlotToLocal = (backendSlot) => {
  return {
    _id: backendSlot._id,
    schoolId: backendSlot.schoolId,
    classId: backendSlot.classId,
    subjectId: backendSlot.subjectId,
    teacherId: backendSlot.teacherId,
    dayOfWeek: backendSlot.dayOfWeek,
    periodId: backendSlot.periodId,
    room: backendSlot.room || "",
    version: backendSlot.version || 1,
    createdAt: backendSlot.createdAt,
    updatedAt: backendSlot.updatedAt,
    deletedAt: backendSlot.deletedAt || null,

    // Enriched fields (from joins)
    subjectName: backendSlot.subjectName || null,
    teacherName: backendSlot.teacherName || null,
    periodName: backendSlot.periodName || null,
    startTime: backendSlot.startTime || null,
    endTime: backendSlot.endTime || null,
    className: backendSlot.className || null,
  };
};

/**
 * Maps multiple backend slots to local format
 */
export const mapBackendSlotsToLocal = (backendSlots = []) => {
  return backendSlots.map(mapBackendSlotToLocal);
};

/**
 * Maps multiple local slots to backend format (for sync)
 */
export const mapLocalSlotsToBackend = (localSlots = []) => {
  return localSlots.map(mapLocalSlotToBackend);
};