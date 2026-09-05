export function normalizeText(s: string): string {
  // Guard runtime non-string inputs (missing metadata from plain-JS callers);
  // type-level input stays string, this only prevents a TypeError mid-pipeline.
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}
