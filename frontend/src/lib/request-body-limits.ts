export const CSV_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const STUDENT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const CSV_IMPORT_MAX_COLUMNS = 100;
export const CSV_IMPORT_MAX_CELL_CHARS = 32_000;

export const DEFAULT_PROXY_REQUEST_MAX_BYTES = 1024 * 1024;

// A valid mapping can repeat every accepted header. JSON.stringify may encode
// each control character as a six-byte `\uXXXX` escape, so derive this from the
// backend's 100-column / 32,000-character contract instead of a typical case.
export const JSON_MAX_ESCAPED_BYTES_PER_CHARACTER = 6;
export const CSV_IMPORT_MAPPING_JSON_MAX_BYTES =
  CSV_IMPORT_MAX_COLUMNS *
  CSV_IMPORT_MAX_CELL_CHARS *
  JSON_MAX_ESCAPED_BYTES_PER_CHARACTER;
export const CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES = 2 * 1024 * 1024;
export const CSV_IMPORT_PROXY_REQUEST_MAX_BYTES =
  CSV_IMPORT_MAX_BYTES +
  CSV_IMPORT_MAPPING_JSON_MAX_BYTES +
  CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES;
export const STUDENT_PHOTO_PROXY_REQUEST_MAX_BYTES = 6 * 1024 * 1024;
