// src/db/migrate.js

// ─────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────
const addColumnIfMissing = async (db, table, column, type) => {
  const cols = await db.getAllAsync(`PRAGMA table_info(${table})`);
  const exists = cols.some((c) => c.name.toLowerCase() === column.toLowerCase());
  if (!exists) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
    console.log(`✅ Added: ${table}.${column}`);
  }
};

// ─────────────────────────────────────────────────────────
// MIGRATIONS
// Add new ones at the bottom. Never edit existing ones.
// ─────────────────────────────────────────────────────────
const migrations = [

  // ── v1: Initial schema ────────────────────────────────
  {
    version: 1,
    description: "Initial schema — all base tables",
    up: async (db) => {
      await db.execAsync(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS users (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          email        TEXT,
          role         TEXT NOT NULL,
          schoolId     TEXT,
          isActive     INTEGER DEFAULT 1,
          passwordSalt TEXT,
          passwordHash TEXT,
          created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at   TEXT,
          version      INTEGER DEFAULT 1,
          deleted_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS classes (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT,
          name       TEXT NOT NULL,
          level      TEXT,
          is_active  INTEGER DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT
        );

        CREATE TABLE IF NOT EXISTS subjects (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT,
          name       TEXT NOT NULL,
          class_id   TEXT NOT NULL,
          teacher_id TEXT,
          code       TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT,
          FOREIGN KEY (class_id)   REFERENCES classes(id) ON DELETE CASCADE,
          FOREIGN KEY (teacher_id) REFERENCES users(id)   ON DELETE SET NULL,
          UNIQUE(name, class_id)
        );

        CREATE TABLE IF NOT EXISTS teachers (
          id         TEXT PRIMARY KEY,
          user_id    TEXT UNIQUE,
          department TEXT,
          phone      TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS students (
          id         TEXT PRIMARY KEY,
          user_id    TEXT UNIQUE,
          class_id   TEXT,
          status     TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT,
          FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE,
          FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS periods (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT NOT NULL,
          name       TEXT NOT NULL,
          starttime  TEXT NOT NULL,
          endtime    TEXT NOT NULL,
          sortorder  INTEGER DEFAULT 0,
          isbreak    INTEGER DEFAULT 0,
          isactive   INTEGER DEFAULT 1,
          version    INTEGER DEFAULT 1,
          deletedat  TEXT DEFAULT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          _synced    INTEGER DEFAULT 0,
          _syncedAt  TEXT DEFAULT NULL,
          dirty      INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS timetable (
          id          TEXT PRIMARY KEY,
          school_id   TEXT,
          class_id    TEXT NOT NULL,
          subject_id  TEXT NOT NULL,
          teacher_id  TEXT,
          day_of_week TEXT NOT NULL,
          period_id   TEXT,
          room        TEXT,
          created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at  TEXT,
          version     INTEGER DEFAULT 1,
          deleted_at  TEXT,
          FOREIGN KEY (class_id)   REFERENCES classes(id)  ON DELETE CASCADE,
          FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
          FOREIGN KEY (teacher_id) REFERENCES users(id)    ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS assignments (
          id          TEXT PRIMARY KEY,
          class_id    TEXT,
          subject_id  TEXT,
          teacher_id  TEXT,
          title       TEXT NOT NULL,
          description TEXT,
          due_date    TEXT,
          created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at  TEXT,
          version     INTEGER DEFAULT 1,
          deleted_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS announcements (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          message     TEXT NOT NULL,
          target_role TEXT,
          class_id    TEXT,
          is_active   INTEGER DEFAULT 1,
          expires_at  TEXT,
          created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at  TEXT,
          version     INTEGER DEFAULT 1,
          deleted_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS attendance (
          id         TEXT PRIMARY KEY,
          student_id TEXT NOT NULL,
          class_id   TEXT NOT NULL,
          date       TEXT NOT NULL,
          status     TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT
        );

        CREATE TABLE IF NOT EXISTS subject_assignments (
          id         TEXT PRIMARY KEY,
          class_id   TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          teacher_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT,
          UNIQUE(teacher_id, class_id, subject_id)
        );

        CREATE TABLE IF NOT EXISTS teacher_assignments (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT,
          teacherId  TEXT,
          classId    TEXT,
          subjectId  TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          _synced    INTEGER DEFAULT 0,
          deleted_at TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_queue (
          id         TEXT PRIMARY KEY,
          entity     TEXT NOT NULL,
          operation  TEXT NOT NULL,
          payload    TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          synced     INTEGER DEFAULT 0
        );
      `);
    },
  },

  // ── v2: Indexes ───────────────────────────────────────
  {
    version: 2,
    description: "Add indexes for common queries",
    up: async (db) => {
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_users_role
          ON users(role);
        CREATE INDEX IF NOT EXISTS idx_classes_name
          ON classes(name);
        CREATE INDEX IF NOT EXISTS idx_subjects_class
          ON subjects(class_id);
        CREATE INDEX IF NOT EXISTS idx_subjects_teacher
          ON subjects(teacher_id);
        CREATE INDEX IF NOT EXISTS idx_students_class
          ON students(class_id);
        CREATE INDEX IF NOT EXISTS idx_students_status
          ON students(status);
        CREATE INDEX IF NOT EXISTS idx_timetable_class
          ON timetable(class_id);
        CREATE INDEX IF NOT EXISTS idx_timetable_teacher
          ON timetable(teacher_id);
        CREATE INDEX IF NOT EXISTS idx_assignments_class
          ON assignments(class_id);
        CREATE INDEX IF NOT EXISTS idx_announcements_active
          ON announcements(is_active);
        CREATE INDEX IF NOT EXISTS idx_periods_school
          ON periods(schoolId, isactive, deletedat);
      `);
    },
  },

  // ── v3: Sync columns ──────────────────────────────────
  {
    version: 3,
    description: "Add _synced and _synced_at to all tables",
    up: async (db) => {
      const tables = [
        "users", "classes", "subjects", "teachers",
        "students", "timetable", "assignments",
        "announcements", "attendance", "subject_assignments",
      ];
      for (const table of tables) {
        await addColumnIfMissing(db, table, "_synced",    "INTEGER DEFAULT 0");
        await addColumnIfMissing(db, table, "_synced_at", "TEXT");
      }
    },
  },

  // ── v4: Timetable — migrate id → _id ─────────────────
  {
    version: 4,
    description: "Timetable — rename id to _id for UUID sync",
    up: async (db) => {
      const cols            = await db.getAllAsync(`PRAGMA table_info(timetable)`);
      const hasId           = cols.some((c) => c.name === "id");
      const hasUnderscoreId = cols.some((c) => c.name === "_id");

      if (hasId && !hasUnderscoreId) {
        console.log("🔧 Migrating timetable: id → _id");
        await db.execAsync(`
          ALTER TABLE timetable RENAME TO timetable_old;

          CREATE TABLE timetable (
            _id         TEXT PRIMARY KEY,
            school_id   TEXT,
            class_id    TEXT NOT NULL,
            subject_id  TEXT NOT NULL,
            teacher_id  TEXT NOT NULL,
            day_of_week TEXT NOT NULL,
            period_id   TEXT NOT NULL,
            room        TEXT,
            version     INTEGER DEFAULT 1,
            deleted_at  TEXT,
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            _synced     INTEGER DEFAULT 0,
            _synced_at  TEXT
          );

          INSERT INTO timetable (
            _id, school_id, class_id, subject_id, teacher_id,
            day_of_week, period_id, room, version, deleted_at,
            created_at, updated_at
          )
          SELECT
            id, school_id, class_id, subject_id, teacher_id,
            day_of_week, period_id, room, version, deleted_at,
            created_at, updated_at
          FROM timetable_old;

          DROP TABLE timetable_old;
        `);
        console.log("✅ Timetable migrated to _id");
      }
    },
  },

  // ── v5: Patch periods columns ─────────────────────────
  {
    version: 5,
    description: "Ensure periods has all required columns",
    up: async (db) => {
      const toAdd = [
        { name: "starttime", def: "TEXT" },
        { name: "endtime",   def: "TEXT" },
        { name: "sortorder", def: "INTEGER DEFAULT 0" },
        { name: "isbreak",   def: "INTEGER DEFAULT 0" },
        { name: "isactive",  def: "INTEGER DEFAULT 1" },
        { name: "deletedat", def: "TEXT DEFAULT NULL" },
        { name: "dirty",     def: "INTEGER DEFAULT 0" },
        { name: "_syncedAt", def: "TEXT DEFAULT NULL" },
        { name: "schoolId",  def: "TEXT" },
      ];
      for (const col of toAdd) {
        await addColumnIfMissing(db, "periods", col.name, col.def);
      }
    },
  },

  // ── v6: Add timetable_slots table ─────────────────────
  {
    version: 6,
    description: "Add timetable_slots table for sync",
    up: async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS timetable_slots (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT NOT NULL,
          classId    TEXT NOT NULL,
          subjectId  TEXT NOT NULL,
          teacherId  TEXT NOT NULL,
          periodId   TEXT NOT NULL,
          dayOfWeek  INTEGER NOT NULL,
          room       TEXT DEFAULT '',
          version    INTEGER DEFAULT 1,
          deletedat  TEXT DEFAULT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          _synced    INTEGER DEFAULT 0,
          _syncedAt  TEXT DEFAULT NULL,
          dirty      INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_slots_school_class
          ON timetable_slots(schoolId, classId, dayOfWeek);
        CREATE INDEX IF NOT EXISTS idx_slots_teacher
          ON timetable_slots(schoolId, teacherId, dayOfWeek);
      `);
    },
  },

  // ── v7: Force-rebuild periods if starttime missing ────
  {
    version: 7,
    description: "Rebuild periods if starttime column missing",
    up: async (db) => {
      const cols         = await db.getAllAsync(`PRAGMA table_info(periods)`);
      const hasStarttime = cols.some((c) => c.name.toLowerCase() === "starttime");

      if (hasStarttime) {
        console.log("✅ periods.starttime exists — skipping rebuild");
        return;
      }

      console.log("🔧 Rebuilding periods table with correct schema");
      await db.execAsync(`
        DROP TABLE IF EXISTS periods;

        CREATE TABLE periods (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT NOT NULL,
          name       TEXT NOT NULL,
          starttime  TEXT NOT NULL DEFAULT '00:00',
          endtime    TEXT NOT NULL DEFAULT '00:00',
          sortorder  INTEGER DEFAULT 0,
          isbreak    INTEGER DEFAULT 0,
          isactive   INTEGER DEFAULT 1,
          version    INTEGER DEFAULT 1,
          deletedat  TEXT DEFAULT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          _synced    INTEGER DEFAULT 0,
          _syncedAt  TEXT DEFAULT NULL,
          dirty      INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_periods_school
          ON periods(schoolId, isactive, deletedat);
      `);
      console.log("✅ periods table rebuilt");
    },
  },

  // ── v8: Add missing columns to classes ───────────────
  {
    version: 8,
    description: "Add missing columns to classes table",
    up: async (db) => {
      const toAdd = [
        { name: "section",    def: "TEXT" },
        { name: "level",      def: "TEXT" },
        { name: "schoolId",   def: "TEXT" },
        { name: "is_active",  def: "INTEGER DEFAULT 1" },
        { name: "deleted_at", def: "TEXT DEFAULT NULL" },
      ];
      for (const col of toAdd) {
        await addColumnIfMissing(db, "classes", col.name, col.def);
      }
    },
  },

  // ── v9: Fix subject_assignments unique constraint ─────
  {
    version: 9,
    description: "Fix subject_assignments unique constraint",
    up: async (db) => {
      console.log("🔧 Rebuilding subject_assignments...");

      const tables = await db.getAllAsync(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name='subject_assignments'`
      );

      if (tables.length === 0) {
        await db.execAsync(`
          CREATE TABLE subject_assignments (
            id         TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL,
            class_id   TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT,
            version    INTEGER DEFAULT 1,
            deleted_at TEXT,
            UNIQUE(teacher_id, class_id, subject_id)
          );
          CREATE INDEX IF NOT EXISTS idx_sa_teacher
            ON subject_assignments(teacher_id);
          CREATE INDEX IF NOT EXISTS idx_sa_class
            ON subject_assignments(class_id);
          CREATE INDEX IF NOT EXISTS idx_sa_subject
            ON subject_assignments(subject_id);
        `);
        console.log("✅ subject_assignments created");
        return;
      }

      await db.execAsync(`
        ALTER TABLE subject_assignments RENAME TO subject_assignments_old;

        CREATE TABLE subject_assignments (
          id         TEXT PRIMARY KEY,
          teacher_id TEXT NOT NULL,
          class_id   TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT,
          UNIQUE(teacher_id, class_id, subject_id)
        );

        INSERT OR IGNORE INTO subject_assignments
          (id, teacher_id, class_id, subject_id,
           created_at, updated_at, version, deleted_at)
        SELECT
          id, teacher_id, class_id, subject_id,
          created_at, updated_at, version, deleted_at
        FROM subject_assignments_old;

        DROP TABLE subject_assignments_old;

        CREATE INDEX IF NOT EXISTS idx_sa_teacher
          ON subject_assignments(teacher_id);
        CREATE INDEX IF NOT EXISTS idx_sa_class
          ON subject_assignments(class_id);
        CREATE INDEX IF NOT EXISTS idx_sa_subject
          ON subject_assignments(subject_id);
      `);
      console.log("✅ subject_assignments rebuilt");
    },
  },

  // ── v10: Add profile columns to students ─────────────
  {
    version: 10,
    description: "Add denormalised profile columns to students table",
    up: async (db) => {
      const toAdd = [
        { name: "name",          def: "TEXT" },
        { name: "email",         def: "TEXT" },
        { name: "phone",         def: "TEXT" },
        { name: "gender",        def: "TEXT" },
        { name: "grade",         def: "TEXT" },
        { name: "guardian_name", def: "TEXT" },
        { name: "schoolId",      def: "TEXT" },
        { name: "is_active",     def: "INTEGER DEFAULT 1" },
        { name: "class_name",    def: "TEXT" },
      ];
      for (const col of toAdd) {
        await addColumnIfMissing(db, "students", col.name, col.def);
      }
      console.log("✅ students profile columns ready");
    },
  },

  // ── v11: Rebuild subjects — allow NULL class_id ───────
  {
    version: 11,
    description: "Rebuild subjects to allow NULL class_id and add teacher_name",
    up: async (db) => {
      const cols           = await db.getAllAsync(`PRAGMA table_info(subjects)`);
      const classIdCol     = cols.find((c) => c.name === "class_id");
      const needsRebuild   = classIdCol?.notnull === 1;
      const hasTeacherName = cols.some((c) => c.name === "teacher_name");

      if (!needsRebuild && hasTeacherName) {
        console.log("✅ subjects schema already correct — skipping rebuild");
        return;
      }

      console.log("🔧 Rebuilding subjects table...");
      await db.execAsync(`
        ALTER TABLE subjects RENAME TO subjects_old;

        CREATE TABLE subjects (
          id           TEXT PRIMARY KEY,
          schoolId     TEXT,
          name         TEXT NOT NULL,
          class_id     TEXT,
          teacher_id   TEXT,
          teacher_name TEXT,
          code         TEXT,
          created_at   TEXT DEFAULT NULL,
          updated_at   TEXT,
          version      INTEGER DEFAULT 1,
          deleted_at   TEXT,
          _synced      INTEGER DEFAULT 0,
          _synced_at   TEXT,
          FOREIGN KEY (class_id)   REFERENCES classes(id) ON DELETE SET NULL,
          FOREIGN KEY (teacher_id) REFERENCES users(id)   ON DELETE SET NULL,
          UNIQUE(name, class_id)
        );

        INSERT OR IGNORE INTO subjects (
          id, schoolId, name, class_id, teacher_id,
          code, created_at, updated_at, version,
          deleted_at, _synced, _synced_at
        )
        SELECT
          id, schoolId, name, class_id, teacher_id,
          code, created_at, updated_at, version,
          deleted_at, _synced, _synced_at
        FROM subjects_old;

        DROP TABLE subjects_old;

        CREATE INDEX IF NOT EXISTS idx_subjects_class
          ON subjects(class_id);
        CREATE INDEX IF NOT EXISTS idx_subjects_teacher
          ON subjects(teacher_id);
      `);
      console.log("✅ subjects rebuilt — class_id nullable, teacher_name added");
    },
  },

  // ── v12: Rebuild subject_assignments — allow NULL ─────
  {
    version: 12,
    description: "Rebuild subject_assignments to allow NULL class_id and subject_id",
    up: async (db) => {
      const cols     = await db.getAllAsync(`PRAGMA table_info(subject_assignments)`);
      const classCol = cols.find((c) => c.name === "class_id");
      const subjCol  = cols.find((c) => c.name === "subject_id");
      const needsRebuild =
        classCol?.notnull === 1 || subjCol?.notnull === 1;

      if (!needsRebuild) {
        console.log("✅ subject_assignments already nullable — skipping");
        return;
      }

      console.log("🔧 Rebuilding subject_assignments — removing NOT NULL...");
      await db.execAsync(`
        ALTER TABLE subject_assignments RENAME TO subject_assignments_old;

        CREATE TABLE subject_assignments (
          id         TEXT PRIMARY KEY,
          teacher_id TEXT NOT NULL,
          class_id   TEXT,
          subject_id TEXT,
          created_at TEXT DEFAULT NULL,
          updated_at TEXT,
          version    INTEGER DEFAULT 1,
          deleted_at TEXT,
          _synced    INTEGER DEFAULT 0,
          _synced_at TEXT,
          UNIQUE(teacher_id, class_id, subject_id)
        );

        INSERT OR IGNORE INTO subject_assignments (
          id, teacher_id, class_id, subject_id,
          created_at, updated_at, version, deleted_at
        )
        SELECT
          id, teacher_id, class_id, subject_id,
          created_at, updated_at, version, deleted_at
        FROM subject_assignments_old;

        DROP TABLE subject_assignments_old;

        CREATE INDEX IF NOT EXISTS idx_sa_teacher
          ON subject_assignments(teacher_id);
        CREATE INDEX IF NOT EXISTS idx_sa_class
          ON subject_assignments(class_id);
        CREATE INDEX IF NOT EXISTS idx_sa_subject
          ON subject_assignments(subject_id);
      `);
      console.log("✅ subject_assignments rebuilt with nullable columns");
    },
  },

  // ── v13: Attendance tables ────────────────────────────
  {
    version: 13,
    description: "Rebuild attendance and create teacher_attendance",
    up: async (db) => {
      const attCols   = await db.getAllAsync(`PRAGMA table_info(attendance)`);
      const hasAttCol = (name) => attCols.some((c) => c.name === name);

      const attToAdd = [
        { name: "schoolId",   def: "TEXT" },
        { name: "classId",    def: "TEXT" },
        { name: "subjectId",  def: "TEXT" },
        { name: "periodId",   def: "TEXT" },
        { name: "studentId",  def: "TEXT" },
        { name: "note",       def: "TEXT" },
        { name: "_synced",    def: "INTEGER DEFAULT 0" },
        { name: "_synced_at", def: "TEXT" },
        { name: "updated_at", def: "TEXT" },
      ];

      for (const col of attToAdd) {
        if (!hasAttCol(col.name)) {
          await db.execAsync(
            `ALTER TABLE attendance ADD COLUMN ${col.name} ${col.def};`
          ).catch((err) => {
            if (!err.message?.includes("duplicate column")) {
              console.warn(`Could not add attendance.${col.name}:`, err.message);
            }
          });
        }
      }

      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_attendance_date
          ON attendance(date);
        CREATE INDEX IF NOT EXISTS idx_attendance_class_date
          ON attendance(classId, date);
        CREATE INDEX IF NOT EXISTS idx_attendance_student
          ON attendance(studentId, date);
        CREATE INDEX IF NOT EXISTS idx_attendance_synced
          ON attendance(_synced);
      `).catch(() => {});

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS teacher_attendance (
          id           TEXT PRIMARY KEY,
          schoolId     TEXT,
          teacherId    TEXT NOT NULL,
          date         TEXT NOT NULL,
          status       TEXT NOT NULL,
          checkInTime  TEXT,
          checkOutTime TEXT,
          note         TEXT,
          _synced      INTEGER DEFAULT 0,
          _synced_at   TEXT,
          created_at   TEXT DEFAULT NULL,
          updated_at   TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_teacher_attendance_date
          ON teacher_attendance(date);
        CREATE INDEX IF NOT EXISTS idx_teacher_attendance_teacher
          ON teacher_attendance(teacherId, date);
        CREATE INDEX IF NOT EXISTS idx_teacher_attendance_synced
          ON teacher_attendance(_synced);
      `);

      console.log("✅ attendance and teacher_attendance ready");
    },
  },

  // ── v14: Report templates and generated reports ───────
  {
    version: 14,
    description: "Add report_templates, generated_reports and template_versions tables",
    up: async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS report_templates (
          id          TEXT PRIMARY KEY,
          server_id   TEXT UNIQUE,
          school_id   TEXT NOT NULL,
          name        TEXT NOT NULL,
          level       TEXT,
          html        TEXT NOT NULL,
          css         TEXT,
          layout_json TEXT,
          is_default  INTEGER DEFAULT 0,
          is_locked   INTEGER DEFAULT 0,
          version     INTEGER DEFAULT 1,
          _synced     INTEGER DEFAULT 0,
          updated_at  TEXT,
          created_at  TEXT DEFAULT (datetime('now')),
          deleted_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS generated_reports (
          id            TEXT PRIMARY KEY,
          server_id     TEXT UNIQUE,
          student_id    TEXT NOT NULL,
          template_id   TEXT NOT NULL,
          term          TEXT NOT NULL,
          academic_year TEXT NOT NULL,
          pdf_path      TEXT,
          is_published  INTEGER DEFAULT 0,
          is_locked     INTEGER DEFAULT 0,
          generated_at  TEXT DEFAULT (datetime('now')),
          _synced       INTEGER DEFAULT 0,
          deleted_at    TEXT,
          FOREIGN KEY (template_id) REFERENCES report_templates(id)
        );

        CREATE TABLE IF NOT EXISTS template_versions (
          id          TEXT PRIMARY KEY,
          template_id TEXT NOT NULL,
          version     INTEGER NOT NULL,
          html        TEXT NOT NULL,
          css         TEXT,
          layout_json TEXT,
          saved_at    TEXT DEFAULT (datetime('now')),
          saved_by    TEXT,
          FOREIGN KEY (template_id) REFERENCES report_templates(id)
        );

        CREATE INDEX IF NOT EXISTS idx_report_templates_school
          ON report_templates(school_id);
        CREATE INDEX IF NOT EXISTS idx_report_templates_default
          ON report_templates(school_id, is_default);
        CREATE INDEX IF NOT EXISTS idx_generated_reports_student
          ON generated_reports(student_id);
        CREATE INDEX IF NOT EXISTS idx_generated_reports_term
          ON generated_reports(term, academic_year);
        CREATE INDEX IF NOT EXISTS idx_generated_reports_template
          ON generated_reports(template_id);
        CREATE INDEX IF NOT EXISTS idx_template_versions_template
          ON template_versions(template_id, version);
      `);

      console.log("✅ report_templates, generated_reports, template_versions ready");
    },
  },

  // ── v15: Add student marks table ──────────────────────
  {
    version: 15,
    description: "Add student_marks table for report generation",
    up: async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS student_marks (
          id           TEXT PRIMARY KEY,
          schoolId     TEXT NOT NULL,
          studentId    TEXT NOT NULL,
          subjectId    TEXT NOT NULL,
          examId       TEXT,
          term         TEXT NOT NULL,
          academicYear TEXT NOT NULL,
          caScore      REAL,
          examScore    REAL,
          score        REAL,
          grade        TEXT,
          remark       TEXT,
          _synced      INTEGER DEFAULT 0,
          _synced_at   TEXT,
          created_at   TEXT DEFAULT (datetime('now')),
          updated_at   TEXT,
          deleted_at   TEXT,
          UNIQUE(studentId, subjectId, term, academicYear)
        );

        CREATE INDEX IF NOT EXISTS idx_student_marks_student
          ON student_marks(studentId, term, academicYear);
        CREATE INDEX IF NOT EXISTS idx_student_marks_subject
          ON student_marks(subjectId, term, academicYear);
        CREATE INDEX IF NOT EXISTS idx_student_marks_exam
          ON student_marks(examId);
        CREATE INDEX IF NOT EXISTS idx_student_marks_synced
          ON student_marks(_synced);
      `);

      console.log("✅ student_marks table ready");
    },
  },

  // ── v16: Add schools table ────────────────────────────
  {
    version: 16,
    description: "Add schools table for report school info",
    up: async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS schools (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          motto          TEXT,
          address        TEXT,
          phone          TEXT,
          email          TEXT,
          principalName  TEXT,
          logoBase64     TEXT,
          _synced        INTEGER DEFAULT 0,
          _synced_at     TEXT,
          created_at     TEXT DEFAULT (datetime('now')),
          updated_at     TEXT,
          deleted_at     TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_schools_id
          ON schools(id);
      `);

      console.log("✅ schools table ready");
    },
  },

  // ── v17: Add extra student columns for reports ────────
  {
    version: 17,
    description: "Add report-related columns to students table",
    up: async (db) => {
      const toAdd = [
        { name: "studentId",       def: "TEXT" },
        { name: "admissionNumber", def: "TEXT" },
        { name: "dateOfBirth",     def: "TEXT" },
        { name: "photoBase64",     def: "TEXT" },
        { name: "classId",         def: "TEXT" },
        { name: "stream",          def: "TEXT" },
      ];
      for (const col of toAdd) {
        await addColumnIfMissing(db, "students", col.name, col.def);
      }
      console.log("✅ students report columns ready");
    },
  },

  // ── v18: Quiz Module ──────────────────────────────────
  {
    version: 18,
    description: "Add quiz module — question bank, quizzes, attempts, analytics",
    up: async (db) => {
      await db.execAsync(`

        CREATE TABLE IF NOT EXISTS question_categories (
          id          TEXT PRIMARY KEY,
          schoolId    TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT,
          parent_id   TEXT DEFAULT NULL,
          is_active   INTEGER DEFAULT 1,
          created_at  TEXT DEFAULT (datetime('now')),
          updated_at  TEXT,
          deleted_at  TEXT,
          _synced     INTEGER DEFAULT 0,
          _synced_at  TEXT,
          FOREIGN KEY (parent_id) REFERENCES question_categories(id)
        );

        CREATE TABLE IF NOT EXISTS questions (
          id            TEXT PRIMARY KEY,
          schoolId      TEXT NOT NULL,
          category_id   TEXT,
          question_text TEXT NOT NULL,
          question_type TEXT NOT NULL
                          CHECK(question_type IN (
                            'multiple_choice','multiple_select',
                            'true_false','fill_in_the_blank','matching'
                          )),
          media_url     TEXT DEFAULT NULL,
          difficulty    TEXT DEFAULT 'medium'
                          CHECK(difficulty IN ('easy','medium','hard')),
          points        REAL DEFAULT 1.0,
          explanation   TEXT DEFAULT NULL,
          is_active     INTEGER DEFAULT 1,
          created_by    TEXT NOT NULL,
          created_at    TEXT DEFAULT (datetime('now')),
          updated_at    TEXT,
          deleted_at    TEXT,
          _synced       INTEGER DEFAULT 0,
          _synced_at    TEXT,
          FOREIGN KEY (category_id) REFERENCES question_categories(id),
          FOREIGN KEY (created_by)  REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS question_options (
          id            TEXT PRIMARY KEY,
          question_id   TEXT NOT NULL,
          option_text   TEXT NOT NULL,
          is_correct    INTEGER DEFAULT 0,
          match_pair    TEXT DEFAULT NULL,
          display_order INTEGER DEFAULT 0,
          created_at    TEXT DEFAULT (datetime('now')),
          updated_at    TEXT,
          FOREIGN KEY (question_id)
            REFERENCES questions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quizzes (
          id                 TEXT PRIMARY KEY,
          schoolId           TEXT NOT NULL,
          title              TEXT NOT NULL,
          description        TEXT,
          instructions       TEXT,
          subject_id         TEXT,
          class_id           TEXT,
          time_limit_minutes INTEGER DEFAULT NULL,
          time_per_question  INTEGER DEFAULT NULL,
          shuffle_questions  INTEGER DEFAULT 0,
          shuffle_options    INTEGER DEFAULT 0,
          questions_per_page INTEGER DEFAULT 1,
          allow_backtrack    INTEGER DEFAULT 1,
          max_attempts       INTEGER DEFAULT 1,
          passing_score      REAL DEFAULT 70.0,
          available_from     TEXT DEFAULT NULL,
          available_until    TEXT DEFAULT NULL,
          password           TEXT DEFAULT NULL,
          show_answers_after TEXT DEFAULT 'on_completion'
                               CHECK(show_answers_after IN (
                                 'immediately','on_completion',
                                 'after_deadline','never'
                               )),
          show_score         INTEGER DEFAULT 1,
          show_explanation   INTEGER DEFAULT 1,
          is_published       INTEGER DEFAULT 0,
          created_by         TEXT NOT NULL,
          created_at         TEXT DEFAULT (datetime('now')),
          updated_at         TEXT,
          deleted_at         TEXT,
          _synced            INTEGER DEFAULT 0,
          _synced_at         TEXT,
          FOREIGN KEY (created_by) REFERENCES users(id),
          FOREIGN KEY (subject_id) REFERENCES subjects(id),
          FOREIGN KEY (class_id)   REFERENCES classes(id)
        );

        CREATE TABLE IF NOT EXISTS quiz_questions (
          id              TEXT PRIMARY KEY,
          quiz_id         TEXT NOT NULL,
          question_id     TEXT NOT NULL,
          display_order   INTEGER DEFAULT 0,
          points_override REAL DEFAULT NULL,
          created_at      TEXT DEFAULT (datetime('now')),
          UNIQUE(quiz_id, question_id),
          FOREIGN KEY (quiz_id)     REFERENCES quizzes(id)   ON DELETE CASCADE,
          FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quiz_question_pools (
          id            TEXT PRIMARY KEY,
          quiz_id       TEXT NOT NULL,
          category_id   TEXT NOT NULL,
          num_questions INTEGER NOT NULL,
          difficulty    TEXT DEFAULT 'any'
                          CHECK(difficulty IN ('easy','medium','hard','any')),
          created_at    TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (quiz_id)     REFERENCES quizzes(id)              ON DELETE CASCADE,
          FOREIGN KEY (category_id) REFERENCES question_categories(id)
        );

        CREATE TABLE IF NOT EXISTS quiz_attempts (
          id              TEXT PRIMARY KEY,
          quiz_id         TEXT NOT NULL,
          user_id         TEXT NOT NULL,
          attempt_number  INTEGER NOT NULL DEFAULT 1,
          status          TEXT DEFAULT 'in_progress'
                            CHECK(status IN (
                              'in_progress','submitted','timed_out','abandoned'
                            )),
          raw_score       REAL DEFAULT 0,
          max_score       REAL DEFAULT 0,
          percentage      REAL DEFAULT 0,
          is_passed       INTEGER DEFAULT 0,
          started_at      TEXT DEFAULT (datetime('now')),
          submitted_at    TEXT DEFAULT NULL,
          time_taken_secs INTEGER DEFAULT NULL,
          tab_switches    INTEGER DEFAULT 0,
          _synced         INTEGER DEFAULT 0,
          _synced_at      TEXT,
          UNIQUE(quiz_id, user_id, attempt_number),
          FOREIGN KEY (quiz_id) REFERENCES quizzes(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS attempt_answers (
          id                 TEXT PRIMARY KEY,
          attempt_id         TEXT NOT NULL,
          question_id        TEXT NOT NULL,
          selected_option_id TEXT DEFAULT NULL,
          text_answer        TEXT DEFAULT NULL,
          is_correct         INTEGER DEFAULT NULL,
          points_earned      REAL DEFAULT 0,
          points_possible    REAL DEFAULT 0,
          time_spent_secs    INTEGER DEFAULT NULL,
          is_flagged         INTEGER DEFAULT 0,
          answered_at        TEXT DEFAULT NULL,
          FOREIGN KEY (attempt_id)
            REFERENCES quiz_attempts(id) ON DELETE CASCADE,
          FOREIGN KEY (question_id)
            REFERENCES questions(id),
          FOREIGN KEY (selected_option_id)
            REFERENCES question_options(id)
        );

        CREATE TABLE IF NOT EXISTS attempt_answer_selections (
          id                 TEXT PRIMARY KEY,
          attempt_answer_id  TEXT NOT NULL,
          selected_option_id TEXT NOT NULL,
          FOREIGN KEY (attempt_answer_id)
            REFERENCES attempt_answers(id) ON DELETE CASCADE,
          FOREIGN KEY (selected_option_id)
            REFERENCES question_options(id)
        );

        CREATE TABLE IF NOT EXISTS question_analytics (
          id               TEXT PRIMARY KEY,
          question_id      TEXT NOT NULL UNIQUE,
          times_shown      INTEGER DEFAULT 0,
          times_answered   INTEGER DEFAULT 0,
          times_correct    INTEGER DEFAULT 0,
          times_skipped    INTEGER DEFAULT 0,
          avg_time_secs    REAL DEFAULT 0,
          difficulty_score REAL DEFAULT 0,
          last_updated     TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (question_id) REFERENCES questions(id)
        );

        CREATE TABLE IF NOT EXISTS quiz_analytics (
          id                TEXT PRIMARY KEY,
          quiz_id           TEXT NOT NULL UNIQUE,
          total_attempts    INTEGER DEFAULT 0,
          total_completions INTEGER DEFAULT 0,
          total_passes      INTEGER DEFAULT 0,
          avg_score         REAL DEFAULT 0,
          avg_time_secs     REAL DEFAULT 0,
          highest_score     REAL DEFAULT 0,
          lowest_score      REAL DEFAULT 0,
          last_updated      TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
        );

        CREATE INDEX IF NOT EXISTS idx_questions_category
          ON questions(category_id);
        CREATE INDEX IF NOT EXISTS idx_questions_type
          ON questions(question_type, difficulty);
        CREATE INDEX IF NOT EXISTS idx_questions_school
          ON questions(schoolId, is_active);
        CREATE INDEX IF NOT EXISTS idx_quizzes_school
          ON quizzes(schoolId, is_published);
        CREATE INDEX IF NOT EXISTS idx_quizzes_subject
          ON quizzes(subject_id);
        CREATE INDEX IF NOT EXISTS idx_quizzes_class
          ON quizzes(class_id);
        CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz
          ON quiz_questions(quiz_id, display_order);
        CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user
          ON quiz_attempts(user_id, quiz_id);
        CREATE INDEX IF NOT EXISTS idx_quiz_attempts_status
          ON quiz_attempts(status);
        CREATE INDEX IF NOT EXISTS idx_quiz_attempts_synced
          ON quiz_attempts(_synced);
        CREATE INDEX IF NOT EXISTS idx_attempt_answers_attempt
          ON attempt_answers(attempt_id);
        CREATE INDEX IF NOT EXISTS idx_attempt_answers_flagged
          ON attempt_answers(attempt_id, is_flagged);
      `);

      console.log("✅ Quiz module tables and indexes ready");
    },
  },

  // ── v19: Quiz ownership indexes ───────────────────────
  {
    version: 19,
    description: "Make class_id, subject_id, created_by required on quizzes",
    up: async (db) => {
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_quizzes_class
          ON quizzes(class_id);
        CREATE INDEX IF NOT EXISTS idx_quizzes_subject
          ON quizzes(subject_id);
        CREATE INDEX IF NOT EXISTS idx_quizzes_teacher
          ON quizzes(created_by);
        CREATE INDEX IF NOT EXISTS idx_quizzes_class_subject
          ON quizzes(class_id, subject_id, is_published);
      `).catch(() => {});

      console.log("✅ Quiz ownership indexes ready");
    },
  },

  // ── v20: Homework Module ──────────────────────────────
  {
    version: 20,
    description: "Add homework module — assignments and submissions",
    up: async (db) => {
      await db.execAsync(`

        CREATE TABLE IF NOT EXISTS homework (
          id              TEXT PRIMARY KEY,
          schoolId        TEXT NOT NULL,
          class_id        TEXT NOT NULL,
          subject_id      TEXT NOT NULL,
          created_by      TEXT NOT NULL,
          title           TEXT NOT NULL,
          description     TEXT,
          instructions    TEXT,
          due_date        TEXT,
          max_score       REAL    DEFAULT 100,
          allow_late      INTEGER DEFAULT 1,
          late_penalty    REAL    DEFAULT 0,
          attachment_url  TEXT,
          attachment_name TEXT,
          attachment_type TEXT,
          status          TEXT DEFAULT 'active'
                            CHECK(status IN ('active','archived','cancelled')),
          is_published    INTEGER DEFAULT 0,
          _synced         INTEGER DEFAULT 0,
          created_at      TEXT DEFAULT (datetime('now')),
          updated_at      TEXT,
          deleted_at      TEXT,
          FOREIGN KEY (class_id)   REFERENCES classes(id),
          FOREIGN KEY (subject_id) REFERENCES subjects(id),
          FOREIGN KEY (created_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS homework_submissions (
          id               TEXT PRIMARY KEY,
          homework_id      TEXT NOT NULL,
          student_id       TEXT NOT NULL,
          student_name     TEXT,
          student_email    TEXT,
          class_id         TEXT,
          submission_text  TEXT,
          attachment_url   TEXT,
          attachment_name  TEXT,
          attachment_type  TEXT,
          score            REAL,
          feedback         TEXT,
          graded_by        TEXT,
          graded_at        TEXT,
          status           TEXT DEFAULT 'submitted'
                             CHECK(status IN (
                               'submitted','graded','returned','late'
                             )),
          is_late          INTEGER DEFAULT 0,
          _synced          INTEGER DEFAULT 0,
          submitted_at     TEXT DEFAULT (datetime('now')),
          updated_at       TEXT,
          created_at       TEXT DEFAULT (datetime('now')),
          UNIQUE(homework_id, student_id),
          FOREIGN KEY (homework_id) REFERENCES homework(id) ON DELETE CASCADE,
          FOREIGN KEY (graded_by)   REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_hw_school_teacher
          ON homework(schoolId, created_by);
        CREATE INDEX IF NOT EXISTS idx_hw_class_subject
          ON homework(class_id, subject_id);
        CREATE INDEX IF NOT EXISTS idx_hw_class_published
          ON homework(class_id, is_published, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_hw_due_date
          ON homework(due_date);
        CREATE INDEX IF NOT EXISTS idx_hw_sub_homework
          ON homework_submissions(homework_id);
        CREATE INDEX IF NOT EXISTS idx_hw_sub_student
          ON homework_submissions(student_id);
        CREATE INDEX IF NOT EXISTS idx_hw_sub_ungraded
          ON homework_submissions(homework_id, score);
        CREATE INDEX IF NOT EXISTS idx_hw_synced
          ON homework(_synced);
        CREATE INDEX IF NOT EXISTS idx_hw_sub_synced
          ON homework_submissions(_synced);
      `);

      console.log("✅ Homework module tables and indexes ready");
    },
  },

  // ── v21: teacher_profiles ─────────────────────────────
  {
    version: 21,
    description: "Create teacher_profiles — rebuild if legacy table missing teacher_id PK",
    up: async (db) => {
      const existing = await db.getFirstAsync(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name='teacher_profiles'
         LIMIT 1`
      ).catch(() => null);

      if (existing) {
        const cols         = await db.getAllAsync(`PRAGMA table_info(teacher_profiles)`).catch(() => []);
        const hasTeacherId = cols.some((c) => c.name === "teacher_id");
        if (!hasTeacherId) {
          console.log("🔧 Dropping broken teacher_profiles — missing teacher_id PK");
          await db.execAsync(`DROP TABLE IF EXISTS teacher_profiles`);
        }
      }

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS teacher_profiles (
          teacher_id         TEXT PRIMARY KEY,
          first_name         TEXT,
          last_name          TEXT,
          gender             TEXT,
          date_of_birth      TEXT,
          national_id        TEXT,
          staff_id           TEXT,
          qualification      TEXT,
          employment_type    TEXT,
          join_date          TEXT,
          years_experience   TEXT,
          previous_school    TEXT,
          phone              TEXT,
          alternate_phone    TEXT,
          address            TEXT,
          city               TEXT,
          state              TEXT,
          emergency_name     TEXT,
          emergency_phone    TEXT,
          emergency_relation TEXT,
          blood_group        TEXT,
          medical_conditions TEXT,
          bio                TEXT,
          profile_completed  INTEGER DEFAULT 0,
          updated_at         TEXT
        )
      `);

      const colsAfter = await db.getAllAsync(`PRAGMA table_info(teacher_profiles)`).catch(() => []);
      const colSet    = new Set(colsAfter.map((c) => c.name));

      const needed = [
        ["first_name",         "TEXT"],
        ["last_name",          "TEXT"],
        ["gender",             "TEXT"],
        ["date_of_birth",      "TEXT"],
        ["national_id",        "TEXT"],
        ["staff_id",           "TEXT"],
        ["qualification",      "TEXT"],
        ["employment_type",    "TEXT"],
        ["join_date",          "TEXT"],
        ["years_experience",   "TEXT"],
        ["previous_school",    "TEXT"],
        ["phone",              "TEXT"],
        ["alternate_phone",    "TEXT"],
        ["address",            "TEXT"],
        ["city",               "TEXT"],
        ["state",              "TEXT"],
        ["emergency_name",     "TEXT"],
        ["emergency_phone",    "TEXT"],
        ["emergency_relation", "TEXT"],
        ["blood_group",        "TEXT"],
        ["medical_conditions", "TEXT"],
        ["bio",                "TEXT"],
        ["profile_completed",  "INTEGER DEFAULT 0"],
        ["updated_at",         "TEXT"],
      ];

      for (const [col, def] of needed) {
        if (!colSet.has(col)) {
          await db.execAsync(
            `ALTER TABLE teacher_profiles ADD COLUMN ${col} ${def}`
          ).catch(() => {});
          console.log(`➕ Added missing column: teacher_profiles.${col}`);
        }
      }

      console.log("✅ teacher_profiles ready");
    },
  },

  // ── v22: student_profiles ─────────────────────────────
  {
    version: 22,
    description: "Create student_profiles — rebuild if legacy table missing student_id PK",
    up: async (db) => {
      const existing = await db.getFirstAsync(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name='student_profiles'
         LIMIT 1`
      ).catch(() => null);

      if (existing) {
        const cols         = await db.getAllAsync(`PRAGMA table_info(student_profiles)`).catch(() => []);
        const hasStudentId = cols.some((c) => c.name === "student_id");
        if (!hasStudentId) {
          console.log("🔧 Dropping broken student_profiles — missing student_id PK");
          await db.execAsync(`DROP TABLE IF EXISTS student_profiles`);
        }
      }

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS student_profiles (
          student_id         TEXT PRIMARY KEY,
          first_name         TEXT,
          last_name          TEXT,
          gender             TEXT,
          date_of_birth      TEXT,
          place_of_birth     TEXT,
          national_id        TEXT,
          is_repeating       INTEGER DEFAULT 0,
          phone              TEXT,
          alternate_phone    TEXT,
          address            TEXT,
          city               TEXT,
          state              TEXT,
          guardian_name      TEXT,
          guardian_phone     TEXT,
          guardian_relation  TEXT,
          guardian_email     TEXT,
          blood_group        TEXT,
          medical_conditions TEXT,
          bio                TEXT,
          profile_completed  INTEGER DEFAULT 0,
          updated_at         TEXT
        )
      `);

      const colsAfter = await db.getAllAsync(`PRAGMA table_info(student_profiles)`).catch(() => []);
      const colSet    = new Set(colsAfter.map((c) => c.name));

      const needed = [
        ["first_name",         "TEXT"],
        ["last_name",          "TEXT"],
        ["gender",             "TEXT"],
        ["date_of_birth",      "TEXT"],
        ["place_of_birth",     "TEXT"],
        ["national_id",        "TEXT"],
        ["is_repeating",       "INTEGER DEFAULT 0"],
        ["phone",              "TEXT"],
        ["alternate_phone",    "TEXT"],
        ["address",            "TEXT"],
        ["city",               "TEXT"],
        ["state",              "TEXT"],
        ["guardian_name",      "TEXT"],
        ["guardian_phone",     "TEXT"],
        ["guardian_relation",  "TEXT"],
        ["guardian_email",     "TEXT"],
        ["blood_group",        "TEXT"],
        ["medical_conditions", "TEXT"],
        ["bio",                "TEXT"],
        ["profile_completed",  "INTEGER DEFAULT 0"],
        ["updated_at",         "TEXT"],
      ];

      for (const [col, def] of needed) {
        if (!colSet.has(col)) {
          await db.execAsync(
            `ALTER TABLE student_profiles ADD COLUMN ${col} ${def}`
          ).catch(() => {});
          console.log(`➕ Added missing column: student_profiles.${col}`);
        }
      }

      console.log("✅ student_profiles ready");
    },
  },

  // ── v23: Fix report_templates schema mismatch ─────────
  {
    version: 23,
    description: "Rebuild report_templates with camelCase schoolId + full columns",
    up: async (db) => {
      const cols     = await db.getAllAsync(`PRAGMA table_info(report_templates)`);
      const colNames = new Set(cols.map((c) => c.name));

      console.log("[v23] report_templates columns:", [...colNames].join(", "));

      if (colNames.has("schoolId")) {
        console.log("[v23] schoolId already exists — patching only");
        const toAdd = [
          { name: "type",      def: "TEXT" },
          { name: "category",  def: "TEXT" },
          { name: "fields",    def: "TEXT" },
          { name: "isActive",  def: "INTEGER DEFAULT 1" },
          { name: "isDefault", def: "INTEGER DEFAULT 0" },
          { name: "synced_at", def: "TEXT" },
        ];
        for (const col of toAdd) {
          await addColumnIfMissing(db, "report_templates", col.name, col.def);
        }
        return;
      }

      console.log("[v23] Rebuilding report_templates…");

      await db.execAsync(
        `ALTER TABLE report_templates RENAME TO report_templates_v14_backup`
      );

      await db.execAsync(`
        CREATE TABLE report_templates (
          id          TEXT PRIMARY KEY,
          server_id   TEXT UNIQUE,
          schoolId    TEXT,
          school_id   TEXT,
          name        TEXT NOT NULL,
          type        TEXT,
          category    TEXT,
          level       TEXT,
          fields      TEXT,
          html        TEXT,
          css         TEXT,
          layout_json TEXT,
          isActive    INTEGER DEFAULT 1,
          is_active   INTEGER DEFAULT 1,
          isDefault   INTEGER DEFAULT 0,
          is_default  INTEGER DEFAULT 0,
          is_locked   INTEGER DEFAULT 0,
          version     INTEGER DEFAULT 1,
          _synced     INTEGER DEFAULT 0,
          synced_at   TEXT,
          created_at  TEXT DEFAULT (datetime('now')),
          updated_at  TEXT,
          deleted_at  TEXT
        )
      `);

      const oldCols   = await db.getAllAsync(
        `PRAGMA table_info(report_templates_v14_backup)`
      );
      const oldColSet = new Set(oldCols.map((c) => c.name));

      const schoolExpr = oldColSet.has("school_id")
        ? "school_id, school_id"
        : "NULL, NULL";

      const safe = (col, fallback = "NULL") =>
        oldColSet.has(col) ? col : fallback;

      await db.runAsync(`
        INSERT OR IGNORE INTO report_templates (
          id, server_id,
          schoolId, school_id,
          name, level,
          html, css, layout_json,
          is_default, is_locked,
          version, _synced,
          created_at, updated_at, deleted_at
        )
        SELECT
          id,
          ${safe("server_id")},
          ${schoolExpr},
          ${safe("name", "''")},
          ${safe("level")},
          ${safe("html")},
          ${safe("css")},
          ${safe("layout_json")},
          ${safe("is_default", "0")},
          ${safe("is_locked",  "0")},
          ${safe("version",    "1")},
          ${safe("_synced",    "0")},
          ${safe("created_at")},
          ${safe("updated_at")},
          ${safe("deleted_at")}
        FROM report_templates_v14_backup
      `);

      await db.execAsync(`DROP TABLE report_templates_v14_backup`);

      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_rt_schoolId
          ON report_templates(schoolId);
        CREATE INDEX IF NOT EXISTS idx_rt_active
          ON report_templates(schoolId, isActive, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_rt_default
          ON report_templates(schoolId, isDefault);
      `);

      console.log("✅ [v23] report_templates rebuilt");
    },
  },

  // ── v24: Exam module tables ───────────────────────────
  {
    version: 24,
    description: "Add exams, exam_subjects, student_scores, result_summaries tables",
    up: async (db) => {
      await db.execAsync(`

        CREATE TABLE IF NOT EXISTS exams (
          id               TEXT PRIMARY KEY,
          schoolId         TEXT,
          classId          TEXT,
          className        TEXT,
          classIds         TEXT DEFAULT '[]',
          classNames       TEXT,
          name             TEXT NOT NULL,
          type             TEXT DEFAULT 'first_test',
          academicYear     TEXT,
          term             TEXT,
          startDate        TEXT,
          endDate          TEXT,
          status           TEXT DEFAULT 'draft',
          description      TEXT,
          instructions     TEXT,
          totalMarks       REAL DEFAULT 100,
          passMark         REAL DEFAULT 50,
          resultsPublished INTEGER DEFAULT 0,
          createdBy        TEXT,
          sync_status      TEXT DEFAULT 'pending',
          last_synced_at   TEXT,
          created_at       TEXT DEFAULT (datetime('now')),
          updated_at       TEXT,
          deleted_at       TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_exams_school_status
          ON exams(schoolId, status);
        CREATE INDEX IF NOT EXISTS idx_exams_class
          ON exams(classId);
        CREATE INDEX IF NOT EXISTS idx_exams_sync
          ON exams(sync_status);
        CREATE INDEX IF NOT EXISTS idx_exams_term
          ON exams(schoolId, term, academicYear);

        CREATE TABLE IF NOT EXISTS exam_subjects (
          id               TEXT PRIMARY KEY,
          examId           TEXT NOT NULL,
          subjectId        TEXT,
          classId          TEXT,
          schoolId         TEXT,
          teacherId        TEXT,
          subjectName      TEXT,
          teacherName      TEXT,
          maxScore         REAL DEFAULT 100,
          passMark         REAL DEFAULT 50,
          weight           REAL DEFAULT 100,
          isPractical      INTEGER DEFAULT 0,
          isTheory         INTEGER DEFAULT 1,
          isOral           INTEGER DEFAULT 0,
          submissionStatus TEXT DEFAULT 'pending',
          sync_status      TEXT DEFAULT 'pending',
          created_at       TEXT DEFAULT (datetime('now')),
          updated_at       TEXT,
          FOREIGN KEY (examId) REFERENCES exams(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_exam_subjects_exam
          ON exam_subjects(examId);
        CREATE INDEX IF NOT EXISTS idx_exam_subjects_teacher
          ON exam_subjects(examId, teacherId);

        CREATE TABLE IF NOT EXISTS student_scores (
          id             TEXT PRIMARY KEY,
          examId         TEXT NOT NULL,
          examSubjectId  TEXT,
          studentId      TEXT NOT NULL,
          subjectId      TEXT,
          classId        TEXT,
          schoolId       TEXT,
          score          REAL,
          maxScore       REAL DEFAULT 100,
          percentage     REAL,
          grade          TEXT,
          remark         TEXT,
          gpaPoints      REAL,
          isPassing      INTEGER,
          teacherRemark  TEXT,
          isAbsent       INTEGER DEFAULT 0,
          isExempt       INTEGER DEFAULT 0,
          enteredBy      TEXT,
          enteredAt      TEXT,
          sync_status    TEXT DEFAULT 'pending',
          last_synced_at TEXT,
          created_at     TEXT DEFAULT (datetime('now')),
          updated_at     TEXT,
          FOREIGN KEY (examId) REFERENCES exams(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_scores_exam_student
          ON student_scores(examId, studentId);
        CREATE INDEX IF NOT EXISTS idx_scores_subject
          ON student_scores(examId, subjectId);
        CREATE INDEX IF NOT EXISTS idx_scores_sync
          ON student_scores(sync_status);

        CREATE TABLE IF NOT EXISTS result_summaries (
          id              TEXT PRIMARY KEY,
          examId          TEXT NOT NULL,
          studentId       TEXT NOT NULL,
          classId         TEXT,
          schoolId        TEXT,
          studentName     TEXT,
          admissionNo     TEXT,
          className       TEXT,
          totalScore      REAL DEFAULT 0,
          maxTotalScore   REAL DEFAULT 0,
          percentage      REAL DEFAULT 0,
          average         REAL DEFAULT 0,
          overallGrade    TEXT,
          overallRemark   TEXT,
          gpa             REAL,
          subjectsPassed  INTEGER DEFAULT 0,
          subjectsFailed  INTEGER DEFAULT 0,
          subjectsTotal   INTEGER DEFAULT 0,
          isPassing       INTEGER DEFAULT 0,
          classPosition   INTEGER,
          totalInClass    INTEGER,
          promotionStatus TEXT DEFAULT 'pending',
          isPublished     INTEGER DEFAULT 0,
          isLocked        INTEGER DEFAULT 0,
          sync_status     TEXT DEFAULT 'pending',
          last_synced_at  TEXT,
          created_at      TEXT DEFAULT (datetime('now')),
          updated_at      TEXT,
          UNIQUE(examId, studentId),
          FOREIGN KEY (examId) REFERENCES exams(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_results_exam_class
          ON result_summaries(examId, classId);
        CREATE INDEX IF NOT EXISTS idx_results_student
          ON result_summaries(examId, studentId);
        CREATE INDEX IF NOT EXISTS idx_results_sync
          ON result_summaries(sync_status);
      `);

      console.log("✅ [v24] Exam module tables ready");
    },
  },

  // ── v25: Bridge exam_results → student_scores ─────────
  {
    version: 25,
    description: "Bridge exam_results → student_scores + patch student_marks",
    up: async (db) => {
      const tables = await db.getAllAsync(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name='exam_results'`
      );

      if (tables.length > 0) {
        console.log("[v25] Migrating exam_results → student_scores…");
        await db.execAsync(`
          INSERT OR IGNORE INTO student_scores
            (id, examId, studentId, subjectId, schoolId,
             score, percentage, grade, isPassing,
             sync_status, created_at)
          SELECT
            id, examId, studentId, subjectId, schoolId,
            marksObtained, percentage, grade, isPassed,
            'synced', created_at
          FROM exam_results
          WHERE examId IS NOT NULL AND studentId IS NOT NULL
        `).catch(() => {});

        await db.execAsync(
          `DROP TABLE IF EXISTS exam_results`
        ).catch(() => {});

        console.log("[v25] exam_results migrated and dropped");
      }

      await addColumnIfMissing(db, "student_marks", "caScore",    "REAL");
      await addColumnIfMissing(db, "student_marks", "examScore",  "REAL");
      await addColumnIfMissing(db, "student_marks", "ca_score",   "REAL");
      await addColumnIfMissing(db, "student_marks", "exam_score", "REAL");
      await addColumnIfMissing(db, "student_marks", "examId",     "TEXT");

      console.log("✅ [v25] Bridge complete");
    },
  },

  // ── v26: Upload queue for offline content uploads ─────
{
  version: 26,
  description: "Add upload_queue table for offline content upload queuing",
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS upload_queue (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL DEFAULT 'content',
        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 5,
        last_error    TEXT,
        payload       TEXT NOT NULL,
        file_uri      TEXT,
        file_name     TEXT,
        file_size     INTEGER,
        mime_type     TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT,
        synced_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_uq_status
        ON upload_queue(status);
      CREATE INDEX IF NOT EXISTS idx_uq_type_status
        ON upload_queue(type, status);
      CREATE INDEX IF NOT EXISTS idx_uq_created
        ON upload_queue(created_at);
    `);

    console.log("✅ [v26] upload_queue table ready");
  },
},

// ── v27: Rebuild teacher_assignments with both camelCase + snake_case ──
{
  version: 27,
  description: "Rebuild teacher_assignments — camelCase primary + snake_case aliases",
  up: async (db) => {
    const cols   = await db.getAllAsync(`PRAGMA table_info(teacher_assignments)`);
    const colSet = new Set(cols.map((c) => c.name.toLowerCase()));

    console.log("[v27] teacher_assignments cols:", [...colSet].join(", "));

    // If the table already has both casings, just patch what's missing
    if (colSet.has("teacherid") && colSet.has("teacher_id")) {
      console.log("[v27] Both casings exist — patching only");
      const toAdd = [
        ["role",       "TEXT"],
        ["is_primary", "INTEGER DEFAULT 0"],
        ["_synced_at", "TEXT DEFAULT NULL"],
        ["school_id",  "TEXT"],
        ["class_id",   "TEXT"],
        ["subject_id", "TEXT"],
      ];
      for (const [col, def] of toAdd) {
        await addColumnIfMissing(db, "teacher_assignments", col, def);
      }
      return;
    }

    console.log("[v27] Rebuilding teacher_assignments...");

    await db.execAsync(
      `ALTER TABLE teacher_assignments RENAME TO _ta_backup_v27`
    );

    await db.execAsync(`
      CREATE TABLE teacher_assignments (
        id          TEXT PRIMARY KEY,

        -- camelCase (primary — all service queries use these)
        teacherId   TEXT,
        classId     TEXT,
        subjectId   TEXT,
        schoolId    TEXT,

        -- snake_case (server compat + migration history)
        teacher_id  TEXT,
        class_id    TEXT,
        subject_id  TEXT,
        school_id   TEXT,

        role        TEXT,
        is_primary  INTEGER DEFAULT 0,

        created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at  TEXT,
        deleted_at  TEXT DEFAULT NULL,
        _synced     INTEGER DEFAULT 0,
        _synced_at  TEXT DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ta_teacherId
        ON teacher_assignments(teacherId);
      CREATE INDEX IF NOT EXISTS idx_ta_classId
        ON teacher_assignments(classId);
      CREATE INDEX IF NOT EXISTS idx_ta_schoolId
        ON teacher_assignments(schoolId);
      CREATE INDEX IF NOT EXISTS idx_ta_teacher_class
        ON teacher_assignments(teacherId, classId);
    `);

    // Detect what the backup has so INSERT is safe
    const bkCols   = await db.getAllAsync(`PRAGMA table_info(_ta_backup_v27)`);
    const bkColSet = new Set(bkCols.map((c) => c.name.toLowerCase()));

    // Resolve camelCase source even if backup was snake_case
    const teacherSrc = bkColSet.has("teacherid")  ? "teacherId"  : "teacher_id";
    const classSrc   = bkColSet.has("classid")     ? "classId"    : "class_id";
    const subjectSrc = bkColSet.has("subjectid")   ? "subjectId"  : "subject_id";
    const schoolSrc  = bkColSet.has("schoolid")    ? "schoolId"   : "school_id";

    await db.execAsync(`
      INSERT OR IGNORE INTO teacher_assignments (
        id,
        teacherId,    classId,    subjectId,    schoolId,
        teacher_id,   class_id,   subject_id,   school_id,
        created_at,   updated_at, deleted_at,   _synced
      )
      SELECT
        id,
        ${teacherSrc}, ${classSrc}, ${subjectSrc}, ${schoolSrc},
        ${teacherSrc}, ${classSrc}, ${subjectSrc}, ${schoolSrc},
        created_at,   updated_at, deleted_at,   _synced
      FROM _ta_backup_v27
    `);

    await db.execAsync(`DROP TABLE _ta_backup_v27`);

    console.log("✅ [v27] teacher_assignments rebuilt — camelCase + snake_case ready");
  },
},

// src/db/migrate.js  — add after v27

// ── v28: Guarantee quiz tables exist ─────────────────────
{
  version: 28,
  description: "Safety-net: ensure questions + question_options exist",
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS questions (
        id            TEXT PRIMARY KEY,
        schoolId      TEXT NOT NULL,
        category_id   TEXT,
        question_text TEXT NOT NULL,
        question_type TEXT NOT NULL
                        CHECK(question_type IN (
                          'multiple_choice','multiple_select',
                          'true_false','fill_in_the_blank','matching'
                        )),
        media_url     TEXT DEFAULT NULL,
        difficulty    TEXT DEFAULT 'medium'
                        CHECK(difficulty IN ('easy','medium','hard')),
        points        REAL DEFAULT 1.0,
        explanation   TEXT DEFAULT NULL,
        is_active     INTEGER DEFAULT 1,
        created_by    TEXT NOT NULL,
        created_at    TEXT DEFAULT (datetime('now')),
        updated_at    TEXT,
        deleted_at    TEXT,
        _synced       INTEGER DEFAULT 0,
        _synced_at    TEXT,
        FOREIGN KEY (category_id) REFERENCES question_categories(id),
        FOREIGN KEY (created_by)  REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS question_options (
        id            TEXT PRIMARY KEY,
        question_id   TEXT NOT NULL,
        option_text   TEXT NOT NULL,
        is_correct    INTEGER DEFAULT 0,
        match_pair    TEXT DEFAULT NULL,
        display_order INTEGER DEFAULT 0,
        created_at    TEXT DEFAULT (datetime('now')),
        updated_at    TEXT,
        FOREIGN KEY (question_id)
          REFERENCES questions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_questions_school
        ON questions(schoolId, is_active);
      CREATE INDEX IF NOT EXISTS idx_questions_category
        ON questions(category_id);
      CREATE INDEX IF NOT EXISTS idx_question_options_question
        ON question_options(question_id);
    `);

    console.log("✅ [v28] questions + question_options guaranteed");
  },
},

// src/db/migrate.js
// Add after v28, before the "ADD NEW MIGRATIONS BELOW THIS LINE" comment

  // ── v29: Guarantee user auth columns ─────────────────
  {
    version: 29,
    description: "Guarantee passwordSalt, passwordHash, enrollmentNo exist on users table",
    up: async (db) => {
      const authCols = [
        ["passwordSalt",        "TEXT"],
        ["passwordHash",        "TEXT"],
        ["enrollmentNo",        "TEXT"],
        ["must_reset_password", "INTEGER DEFAULT 0"],
        ["_synced",             "INTEGER DEFAULT 0"],
        ["_synced_at",          "TEXT"],
      ];
      for (const [col, def] of authCols) {
        await addColumnIfMissing(db, "users", col, def);
      }
      console.log("✅ [v29] users auth columns guaranteed");
    },
  },
// ── ADD NEW MIGRATIONS BELOW THIS LINE ────────────────
// {
//   version: 30,
//   description: "...",
//   up: async (db) => { ... },
// },
];

// ─────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────
export async function runMigrations(db) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT,
      ran_at      TEXT
    );
  `);

  const ran         = await db.getAllAsync(`SELECT version FROM _migrations`);
  const ranVersions = new Set(ran.map((r) => r.version));
  const sorted      = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of sorted) {
    if (ranVersions.has(migration.version)) continue;

    console.log(`🔄 Migration v${migration.version}: ${migration.description}`);

    await migration.up(db);

    await db.runAsync(
      `INSERT INTO _migrations (version, description, ran_at)
       VALUES (?, ?, ?)`,
      [migration.version, migration.description, new Date().toISOString()]
    );

    console.log(`✅ Migration v${migration.version} done`);
  }
}