// Exact table exports copy values from a bounded DOM snapshot. The model
// selects columns/types; it does not have to rewrite every cell in the answer.
export const MAX_TABLE_EXPORT_ROWS = 10000;
// Match the ordinary terminal UI journal capacity. Never create a reference
// whose complete JSON would be silently clipped at delivery or restoration.
export const MAX_TABLE_EXPORT_CHARS = 30000;

function failure(error) { return { success: false, error }; }

const CREDENTIAL_COLUMN = /(?:password|passwd|api[ _-]?key|access[ _-]?token|secret|recovery[ _-]?code|one[ _-]?time[ _-]?(?:code|password)|otp)/iu;
function decimalIdentity(literal) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!match) return null;
  let power = Number(match[4] || 0) - (match[3]?.length || 0);
  if (!Number.isSafeInteger(power) || Math.abs(power) > 10000) return null;
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailing); power += trailing;
  return (match[1] === '-' ? '-' : '') + digits + 'e' + power;
}

export function projectTableSnapshot(snapshot, args = {}, strictSecrets = false) {
  if (snapshot?.schema !== 'webbrain.table-snapshot.v1' || snapshot.success !== true
      || !Array.isArray(snapshot.rows) || snapshot.rows.length > MAX_TABLE_EXPORT_ROWS
      || typeof snapshot.documentToken !== 'string' || !snapshot.documentToken
      || typeof snapshot.pageUrl !== 'string' || !snapshot.pageUrl) {
    return failure('The complete source table was not captured. Read it again; do not infer missing rows.');
  }
  const columns = args.columns;
  if (!Array.isArray(columns) || !columns.length || columns.length > 64) {
    return failure('Exact table export requires 1–64 named columns with their column indexes and value types.');
  }
  const names = new Set();
  for (const column of columns) {
    if (typeof column?.name !== 'string' || !column.name || column.name.length > 100
        || names.has(column.name) || !Number.isSafeInteger(column.index) || column.index < 0
        || !['string', 'integer', 'number'].includes(column.type)) {
      return failure('Each output column needs a unique name, nonnegative integer index and string/integer/number type.');
    }
    if (strictSecrets && (!Array.isArray(snapshot.headerRows)
        || CREDENTIAL_COLUMN.test(column.name)
        || snapshot.headerRows.some(cells => !Array.isArray(cells)
          || typeof cells[column.index] !== 'string'
          || CREDENTIAL_COLUMN.test(cells[column.index])))) {
      return failure('Strict secret handling prevents exporting credential columns. Select non-sensitive columns instead.');
    }
    names.add(column.name);
  }
  const rows = [];
  for (const cells of snapshot.rows) {
    if (!Array.isArray(cells) || cells.some(cell => typeof cell !== 'string')) {
      return failure('A table row is not a complete literal cell snapshot.');
    }
    const entries = [];
    for (const column of columns) {
      if (column.index >= cells.length) return failure('An output column is missing from a source row.');
      const literal = cells[column.index];
      let value = literal;
      if (column.type !== 'string') {
        const numeric = literal.trim();
        const valid = column.type === 'integer' ? /^[+-]?\d+$/.test(numeric)
          : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric);
        value = Number(numeric);
        if (!valid || !Number.isFinite(value) || (column.type === 'integer' && !Number.isSafeInteger(value))
            || column.type === 'number' && (!decimalIdentity(numeric) || decimalIdentity(numeric) !== decimalIdentity(String(value)))) {
          return failure(`Column ${JSON.stringify(column.name)} cannot be converted losslessly to ${column.type}. Use string instead.`);
        }
      }
      entries.push([column.name, value]);
    }
    rows.push(Object.fromEntries(entries));
  }
  const payload = { rowCount: rows.length, rows };
  const summary = JSON.stringify(payload);
  if (summary.length > MAX_TABLE_EXPORT_CHARS) {
    return failure('The complete table exceeds the exact export size limit. Select fewer columns or explicit rows; do not claim a complete export.');
  }
  return { success: true, payload, summary };
}

export function structuredTableAnswerBlock(state, summary) {
  if (state?.tablePageObserved !== true || typeof summary !== 'string') return null;
  let answer;
  try { answer = JSON.parse(summary.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')); }
  catch { return null; }
  if (!answer || Array.isArray(answer) || !Array.isArray(answer.rows) || !Object.hasOwn(answer, 'rowCount')) return null;
  if (!Number.isSafeInteger(answer.rowCount) || answer.rowCount !== answer.rows.length) {
    return 'The JSON rowCount does not match its rows. Use the complete exact table export instead of a sampled or inconsistent answer.';
  }
  return 'Table JSON is not verified against a complete literal source snapshot. Call extract_data with type="tables", an exact caption or table_index, columns [{name,index,type}], and optional row_filter for requested IDs. Then call done with the returned data_ref to deliver the complete JSON without sampling or changing Unicode, quotes or backslashes.';
}
