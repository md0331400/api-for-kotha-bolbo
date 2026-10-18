import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { FILE_CATEGORIES } from "@/lib/db/types";

/** Shared validation for client input. */

export const categoryName = z.enum(FILE_CATEGORIES);

// Filenames: no path separators, no control characters, NFC-normalized, 1..255.
export const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .transform((s) => s.normalize("NFC").trim())
  .refine((s) => s.length >= 1 && s.length <= 255, "filename length must be 1..255")
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "filename contains control characters")
  .refine((s) => !/[\\/]/.test(s), "filename must not contain path separators")
  .refine((s) => s !== "." && s !== "..", "filename is not allowed");

export const mimeTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, "invalid MIME type");

export const sizeSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_:~-]+$/, "idempotency key must be URL-safe");

export const uploadTicketSchema = z.object({
  category: categoryName,
  name: fileNameSchema,
  mimeType: mimeTypeSchema,
  sizeBytes: sizeSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const uploadConfirmSchema = z.object({
  uploadId: z.string().min(3).max(64),
  providerFileId: z.string().min(3).max(256).optional(),
});

export const fileListQuerySchema = z.object({
  category: categoryName.optional(),
  status: z.enum(["pending_delete", "confirmed", "deleted", "delete_failed"]).optional(),
  expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
  createdAfter: z.coerce.number().int().nonnegative().optional(),
  createdBefore: z.coerce.number().int().nonnegative().optional(),
  q: z.string().max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["createdAt", "expiresAt", "sizeBytes"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const adminFileListQuerySchema = fileListQuerySchema.extend({
  uid: z.string().max(128).optional(),
});

export const adminUserListQuerySchema = z.object({
  q: z.string().max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const setUserQuotaSchema = z
  .object({
    quotaBytes: z.number().int().min(0).max(1024 * 1024 * 1024 * 1024).optional(),
    restricted: z.boolean().optional(),
  })
  .refine((v) => v.quotaBytes !== undefined || v.restricted !== undefined, {
    message: "nothing to update",
  });

export const appVersionSchema = z.object({
  currentVersion: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$/, "must be semver-like (e.g. 1.2.3)"),
  minSupportedVersion: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$/, "must be semver-like (e.g. 1.2.3)"),
  updateUrl: z
    .string()
    .max(512)
    .refine((s) => s === "" || /^https:\/\//.test(s), "updateUrl must be https"),
  forceUpdate: z.boolean(),
  releaseNotes: z.string().max(4000).nullable().optional(),
});

export const drivePatchSchema = z
  .object({
    action: z.enum(["enable", "disable", "retry"]),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const notificationTokenSchema = z.object({
  token: z.string().min(10).max(4096),
  platform: z.enum(["web", "android", "ios", "unknown"]).default("unknown"),
});

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join(".") || "(body)",
      message: i.message,
    }));
    throw new ApiError("VALIDATION_FAILED", "Input validation failed.", { details: { issues } });
  }
  return result.data;
}

/**
 * Category ↔ MIME validation. Each category accepts a media-type prefix plus a
 * small explicit set (e.g. chat text/JSON payloads).
 */
export function isMimeAllowedForCategory(category: string, mime: string): boolean {
  const m = mime.toLowerCase().split(";")[0].trim();
  switch (category) {
    case "chat":
      return (
        m.startsWith("text/") ||
        ["application/json", "application/xml", "application/pdf"].includes(m)
      );
    case "voice":
      return m.startsWith("audio/");
    case "photo":
      return m.startsWith("image/");
    case "video":
      return m.startsWith("video/");
    case "other":
      return (
        m.startsWith("application/") ||
        m.startsWith("text/") ||
        m.startsWith("image/") ||
        m.startsWith("audio/") ||
        m.startsWith("video/") ||
        m === "model/gltf-binary"
      );
    default:
      return false;
  }
}
