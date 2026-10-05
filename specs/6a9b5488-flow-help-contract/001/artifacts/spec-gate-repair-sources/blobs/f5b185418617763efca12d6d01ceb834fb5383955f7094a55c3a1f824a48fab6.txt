const DEFAULT_PREVIEW_CHARS = 200;

function formatPreview(value, maxChars = DEFAULT_PREVIEW_CHARS) {
  if (value == null) return "";
  const text = String(value).trim();
  if (!text) return "";
  return text.slice(0, maxChars);
}

export { DEFAULT_PREVIEW_CHARS, formatPreview };
