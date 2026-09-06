export function requireSubject(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error("Invalid token subject.");
  }
  return value;
}
