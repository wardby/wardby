// Remove only after the database, browser, migration, and independent review gates pass.
export function assertSelfHostedReleased(): void {
  throw new Error("Self-hosted OAuth issuance is quarantined pending the security release gates. Use delegating OAuth or stdio.");
}
