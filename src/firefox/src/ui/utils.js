/**
 * Shared UI utilities for extension pages.
 */

/**
 * Escape HTML special characters to prevent injection.
 * @param {*} s - Value to escape (converted to string).
 * @returns {string} Escaped string safe for HTML text content and attributes.
 */
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Escape HTML attribute value characters. Same as escapeHtml.
 * @param {*} s - Value to escape (converted to string).
 * @returns {string} Escaped string safe for HTML attribute values.
 */
export function escapeAttr(s) {
  return escapeHtml(s);
}
