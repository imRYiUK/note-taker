// Download file names for exports (server Content-Disposition and viewer PNG).

/** The notebook title without characters file systems dislike, plus `suffix` and extension. */
export function exportFileName(title: string, ext: string, suffix = ""): string {
  const base = title.replace(/[\u0000-\u001f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "notes";
  return `${base}${suffix}.${ext}`;
}

/** " - p3" for page 3 of a multi-page notebook, "" otherwise. */
export function pageSuffix(index: number, pages: number): string {
  return pages > 1 ? ` - p${index + 1}` : "";
}
