import { describe, expect, it } from "vitest";
import { redactPii } from "./pii-redaction.js";

describe("redactPii", () => {
  it("redacts an email address", () => {
    expect(redactPii("contact jane.doe+test@example.co.uk for details")).toBe("contact [REDACTED_EMAIL] for details");
  });

  it("redacts a US-format SSN", () => {
    expect(redactPii("ssn: 123-45-6789")).toBe("ssn: [REDACTED_SSN]");
  });

  it.each(["555-123-4567", "(555) 123-4567", "+1 555.123.4567"])("redacts a formatted phone number %s", (phone) => {
    expect(redactPii(`call ${phone} now`)).toBe("call [REDACTED_PHONE] now");
  });

  it("redacts a contiguous 16-digit credit-card-like run", () => {
    expect(redactPii("card 4111111111111111 on file")).toBe("card [REDACTED_CREDIT_CARD] on file");
  });

  it("redacts a grouped 4-4-4-4 credit-card-like run", () => {
    expect(redactPii("card 4111-1111-1111-1111 on file")).toBe("card [REDACTED_CREDIT_CARD] on file");
  });

  it("redacts multiple occurrences across a single string", () => {
    expect(redactPii("a@b.com and c@d.com")).toBe("[REDACTED_EMAIL] and [REDACTED_EMAIL]");
  });

  it("leaves ordinary text and short numbers untouched", () => {
    const text = "run #42 finished with status 200 in 3 steps";
    expect(redactPii(text)).toBe(text);
  });
});
