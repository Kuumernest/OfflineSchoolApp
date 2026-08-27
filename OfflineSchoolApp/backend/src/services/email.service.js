// backend/services/email.service.js
"use strict";

// Where mail goes is decided in one place, shared with the notification queue.
// This file used to answer that question itself, and notification/channels.js
// answered it differently — see src/services/email.transport.js for what that
// cost.
const mail = require("./email.transport");

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STYLE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const baseBody = `
  margin:0; padding:0;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background-color:#F9FAFB;
`;

const baseTable = `
  background:#FFFFFF; border-radius:16px; overflow:hidden;
  box-shadow:0 4px 6px rgba(0,0,0,0.05);
  max-width:600px; width:100%;
`;

const warningBox = `
  <div style="
    background:#FFFBEB; border:1px solid #FDE68A;
    border-left:4px solid #F59E0B; border-radius:8px;
    padding:14px 16px; margin-bottom:24px;
  ">
    <p style="margin:0; font-size:13px; color:#92400E; line-height:1.5;">
      ⚠️ <strong>Important:</strong> You will be asked to create a new
      password the first time you sign in. Keep these credentials private.
    </p>
  </div>
`;

const emailFooter = (schoolName) => `
  <tr>
    <td style="
      background:#F9FAFB; border-top:1px solid #F3F4F6;
      padding:24px 40px; text-align:center;
    ">
      <p style="margin:0; font-size:12px; color:#9CA3AF; line-height:1.6;">
        This email was sent by ${schoolName}.<br/>
        If you did not expect this, please ignore it or contact your
        school administrator.
      </p>
    </td>
  </tr>
`;

/**
 * Credentials card for STAFF (email + temp password).
 * Staff log in with their email address.
 */
const staffCredentialsCard = ({ email, tempPassword, accentColor = "#4F46E5" }) => `
  <div style="
    background:#F8FAFC; border:1px solid #E2E8F0;
    border-radius:12px; padding:24px; margin-bottom:24px;
  ">
    <p style="
      margin:0 0 16px; font-size:12px; font-weight:700;
      color:#9CA3AF; text-transform:uppercase; letter-spacing:1px;
    ">Your Login Credentials</p>

    <p style="margin:0 0 4px; font-size:12px; color:#9CA3AF;">Email Address</p>
    <p style="
      margin:0 0 20px; font-size:15px; font-weight:600;
      color:#111827; font-family:monospace;
    ">${email}</p>

    <p style="margin:0 0 4px; font-size:12px; color:#9CA3AF;">Temporary Password</p>
    <div style="
      background:${accentColor}; border-radius:8px;
      padding:12px 16px; display:inline-block;
    ">
      <p style="
        margin:0; font-size:20px; font-weight:800;
        color:#FFF; font-family:monospace; letter-spacing:3px;
      ">${tempPassword}</p>
    </div>
  </div>
`;

/**
 * Credentials card for STUDENTS (enrollment number + temp password).
 * Students log in with their enrollment number, NOT their email.
 * Email is only used to deliver this notification to the parent.
 */
const studentCredentialsCard = ({
  enrollmentNo,
  tempPassword,
  accentColor = "#059669",
}) => `
  <div style="
    background:#F8FAFC; border:1px solid #E2E8F0;
    border-radius:12px; padding:24px; margin-bottom:24px;
  ">
    <p style="
      margin:0 0 16px; font-size:12px; font-weight:700;
      color:#9CA3AF; text-transform:uppercase; letter-spacing:1px;
    ">Student Login Credentials</p>

    <!-- Enrollment number — the permanent login ID -->
    <p style="margin:0 0 4px; font-size:12px; color:#9CA3AF;">
      Enrollment Number
      <span style="
        font-size:10px; background:#EEF2FF; color:#4F46E5;
        border-radius:4px; padding:2px 6px; margin-left:6px;
        font-weight:700; text-transform:uppercase; letter-spacing:0.5px;
      ">Use this to log in</span>
    </p>
    <div style="
      background:#4F46E5; border-radius:8px;
      padding:14px 20px; display:inline-block; margin-bottom:20px;
    ">
      <p style="
        margin:0; font-size:24px; font-weight:800;
        color:#FFF; font-family:monospace; letter-spacing:4px;
      ">${enrollmentNo}</p>
    </div>

    <!-- Temp password -->
    <p style="margin:0 0 4px; font-size:12px; color:#9CA3AF;">
      Temporary Password
    </p>
    <div style="
      background:${accentColor}; border-radius:8px;
      padding:12px 16px; display:inline-block;
    ">
      <p style="
        margin:0; font-size:20px; font-weight:800;
        color:#FFF; font-family:monospace; letter-spacing:3px;
      ">${tempPassword}</p>
    </div>

    <!-- Login hint -->
    <p style="
      margin:16px 0 0; font-size:12px; color:#6B7280; line-height:1.5;
    ">
      📱 The student enters their <strong>enrollment number</strong> — not an
      email address — to log in. Multiple family members can share the same
      email for applications; each student gets their own unique enrollment number.
    </p>
  </div>
`;

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const templates = {

  // ── 1. TEACHER WELCOME ────────────────────────────────────────────────────
  teacherWelcome: ({
    teacherName,
    email,
    tempPassword,
    schoolName,
    loginUrl,
  }) => ({
    subject: `Welcome to ${schoolName} — Your Login Details`,
    html: `
      <!DOCTYPE html><html>
        <head>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
        </head>
        <body style="${baseBody}">
          <table width="100%" cellpadding="0" cellspacing="0"
            style="padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0"
                style="${baseTable}">
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 100%);
                    padding:40px; text-align:center;
                  ">
                    <div style="font-size:40px;margin-bottom:12px;">🏫</div>
                    <h1 style="margin:0;font-size:24px;font-weight:800;color:#FFF;">
                      ${schoolName}
                    </h1>
                    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.8);">
                      School Management System
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px;">
                    <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">
                      Welcome, ${teacherName}! 👋
                    </h2>
                    <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.6;">
                      You have been added as a teacher at
                      <strong style="color:#111827;">${schoolName}</strong>.
                      Use the credentials below to sign in.
                    </p>
                    ${staffCredentialsCard({ email, tempPassword })}
                    ${warningBox}
                    ${loginUrl ? `
                      <div style="text-align:center;margin-top:32px;">
                        <a href="${loginUrl}" style="
                          display:inline-block;background:#4F46E5;color:#FFF;
                          text-decoration:none;font-size:15px;font-weight:700;
                          padding:14px 32px;border-radius:10px;
                        ">Sign In Now →</a>
                      </div>
                    ` : ""}
                  </td>
                </tr>
                ${emailFooter(schoolName)}
              </table>
            </td></tr>
          </table>
        </body>
      </html>
    `,
    text: `
Welcome to ${schoolName}, ${teacherName}!

Email:              ${email}
Temporary Password: ${tempPassword}

You will be required to change your password on first login.
${loginUrl ? `\nSign in here: ${loginUrl}` : ""}
    `.trim(),
  }),

  // ── 2. ADMIN WELCOME ──────────────────────────────────────────────────────
  adminWelcome: ({
    adminName,
    email,
    tempPassword,
    role,
    schoolName,
    loginUrl,
  }) => ({
    subject: `${schoolName} — Admin Account Created`,
    html: `
      <!DOCTYPE html><html>
        <head>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
        </head>
        <body style="${baseBody}">
          <table width="100%" cellpadding="0" cellspacing="0"
            style="padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0"
                style="${baseTable}">
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#0F172A 0%,#1E3A5F 100%);
                    padding:40px; text-align:center;
                  ">
                    <div style="font-size:40px;margin-bottom:12px;">🛡️</div>
                    <h1 style="margin:0;font-size:24px;font-weight:800;color:#FFF;">
                      ${schoolName}
                    </h1>
                    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.75);">
                      Administrator Access Granted
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px;">
                    <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">
                      Welcome, ${adminName}! 🎉
                    </h2>
                    <p style="margin:0 0 16px;font-size:15px;color:#6B7280;line-height:1.6;">
                      An administrator account has been created for you at
                      <strong style="color:#111827;">${schoolName}</strong>
                      with the role of
                      <strong style="color:#1E3A5F;">${role || "Admin"}</strong>.
                    </p>
                    <div style="
                      display:inline-block;background:#EFF6FF;
                      border:1px solid #BFDBFE;border-radius:8px;
                      padding:8px 16px;margin-bottom:24px;
                    ">
                      <p style="
                        margin:0;font-size:13px;font-weight:700;
                        color:#1D4ED8;text-transform:uppercase;letter-spacing:1px;
                      ">🛡️ Role: ${role || "Admin"}</p>
                    </div>
                    ${staffCredentialsCard({
                      email,
                      tempPassword,
                      accentColor: "#1E3A5F",
                    })}
                    ${warningBox}
                    ${loginUrl ? `
                      <div style="text-align:center;margin-top:32px;">
                        <a href="${loginUrl}" style="
                          display:inline-block;background:#0F172A;color:#FFF;
                          text-decoration:none;font-size:15px;font-weight:700;
                          padding:14px 32px;border-radius:10px;
                        ">Access Admin Dashboard →</a>
                      </div>
                    ` : ""}
                  </td>
                </tr>
                ${emailFooter(schoolName)}
              </table>
            </td></tr>
          </table>
        </body>
      </html>
    `,
    text: `
Welcome to ${schoolName}, ${adminName}!

Your admin account has been created.
Role: ${role || "Admin"}

Email:              ${email}
Temporary Password: ${tempPassword}

You will be required to change your password on first login.
${loginUrl ? `\nAccess the dashboard: ${loginUrl}` : ""}

Keep these credentials private.
    `.trim(),
  }),

  // ── 3. PASSWORD RESET BY ADMIN ────────────────────────────────────────────
  passwordResetByAdmin: ({
    teacherName,
    email,
    tempPassword,
    schoolName,
  }) => ({
    subject: `${schoolName} — Your Password Has Been Reset`,
    html: `
      <!DOCTYPE html><html>
        <head><meta charset="utf-8"/></head>
        <body style="${baseBody}">
          <table width="100%" cellpadding="0" cellspacing="0"
            style="padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0"
                style="${baseTable}">
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 100%);
                    padding:40px; text-align:center;
                  ">
                    <div style="font-size:40px;margin-bottom:12px;">🔑</div>
                    <h1 style="margin:0;font-size:24px;font-weight:800;color:#FFF;">
                      Password Reset
                    </h1>
                    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
                      ${schoolName}
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px;">
                    <p style="font-size:15px;color:#374151;line-height:1.6;">
                      Hi <strong>${teacherName}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
                      An administrator at <strong>${schoolName}</strong>
                      has reset your password.
                    </p>
                    ${staffCredentialsCard({ email, tempPassword })}
                    ${warningBox}
                    <p style="font-size:14px;color:#6B7280;line-height:1.6;">
                      If you did not request this reset, please contact your
                      school administrator immediately.
                    </p>
                  </td>
                </tr>
                ${emailFooter(schoolName)}
              </table>
            </td></tr>
          </table>
        </body>
      </html>
    `,
    text: `
Hi ${teacherName},

Your password at ${schoolName} has been reset by an administrator.

Email:              ${email}
Temporary Password: ${tempPassword}

Please change your password on your next login.
If you did not request this, contact your school administrator immediately.
    `.trim(),
  }),

  // ── 4. STUDENT APPROVED ───────────────────────────────────────────────────
  //
  // KEY CHANGE: Students log in with enrollmentNo, NOT email.
  // This email is sent to the parent/guardian's address (which may belong
  // to a teacher-parent or be shared across siblings).
  // The email itself is NOT shown as a login credential.
  //
  // Additional cases handled:
  //   parentIsStaff  = true  → parent is a teacher, student has no email attached
  //   isSibling      = true  → parent used same email for multiple children
  //
  studentApproved: ({
    studentName,
    enrollmentNo,
    tempPassword,
    className,
    schoolName,
    loginUrl,
    parentIsStaff = false,
    isSibling     = false,
  }) => ({
    subject: `🎉 ${studentName} has been approved — ${schoolName}`,
    html: `
      <!DOCTYPE html><html>
        <head>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
        </head>
        <body style="${baseBody}">
          <table width="100%" cellpadding="0" cellspacing="0"
            style="padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0"
                style="${baseTable}">

                <!-- Header -->
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#059669 0%,#047857 100%);
                    padding:40px; text-align:center;
                  ">
                    <div style="font-size:48px;margin-bottom:12px;">🎉</div>
                    <h1 style="margin:0;font-size:24px;font-weight:800;color:#FFF;">
                      Application Approved!
                    </h1>
                    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
                      ${schoolName}
                    </p>
                  </td>
                </tr>

                <!-- Body -->
                <tr>
                  <td style="padding:40px;">

                    <!-- Parent-is-staff notice -->
                    ${parentIsStaff ? `
                    <div style="
                      background:#EEF2FF; border:1px solid #C7D2FE;
                      border-left:4px solid #4F46E5; border-radius:8px;
                      padding:14px 16px; margin-bottom:24px;
                    ">
                      <p style="margin:0;font-size:13px;color:#3730A3;line-height:1.5;">
                        👨‍🏫 <strong>Note for staff members:</strong>
                        You applied using your staff email address.
                        A separate student account has been created for
                        <strong>${studentName}</strong>. They will log in
                        using their enrollment number below — not your
                        staff email.
                      </p>
                    </div>` : ""}

                    <!-- Sibling notice -->
                    ${isSibling ? `
                    <div style="
                      background:#EEF2FF; border:1px solid #C7D2FE;
                      border-left:4px solid #4F46E5; border-radius:8px;
                      padding:14px 16px; margin-bottom:24px;
                    ">
                      <p style="margin:0;font-size:13px;color:#3730A3;line-height:1.5;">
                        👨‍👩‍👧‍👦 <strong>Multiple children notice:</strong>
                        This email address is shared with another student in
                        your family. Each child has their own unique enrollment
                        number — please share the correct one with
                        <strong>${studentName}</strong>.
                      </p>
                    </div>` : ""}

                    <h2 style="margin:0 0 8px;font-size:20px;color:#111827;">
                      Welcome, ${studentName}! 🌟
                    </h2>
                    <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.6;">
                      The application for
                      <strong style="color:#111827;">${studentName}</strong>
                      to join
                      <strong style="color:#111827;">${schoolName}</strong>
                      has been <strong style="color:#059669;">approved</strong>.
                      They have been placed in
                      <strong style="color:#111827;">${className}</strong>.
                    </p>

                    <!-- Student credentials (enrollment number based) -->
                    ${studentCredentialsCard({ enrollmentNo, tempPassword })}

                    ${warningBox}

                    <!-- Class badge -->
                    <div style="
                      background:#EEF2FF; border-radius:12px;
                      padding:16px; margin-bottom:24px;
                    ">
                      <p style="margin:0;font-size:14px;color:#4F46E5;font-weight:600;">
                        📚 Assigned Class: <strong>${className}</strong>
                      </p>
                    </div>

                    <!-- How to log in -->
                    <div style="
                      background:#F9FAFB; border:1px solid #E5E7EB;
                      border-radius:12px; padding:20px; margin-bottom:24px;
                    ">
                      <p style="
                        margin:0 0 12px; font-size:13px; font-weight:700;
                        color:#374151; text-transform:uppercase; letter-spacing:0.5px;
                      ">How to Log In</p>
                      <ol style="
                        margin:0; padding-left:20px;
                        font-size:14px; color:#374151; line-height:2;
                      ">
                        <li>
                          Open the ${schoolName} app
                          ${loginUrl
                            ? `or visit <a href="${loginUrl}"
                               style="color:#4F46E5;">${loginUrl}</a>`
                            : ""}.
                        </li>
                        <li>
                          Enter the enrollment number:
                          <strong style="
                            font-family:monospace; font-size:15px;
                            color:#4F46E5; letter-spacing:2px;
                          ">${enrollmentNo}</strong>
                        </li>
                        <li>Enter the temporary password above.</li>
                        <li>
                          Create a new personal password when prompted.
                        </li>
                      </ol>
                    </div>

                    <!-- Important reminder -->
                    <div style="
                      background:#FFFBEB; border:1px solid #FDE68A;
                      border-left:4px solid #F59E0B; border-radius:8px;
                      padding:14px 16px;
                    ">
                      <p style="margin:0;font-size:13px;color:#92400E;line-height:1.6;">
                        🔒 <strong>Keep these details safe.</strong>
                        The enrollment number
                        <strong style="font-family:monospace;">${enrollmentNo}</strong>
                        is ${studentName}'s <strong>permanent login ID</strong>.
                        They will use it on every device. If credentials are
                        lost, ask the class teacher or school office to reset them.
                      </p>
                    </div>

                    ${loginUrl ? `
                      <div style="text-align:center;margin-top:32px;">
                        <a href="${loginUrl}" style="
                          display:inline-block;background:#059669;color:#FFF;
                          text-decoration:none;font-size:15px;font-weight:700;
                          padding:14px 32px;border-radius:10px;
                        ">Open School App →</a>
                      </div>
                    ` : ""}

                  </td>
                </tr>

                ${emailFooter(schoolName)}
              </table>
            </td></tr>
          </table>
        </body>
      </html>
    `,
    text: `
Dear Parent / Guardian,

${parentIsStaff
  ? `Note: You applied using your staff email. A separate student account has been created for ${studentName}.\n`
  : ""}
${isSibling
  ? `Note: This email is shared with another child in your family. Please share the correct enrollment number below with ${studentName}.\n`
  : ""}
We are pleased to inform you that ${studentName}'s application to ${schoolName} has been APPROVED.

Class: ${className}

══════════════════════════════
  STUDENT LOGIN CREDENTIALS
══════════════════════════════
  Enrollment Number : ${enrollmentNo}
  Temporary Password: ${tempPassword}
══════════════════════════════

HOW TO LOG IN:
1. Open the ${schoolName} app${loginUrl ? ` or visit ${loginUrl}` : ""}.
2. Enter the enrollment number: ${enrollmentNo}
3. Enter the temporary password above.
4. You will be asked to set a new password on first login.

IMPORTANT:
- The enrollment number is ${studentName}'s PERMANENT login ID.
- They use it on every device — NOT an email address.
- Keep these credentials safe.
- If lost, contact the class teacher or school office.

Regards,
${schoolName} Administration
    `.trim(),
  }),

  // ── 5. STUDENT REJECTED ───────────────────────────────────────────────────
  studentRejected: ({
    studentName,
    reason,
    schoolName,
  }) => ({
    subject: `Application Update — ${studentName} — ${schoolName}`,
    html: `
      <!DOCTYPE html><html>
        <head><meta charset="utf-8"/></head>
        <body style="${baseBody}">
          <table width="100%" cellpadding="0" cellspacing="0"
            style="padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0"
                style="${baseTable}">
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#DC2626 0%,#B91C1C 100%);
                    padding:40px; text-align:center;
                  ">
                    <h1 style="margin:0;font-size:24px;font-weight:800;color:#FFF;">
                      Application Update
                    </h1>
                    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
                      ${schoolName}
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px;">
                    <p style="font-size:15px;color:#374151;line-height:1.6;">
                      Dear Parent / Guardian of <strong>${studentName}</strong>,
                    </p>
                    <p style="font-size:15px;color:#374151;line-height:1.6;">
                      Thank you for submitting an application for
                      <strong>${studentName}</strong>
                      to join <strong>${schoolName}</strong>.
                      After careful review, we are unable to approve the
                      application at this time.
                    </p>
                    ${reason ? `
                      <div style="
                        background:#FEF2F2; border:1px solid #FECACA;
                        border-left:4px solid #DC2626; border-radius:8px;
                        padding:16px; margin:20px 0;
                      ">
                        <p style="
                          margin:0 0 6px; font-size:12px; color:#9CA3AF;
                          font-weight:700; text-transform:uppercase; letter-spacing:1px;
                        ">Reason</p>
                        <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;">
                          ${reason}
                        </p>
                      </div>
                    ` : ""}
                    <p style="font-size:14px;color:#6B7280;line-height:1.6;">
                      If you believe this decision is in error, or if you would
                      like to discuss the application further, please contact
                      the school office directly.
                    </p>
                    <p style="font-size:14px;color:#6B7280;line-height:1.6;margin:0;">
                      You are welcome to reapply in the future.
                    </p>
                  </td>
                </tr>
                ${emailFooter(schoolName)}
              </table>
            </td></tr>
          </table>
        </body>
      </html>
    `,
    text: `
Dear Parent / Guardian of ${studentName},

Thank you for submitting an application for ${studentName} to join ${schoolName}.
Unfortunately, the application has not been approved at this time.
${reason ? `\nReason: ${reason}\n` : ""}
If you have questions, please contact the school administration.
You are welcome to reapply in the future.

Regards,
${schoolName} Administration
    `.trim(),
  }),

  // ── 6. STUDENT PASSWORD RESET BY ADMIN ───────────────────────────────────
  // Called when a teacher/admin resets a student's forgotten password.
  // Shows enrollment number (not email) as the login identifier.
  studentPasswordReset: ({
    studentName,
    enrollmentNo,
    tempPassword,
    schoolName,
  }) => ({
    subject: `${schoolName} — Student Password Reset`,
    html: `
      <!DOCTYPE html><html>
        <head><meta charset="utf-8"/></head>
        <body style="${baseBody}">
          <table width="100%" cellpadding="0" cellspacing="0"
            style="padding:40px 20px;">
            <tr><td align="center">
              <table width="600" cellpadding="0" cellspacing="0"
                style="${baseTable}">
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#4F46E5 0%,#7C3AED 100%);
                    padding:40px; text-align:center;
                  ">
                    <div style="font-size:40px;margin-bottom:12px;">🔑</div>
                    <h1 style="margin:0;font-size:24px;font-weight:800;color:#FFF;">
                      Password Reset
                    </h1>
                    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
                      ${schoolName}
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px;">
                    <p style="font-size:15px;color:#374151;line-height:1.6;">
                      Dear Parent / Guardian of <strong>${studentName}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
                      The password for <strong>${studentName}</strong>'s student
                      account at <strong>${schoolName}</strong> has been reset
                      by a school administrator.
                    </p>
                    ${studentCredentialsCard({ enrollmentNo, tempPassword })}
                    ${warningBox}
                    <p style="font-size:14px;color:#6B7280;line-height:1.6;">
                      If you did not request this reset, please contact the
                      school office immediately.
                    </p>
                  </td>
                </tr>
                ${emailFooter(schoolName)}
              </table>
            </td></tr>
          </table>
        </body>
      </html>
    `,
    text: `
Dear Parent / Guardian of ${studentName},

The password for ${studentName}'s student account at ${schoolName} has been reset.

Enrollment Number : ${enrollmentNo}
Temporary Password: ${tempPassword}

The student will be asked to set a new password on their next login.
If you did not request this reset, contact the school office immediately.

Regards,
${schoolName} Administration
    `.trim(),
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// SEND FUNCTION
// Never throws — returns { success, messageId?, error? }
// ─────────────────────────────────────────────────────────────────────────────

const sendEmail = async ({ to, template, data }) => {
  if (!templates[template]) {
    const msg = `Unknown email template: "${template}"`;
    console.warn(`⚠️ ${msg}`);
    return { success: false, error: msg };
  }

  // The block that used to be here dumped GMAIL_USER and the app password's
  // length into the log on EVERY send — a school's address and a measurement of
  // its credential, in a file that gets pasted into support threads. Whether
  // mail is configured is a question to ask once, deliberately:
  // `npm run mail:verify`.

  let subject, html, text;
  try {
    const result = templates[template](data);
    subject      = result.subject;
    html         = result.html;
    text         = result.text;
  } catch (templateErr) {
    console.error(`❌ Template render error [${template}]:`, templateErr.message);
    return { success: false, error: `Template error: ${templateErr.message}` };
  }

  // Answered before a socket is opened. Unconfigured used to mean a connection
  // attempt against a default SMTP host this project does not own, which failed
  // with a message about credentials rather than about configuration.
  const issues = mail.problems();
  if (issues.length) {
    console.warn(`⚠️  Email not sent to ${to} [${template}]: ${issues[0]}`);
    return { success: false, error: issues[0], code: "CHANNEL_NOT_CONFIGURED" };
  }

  try {
    const transporter = mail.transport();

    const info = await transporter.sendMail({
      // The school's name in front of the verified sender. A parent should see
      // who it is from before deciding whether to open it.
      from: `"${data.schoolName || "School App"}" <${mail.fromAddress()}>`,
      to,
      subject,
      html,
      text,
    });

    console.log(`📧 Email sent → ${to} [${template}] — ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };

  } catch (err) {
    console.error(`❌ Email send failed → ${to} [${template}]`);
    console.error(`   Error name:    ${err.name}`);
    console.error(`   Error message: ${err.message}`);
    console.error(`   Error code:    ${err.code || "(none)"}`);
    if (err.response) console.error(`   SMTP response: ${err.response}`);
    return { success: false, error: err.message };
  }
};

module.exports = { sendEmail };