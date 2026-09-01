// backend/db/models/Attendance.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

const studentAttendanceSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId:  { type: String, required: true },
    classId:   { type: String, required: true },
    subjectId: { type: String, default: null  },
    periodId:  { type: String, default: null  },

    studentId: { type: String, required: true, ref: "Student" },
    markedBy:  { type: String, required: true, ref: "User"    },

    date:     { type: String, required: true },
    markedAt: { type: Date,   default: () => new Date() },

    status: {
      type:     String,
      enum:     ["present", "absent", "late", "excused"],
      required: true,
    },

    note: { type: String, default: null },
  },
  {
    timestamps: true,
    _id:        false,
  }
);

// Unique constraint — one record per student/class/subject/period/date
studentAttendanceSchema.index(
  { schoolId: 1, classId: 1, studentId: 1, subjectId: 1, periodId: 1, date: 1 },
  { unique: true, name: "unique_student_attendance" }
);

studentAttendanceSchema.index({ schoolId: 1, date: 1, status: 1 });
studentAttendanceSchema.index({ classId:  1, date: 1             });
studentAttendanceSchema.index({ studentId: 1, date: 1            });
studentAttendanceSchema.index({ schoolId: 1, classId: 1, date: 1, periodId: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

const teacherAttendanceSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId:  { type: String, required: true },
    teacherId: { type: String, required: true, ref: "User" },
    markedBy:  { type: String, required: true, ref: "User" },

    date:     { type: String, required: true },
    markedAt: { type: Date,   default: () => new Date() },

    status: {
      type:     String,
      enum:     ["present", "absent", "late", "on_leave"],
      required: true,
    },

    checkInTime:  { type: String, default: null },
    checkOutTime: { type: String, default: null },
    note:         { type: String, default: null },
  },
  {
    timestamps: true,
    _id:        false,
  }
);

// One record per teacher per day
teacherAttendanceSchema.index(
  { schoolId: 1, teacherId: 1, date: 1 },
  { unique: true, name: "unique_teacher_attendance" }
);

teacherAttendanceSchema.index({ schoolId: 1, date: 1, status: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

const StudentAttendance = mongoose.model(
  "StudentAttendance",
  studentAttendanceSchema
);

const TeacherAttendance = mongoose.model(
  "TeacherAttendance",
  teacherAttendanceSchema
);

module.exports = { StudentAttendance, TeacherAttendance };