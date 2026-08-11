// src/services/template.service.js
"use strict";

import api from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEMPLATE SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single source of truth for all template API calls.
 *
 * Used by:
 *   app/admin/reports/generate/index.js
 *   app/admin/reports/templates/index.js
 *   app/admin/reports/templates/builder.js
 *   app/admin/reports/templates/preview.js
 *
 * All functions return plain objects/arrays — no raw axios responses.
 * Errors are thrown as-is so callers can catch and show alerts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const BASE = "/templates";

export const TemplateService = {

  // ── GET /api/templates ──────────────────────────────────
  async getAll(schoolId) {
    const { data } = await api.get(BASE, { params: { schoolId } });
    return data.templates || [];
  },

  // ── GET /api/templates/default ─────────────────────────
  async getDefault(schoolId) {
    try {
      const { data } = await api.get(`${BASE}/default`, {
        params: { schoolId },
      });
      return data.template || null;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  },

  // ── GET /api/templates/:id ──────────────────────────────
  async getById(templateId) {
    try {
      const { data } = await api.get(`${BASE}/${templateId}`);
      return data.template || null;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  },

  // ── POST /api/templates ─────────────────────────────────
  async create({ schoolId, name, html, css, isDefault }) {
    const { data } = await api.post(BASE, {
      schoolId,
      name,
      html,
      css:       css       || "",
      isDefault: isDefault || false,
    });
    return data.template;
  },

  // ── PUT /api/templates/:id ──────────────────────────────
  async update(templateId, { name, html, css, isDefault }) {
    const { data } = await api.put(`${BASE}/${templateId}`, {
      name, html, css, isDefault,
    });
    return data.template;
  },

  // ── PUT /api/templates/:id { isDefault: true } ──────────
  async setDefault(templateId) {
    const { data } = await api.put(`${BASE}/${templateId}`, {
      isDefault: true,
    });
    return data.template;
  },

  // ── DELETE /api/templates/:id ───────────────────────────
  async delete(templateId) {
    const { data } = await api.delete(`${BASE}/${templateId}`);
    return data;
  },

  // ── POST /api/templates/:id/duplicate ──────────────────
  async duplicate(templateId, schoolId) {
    const { data } = await api.post(
      `${BASE}/${templateId}/duplicate`,
      { schoolId }
    );
    return data.template;
  },

  // ── POST /api/templates/:id/preview ────────────────────
  async preview(templateId, examId = null, studentId = null) {
    const { data } = await api.post(
      `${BASE}/${templateId}/preview`,
      {
        examId:    examId    || null,
        studentId: studentId || null,
      }
    );
    return {
      renderedHtml: data.renderedHtml  || "",
      templateName: data.templateName  || "",
      isRaw:        data.isRaw         || false,
    };
  },

  // ── GET /api/templates/:id/generated ───────────────────
  async getGeneratedReports(templateId) {
    const { data } = await api.get(`${BASE}/${templateId}/generated`);
    return data.reports || [];
  },
};