import { randomBytes } from 'crypto';

/**
 * 8 random bytes → 11 base64url characters (64-bit space): short, URL-safe and
 * unguessable (phase-03-videos/TD-13). Uniqueness is guaranteed by the DB
 * constraint; callers retry on the (astronomically rare) collision.
 */
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

/** Default title: file name without its extension, capped to `maxLength` (validation.md AMB-2). */
export function defaultTitleFromFileName(
  fileName: string,
  maxLength: number,
): string {
  const lastDot = fileName.lastIndexOf('.');
  const base = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
  const title = base.trim() || fileName.trim();
  return title.slice(0, maxLength);
}
