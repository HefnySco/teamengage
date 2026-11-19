import { describe, it, expect } from "vitest";
import { scanSecrets, redactSecrets } from "./secrets.js";

describe("scanSecrets", () => {
  it("finds common key shapes and reports the line", () => {
    const hits = scanSecrets(
      [
        "line one is fine",
        "the key was sk-ant-api03-AbCdEfGhIjKlMnOpQr",
        "token = ghp_0123456789abcdef0123456789",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "password: hunter2hunter2",
      ].join("\n"),
    );
    expect(hits.map((h) => h.line)).toEqual([2, 3, 4, 5]);
    expect(hits.map((h) => h.kind)).toEqual([
      "anthropic_key",
      "github_token",
      "private_key",
      "credential",
    ]);
    // the secret itself never travels in the report — only a masked preview
    expect(hits[0].preview).toBe("sk-ant-a…");
    for (const h of hits) expect(h.preview).not.toContain("hunter2hunter2");
  });

  it("ignores placeholders and ordinary prose", () => {
    expect(
      scanSecrets("password: changeme\napi_key: ${API_KEY}\nnothing here\npassword: <redacted>"),
    ).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("masks the value, keeps the key name so the line still reads", () => {
    const { text, hits } = redactSecrets(
      "user: use api_key = sk-ant-api03-AbCdEfGhIjKlMnOpQr here\npassword: hunter2hunter2",
    );
    expect(text).toContain("api_key = [REDACTED]");
    expect(text).toContain("password: [REDACTED]");
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("hunter2");
    expect(hits).toHaveLength(2);
    // a second scan finds nothing left
    expect(scanSecrets(text)).toEqual([]);
  });
});
