export const LUNA_PRICING = Object.freeze({
  inputPerMTok: 0.2,
  cachedInputPerMTok: 0.02,
  cacheWritePerMTok: 0.25,
  outputPerMTok: 1.2,
});

export function estimateReservationUsd(body, pricing = LUNA_PRICING) {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const conservativeInputTokens = Math.max(1, bytes);
  const maxOutputTokens = body.max_output_tokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("max_output_tokens must be a positive integer");
  }
  return (
    (conservativeInputTokens * (pricing.inputPerMTok + pricing.cacheWritePerMTok) +
      maxOutputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

export function actualCostUsd(usage, pricing = LUNA_PRICING) {
  const input = Number(usage?.input_tokens ?? 0);
  const cached = Number(usage?.input_tokens_details?.cached_tokens ?? 0);
  const cacheWrite = Number(usage?.input_tokens_details?.cache_write_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  if (
    ![input, cached, cacheWrite, output].every(Number.isFinite) ||
    input < cached ||
    cached < 0 ||
    cacheWrite < 0 ||
    output < 0
  ) {
    throw new Error("invalid authoritative usage");
  }
  return (
    ((input - cached) * pricing.inputPerMTok +
      cached * pricing.cachedInputPerMTok +
      cacheWrite * pricing.cacheWritePerMTok +
      output * pricing.outputPerMTok) /
    1_000_000
  );
}

export function completedUsageFromSseFrame(frame) {
  const lines = frame.split("\n");
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  const event = JSON.parse(data);
  if (event.type !== "response.completed") return null;
  if (!event.response?.usage) throw new Error("response.completed omitted usage");
  return event.response.usage;
}
