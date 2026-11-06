/** MIME allowlist for uploads (phase-03-videos/TD-10). */
export const VIDEO_ALLOWED_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export type VideoContentType = (typeof VIDEO_ALLOWED_CONTENT_TYPES)[number];

/**
 * 10 GiB hard cap enforced at the DTO boundary (phase-03-videos/TD-10).
 * Decorators are evaluated at import time, before ConfigModule loads `.env`,
 * so the cap is a constant rather than the `VIDEO_MAX_SIZE_BYTES` setting.
 */
export const VIDEO_MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const VIDEO_TITLE_MAX_LENGTH = 100;
export const VIDEO_FILE_NAME_MAX_LENGTH = 255;

/** Attempts to insert with a fresh `public_id` on unique violation (phase-03-videos/TD-13). */
export const PUBLIC_ID_MAX_ATTEMPTS = 5;

/** S3 multipart limits (library-refs.md → @aws-sdk/client-s3). */
export const S3_MAX_PARTS = 10000;
