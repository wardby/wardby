export function boundedJson(value: unknown, maxBytes: number): string {
  const seen = new Set<object>();
  let budget = maxBytes;
  let nodes = 0;
  function visit(v: unknown, depth: number) {
    if (++nodes > 100_000 || depth > 64) throw new Error("bridge_structure_limit");
    if (typeof v === "string") budget -= Buffer.byteLength(v) + 2;
    else if (v && typeof v === "object") {
      if (seen.has(v)) throw new Error("bridge_cycle");
      seen.add(v);
      for (const [key, child] of Object.entries(v)) {
        budget -= Buffer.byteLength(key) + 4;
        if (budget < 0) throw new Error("bridge_size_limit");
        visit(child, depth + 1);
      }
      seen.delete(v);
    } else budget -= 8;
    if (budget < 0) throw new Error("bridge_size_limit");
  }
  visit(value, 0);
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json) > maxBytes) throw new Error("bridge_size_limit");
  return json;
}
export function boundedString(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) throw new Error("bridge_input_limit");
}
