import { describe, expect, it } from "vitest";
import {
  appVersionSchema,
  fileNameSchema,
  isMimeAllowedForCategory,
  parseOrThrow,
  uploadConfirmSchema,
  uploadTicketSchema,
} from "@/lib/validation";
import { ApiError } from "@/lib/errors";

describe("filename validation", () => {
  it("accepts normal names", () => {
    expect(parseOrThrow(fileNameSchema, "photo-2026.jpg")).toBe("photo-2026.jpg");
    expect(parseOrThrow(fileNameSchema, "voice note (1).ogg")).toBe("voice note (1).ogg");
  });

  it("rejects path separators and traversal", () => {
    for (const bad of ["../etc/passwd", "a/b.txt", "a\\b.txt", "..", "."]) {
      expect(() => parseOrThrow(fileNameSchema, bad)).toThrow(ApiError);
    }
  });

  it("rejects control characters and overlong names", () => {
    expect(() => parseOrThrow(fileNameSchema, "bad\u0000name")).toThrow(ApiError);
    expect(() => parseOrThrow(fileNameSchema, "x".repeat(256))).toThrow(ApiError);
  });

  it("normalizes NFC and trims", () => {
    expect(parseOrThrow(fileNameSchema, "  café.jpg ")).toBe("café.jpg");
  });
});

describe("category/MIME rules", () => {
  it("enforces media prefixes per category", () => {
    expect(isMimeAllowedForCategory("voice", "audio/ogg")).toBe(true);
    expect(isMimeAllowedForCategory("voice", "video/mp4")).toBe(false);
    expect(isMimeAllowedForCategory("photo", "image/png")).toBe(true);
    expect(isMimeAllowedForCategory("photo", "application/pdf")).toBe(false);
    expect(isMimeAllowedForCategory("video", "video/webm")).toBe(true);
    expect(isMimeAllowedForCategory("chat", "text/plain")).toBe(true);
    expect(isMimeAllowedForCategory("chat", "application/json")).toBe(true);
    expect(isMimeAllowedForCategory("chat", "audio/mpeg")).toBe(false);
  });

  it("rejects unknown categories and executable-ish types in chat", () => {
    expect(isMimeAllowedForCategory("nope", "text/plain")).toBe(false);
    expect(isMimeAllowedForCategory("chat", "application/x-msdownload")).toBe(false);
  });
});

describe("upload ticket schema", () => {
  const valid = {
    category: "photo",
    name: "cat.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    idempotencyKey: "abcd1234efgh5678",
  };

  it("accepts a valid ticket", () => {
    const parsed = parseOrThrow(uploadTicketSchema, valid);
    expect(parsed.sizeBytes).toBe(1024);
  });

  it("rejects bad sizes, keys, categories", () => {
    expect(() => parseOrThrow(uploadTicketSchema, { ...valid, sizeBytes: -1 })).toThrow(ApiError);
    expect(() => parseOrThrow(uploadTicketSchema, { ...valid, sizeBytes: 0 })).toThrow(ApiError);
    expect(() => parseOrThrow(uploadTicketSchema, { ...valid, idempotencyKey: "short" })).toThrow(ApiError);
    expect(() => parseOrThrow(uploadTicketSchema, { ...valid, category: "audio" })).toThrow(ApiError);
    expect(() => parseOrThrow(uploadTicketSchema, { ...valid, mimeType: "not-a-mime" })).toThrow(ApiError);
  });

  it("validation errors carry structured details", () => {
    try {
      parseOrThrow(uploadTicketSchema, { ...valid, sizeBytes: "12" });
      expect.unreachable();
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe("VALIDATION_FAILED");
      expect(err.status).toBe(422);
      expect(err.details).toHaveProperty("issues");
    }
  });

  it("requires uploadId on confirm", () => {
    expect(() => parseOrThrow(uploadConfirmSchema, {})).toThrow(ApiError);
    expect(parseOrThrow(uploadConfirmSchema, { uploadId: "up_abc" }).uploadId).toBe("up_abc");
  });
});

describe("app version schema", () => {
  it("validates semver and https update URL", () => {
    expect(() =>
      parseOrThrow(appVersionSchema, {
        currentVersion: "1.2.3",
        minSupportedVersion: "1.0.0",
        updateUrl: "https://example.com/x",
        forceUpdate: false,
      })
    ).not.toThrow();
    expect(() =>
      parseOrThrow(appVersionSchema, {
        currentVersion: "v1",
        minSupportedVersion: "1.0.0",
        updateUrl: "",
        forceUpdate: false,
      })
    ).toThrow(ApiError);
    expect(() =>
      parseOrThrow(appVersionSchema, {
        currentVersion: "1.2.3",
        minSupportedVersion: "1.0.0",
        updateUrl: "http://insecure.example.com",
        forceUpdate: false,
      })
    ).toThrow(ApiError);
  });
});
