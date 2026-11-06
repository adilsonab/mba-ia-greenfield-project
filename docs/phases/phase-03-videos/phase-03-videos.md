---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-06T11:53:53-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-06T11:53:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-06T11:49:57-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-06T08:50:12-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver upload and processing of videos up to 10GB without impacting API performance — S3-compatible object storage for videos and thumbnails, a background processing queue consumed by a dedicated video worker, automatic draft pre-registration when the upload starts, automatic extraction of duration and metadata, automatic thumbnail generation from a video frame, a unique short URL per video, streaming without full download, and video download by the user.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; also the storage key prefix (`phase-03-videos/TD-04`) |
| public_id | varchar(11) | unique, not null | URL identifier — 8 random bytes from `crypto.randomBytes` encoded base64url; generated on insert, retried on unique violation (`phase-03-videos/TD-13`) |
| channel_id | uuid | FK → channels.id, not null | Owning channel — the owner is `channels.user_id` |
| title | varchar(100) | not null | Optional on upload start; defaults to the original file name without its extension, truncated to 100 chars (validation.md AMB-2) |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'` | Publication axis — Phase 03 only creates `draft`; Phase 04 adds `published` (`phase-03-videos/TD-11`) |
| processing_status | enum `videos_processing_status_enum` | not null, default `'awaiting_upload'`, values: `'awaiting_upload'`, `'processing'`, `'ready'`, `'failed'` | Processing axis (`phase-03-videos/TD-11`). Abandoned uploads stay `awaiting_upload` — no cleanup in this phase (validation.md AMB-3) |
| processing_error | text | nullable | Short failure reason, set when `processing_status = 'failed'` (`phase-03-videos/TD-12`) |
| original_file_name | varchar(255) | not null | As declared by the client on upload start; reused for the download `Content-Disposition` |
| content_type | varchar(100) | not null | Declared MIME type, one of the TD-10 allowlist |
| declared_size_bytes | bigint | not null | Declared size on upload start; drives the part plan (`phase-03-videos/TD-10`) |
| size_bytes | bigint | nullable | Real object size from `HeadObject` at completion (`phase-03-videos/TD-10`) |
| storage_key | varchar(255) | not null | `videos/{id}/original` (`phase-03-videos/TD-04`) |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`, set by the worker (`phase-03-videos/TD-04`, `phase-03-videos/TD-07`) |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId` while `awaiting_upload`; cleared after successful completion (`phase-03-videos/TD-08`) |
| duration_seconds | numeric(12,3) | nullable | From ffprobe `format.duration` (validation.md AMB-1) |
| width | integer | nullable | Pixels, first video stream (validation.md AMB-1) |
| height | integer | nullable | Pixels, first video stream (validation.md AMB-1) |
| video_codec | varchar(50) | nullable | First video stream `codec_name` (validation.md AMB-1) |
| audio_codec | varchar(50) | nullable | First audio stream `codec_name`; null when the file has no audio (validation.md AMB-1) |
| bitrate | bigint | nullable | Bits/s, ffprobe `format.bit_rate` (validation.md AMB-1) |
| container_format | varchar(100) | nullable | ffprobe `format.format_name` (validation.md AMB-1) |
| metadata | jsonb | nullable | Full raw ffprobe output (`-show_format -show_streams`) for audit/future use (validation.md AMB-1) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`). No inverse side added to `Channel` in this phase.
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK lookups.
**Notes:** `bigint` columns are returned by `pg` as strings — the entity maps them to `number` with a column transformer (all values are below `Number.MAX_SAFE_INTEGER`; 10 GiB ≈ 1.07e10). Both enums are PostgreSQL enum types created by the migration (the migration integration test must drop them, per the baseline fix in `src/database/migrations.integration-spec.ts`).

---

### API Contracts

All endpoints below are protected by the inherited global `JwtAuthGuard` (no `@Public()`), resolve the caller via `@CurrentUser()` (`{ sub, email }`), and are documented with explicit `@nestjs/swagger` decorators (`openapi-docs-nestjs/TD-01`). Video bytes never flow through the API: every URL returned is a presigned S3 URL signed against the **public** storage endpoint (`phase-03-videos/TD-03`, `phase-03-videos/TD-08`, `phase-03-videos/TD-14`). Response fields use snake_case, matching the existing API (`access_token`, `refresh_token`).

#### POST /videos (SI-03.5)

Starts an upload: pre-registers the video as a draft and returns the multipart upload plan (`phase-03-videos/TD-08`, `phase-03-videos/TD-10`, `phase-03-videos/TD-11`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- file_name: string, required — 1 to 255 characters
- content_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- size_bytes: integer, required — 1 to 10737418240 (10 GiB)
- title: string, optional — 1 to 100 characters after trim; when omitted, `file_name` without its extension (truncated to 100 chars)

**Response 201:**
- public_id: string (11 characters)
- title: string
- status: `"draft"`
- processing_status: `"awaiting_upload"`
- upload: object
  - part_size_bytes: integer — `67108864` (64 MiB, from config)
  - part_count: integer — `ceil(size_bytes / part_size_bytes)`
  - expires_at: string (ISO-8601) — expiry of every URL in `parts`
  - parts: array of `{ part_number: integer, url: string }` — one presigned `UploadPart` URL per part; the client sends `PUT {url}` with the raw bytes of that part (the last part may be smaller) and keeps the `ETag` response header

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (missing field, `size_bytes` above 10 GiB, `content_type` outside the allowlist)
- 401: missing or invalid access token (global guard)

---

#### GET /videos/:publicId/upload (SI-03.6)

Resume support: lists the parts already stored and re-issues URLs for the missing ones (`phase-03-videos/TD-08`, `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- public_id: string
- part_size_bytes: integer
- part_count: integer
- expires_at: string (ISO-8601)
- uploaded_parts: array of `{ part_number: integer, etag: string, size_bytes: integer }` — from `ListParts`
- parts: array of `{ part_number: integer, url: string }` — fresh presigned URLs for the part numbers not yet uploaded only

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `publicId`, or the caller is not its owner
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: `processing_status` is not `awaiting_upload`
- 410 UPLOAD_EXPIRED: the storage no longer has the multipart upload (expired incomplete upload)
- 401: missing or invalid access token (global guard)

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Completes the multipart upload, verifies the stored object and enqueues processing (`phase-03-videos/TD-09`, `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array, required — 1 to 10000 items, each:
  - part_number: integer, required — 1 to 10000
  - etag: string, required — non-empty, as returned by the storage on each part `PUT`

**Response 202:**
- public_id: string
- processing_status: `"processing"`

**Side effects (in order):** `CompleteMultipartUpload` with the parts sorted by `part_number` → `HeadObject` on `storage_key` → enqueue `video.process` (Events/Messages; `jobId` = video `id`, so a duplicate enqueue is ignored) → persist `size_bytes`, clear `upload_id`, set `processing_status = 'processing'`. The worker also sets `processing` when it starts, so a crash between enqueue and the status write self-heals.

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation
- 400 UPLOAD_INCOMPLETE: `parts` does not cover every part number `1..part_count`, or the storage rejects a part/ETag (`InvalidPart` / `InvalidPartOrder`)
- 404 VIDEO_NOT_FOUND: no video with this `publicId`, or the caller is not its owner
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: `processing_status` is not `awaiting_upload`
- 410 UPLOAD_EXPIRED: the storage no longer has the multipart upload
- 422 UPLOAD_SIZE_MISMATCH: the stored object size differs from `declared_size_bytes` — the object is deleted, `processing_status` becomes `failed` with `processing_error` set
- 401: missing or invalid access token (global guard)

---

#### GET /videos/:publicId (SI-03.10)

Video detail for its owner — exposes the status lifecycle and the extracted metadata (`phase-03-videos/TD-11`, validation.md AMB-1).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- public_id: string
- title: string
- status: `"draft"`
- processing_status: `"awaiting_upload"` | `"processing"` | `"ready"` | `"failed"`
- processing_error: string | null
- original_file_name: string
- content_type: string
- size_bytes: integer | null
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- bitrate: integer | null
- container_format: string | null
- thumbnail_url: string | null — presigned GET of the thumbnail (1h), null until a thumbnail exists
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

Internal fields (`id`, `channel_id`, `storage_key`, `thumbnail_key`, `upload_id`, `declared_size_bytes`, `metadata`) are never exposed.

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `publicId`, or the caller is not its owner
- 401: missing or invalid access token (global guard)

---

#### GET /videos/:publicId/stream (SI-03.11)

Returns a short-lived URL the player loads directly; the storage answers `Range` requests with `206 Partial Content` (`phase-03-videos/TD-14`, `phase-03-videos/TD-15`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — presigned `GetObject` on `storage_key`, expiry 1h (from config)
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `publicId`, or the caller is not its owner
- 409 VIDEO_NOT_READY: `processing_status` is not `ready`
- 401: missing or invalid access token (global guard)

---

#### GET /videos/:publicId/download (SI-03.11)

Returns a short-lived URL that downloads the original file as an attachment (`phase-03-videos/TD-14`, `phase-03-videos/TD-15`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — presigned `GetObject` on `storage_key` with `ResponseContentDisposition = attachment; filename="{original_file_name}"`, expiry 1h
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `publicId`, or the caller is not its owner
- 409 VIDEO_NOT_READY: `processing_status` is not `ready`
- 401: missing or invalid access token (global guard)

---

#### Validation Rules — Upload Start and Completion

| Field | Rule | Source |
|-------|------|--------|
| file_name | Required string, 1–255 characters | Column `original_file_name` varchar(255) |
| content_type | Required, one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` | `phase-03-videos/TD-10` |
| size_bytes | Required integer, 1 ≤ value ≤ 10737418240 | `phase-03-videos/TD-10` (10 GiB) |
| title | Optional string, 1–100 characters after trim | validation.md AMB-2 |
| parts | Required array, 1–10000 items | S3 multipart limit (library-refs.md) |
| parts[].part_number | Required integer, 1–10000 | S3 multipart limit (library-refs.md) |
| parts[].etag | Required non-empty string | S3 `CompletedPart.ETag` (library-refs.md) |

---

### Authorization Matrix

Ownership rule: the caller owns a video when `videos.channel_id` points to the channel whose `user_id` equals the JWT `sub`. Non-owners receive **404 VIDEO_NOT_FOUND** (not 403) so the existence of a draft is never disclosed — consistent with the unguessable `public_id` (`phase-03-videos/TD-13`) and with Phase 04's unlisted videos (`phase-03-videos/TD-15`).

| Endpoint | Anonymous | Authenticated (non-owner) | Owner | Notes |
|----------|-----------|---------------------------|-------|-------|
| POST /videos | ✗ (401) | ✓ | — | Creates a video in the caller's own channel |
| GET /videos/:publicId/upload | ✗ (401) | ✗ (404) | ✓ | Only while `awaiting_upload` |
| POST /videos/:publicId/upload/complete | ✗ (401) | ✗ (404) | ✓ | Only while `awaiting_upload` |
| GET /videos/:publicId | ✗ (401) | ✗ (404) | ✓ | Any processing status |
| GET /videos/:publicId/stream | ✗ (401) | ✗ (404) | ✓ | Only when `ready` (`phase-03-videos/TD-15`) |
| GET /videos/:publicId/download | ✗ (401) | ✗ (404) | ✓ | Only when `ready` (`phase-03-videos/TD-15`) |

Phase 04 extends stream/download (and detail) to anonymous callers for published public/unlisted videos; Phase 03 keeps every video owner-only (`phase-03-videos/TD-15`).

---

### Error Catalog

**Error response format:** inherited from Phase 02 (`phase-02-auth/TD-07`) — `{ statusCode: number, error: string, message: string }`, produced by the existing `DomainExceptionFilter`; validation failures keep `error: "VALIDATION_ERROR"` with `message` as an array of field errors. New errors are `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`; services throw them, never NestJS HTTP exceptions.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:publicId…` endpoint when no video has that `public_id` **or** the caller does not own it (see Authorization Matrix) |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | Video upload is not in progress | GET `/videos/:publicId/upload` or POST `/videos/:publicId/upload/complete` when `processing_status` ≠ `awaiting_upload` |
| UPLOAD_INCOMPLETE | 400 | Upload parts are missing or invalid | POST `/videos/:publicId/upload/complete` when `parts` does not cover `1..part_count`, or the storage rejects a part/ETag (`InvalidPart`, `InvalidPartOrder`) |
| UPLOAD_EXPIRED | 410 | Upload session has expired | Resume or completion when the storage returns `NoSuchUpload` for the stored `upload_id` (incomplete upload expired — `phase-03-videos/TD-10`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size does not match the declared size | Completion when `HeadObject.ContentLength` ≠ `declared_size_bytes`; the object is deleted and the video is marked `failed` (`phase-03-videos/TD-10`) |
| VIDEO_NOT_READY | 409 | Video is not ready | GET `/videos/:publicId/stream` or `/download` when `processing_status` ≠ `ready` (`phase-03-videos/TD-15`) |

**Worker-side failures** never reach HTTP: they are recorded as `processing_status = 'failed'` plus `processing_error` (`phase-03-videos/TD-12`). Recorded reasons: `"Unsupported or corrupt media: <ffprobe message>"` (no video stream / unreadable — `UnrecoverableError`, no retry) and `"Processing failed after 3 attempts: <last error message>"` (transient errors exhausted).

---

### Events/Messages

#### video.process

Job on the BullMQ queue **`video-processing`** (Redis connection from config; Compose service name as host) (`phase-03-videos/TD-05`).

**Payload:**

```json
{ "videoId": "uuid" }
```

`videoId` is the internal `videos.id` (never the `public_id`). The worker loads everything else (keys, declared content type) from the database, so the payload stays minimal and never goes stale.

**Job options:** `jobId` = `videoId` (a duplicate enqueue for the same video is ignored); `attempts: 3`; `backoff: { type: 'exponential', delay: 10000 }`; `removeOnComplete: true`; `removeOnFail: false` (failed jobs kept in Redis for inspection; the DB row is the durable record) (`phase-03-videos/TD-12`, library-refs.md → bullmq).

**Producer:** `VideosService` in the API process, on successful upload completion — POST `/videos/:publicId/upload/complete` (per `phase-03-videos/TD-09`).
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')`, `WorkerHost`) registered **only** in the worker module run by the `video-worker` Compose service — the API process never consumes jobs (per `phase-03-videos/TD-06`).
**Trigger:** the multipart upload was completed and the stored object size was verified.
**Delivery semantics:** at-least-once — BullMQ re-delivers stalled jobs after a worker crash and retries failures (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`). The processor is idempotent: it overwrites the deterministic `videos/{id}/thumbnail.jpg` key and rewrites the same metadata columns, so a repeated run converges to the same row (`phase-03-videos/TD-04`).

**Processing steps (consumer):**

1. Load the video; if it no longer exists or is already `ready`, finish the job without changes (idempotent re-delivery).
2. Set `processing_status = 'processing'` (self-heals the producer's crash window).
3. Download `storage_key` to a temporary file (`GetObject` stream → file).
4. `ffprobe -v error -print_format json -show_format -show_streams` via `execFile` → persist the typed metadata columns + raw `metadata` jsonb (`phase-03-videos/TD-07`, validation.md AMB-1). No video stream or unreadable file → throw `UnrecoverableError` (no retry).
5. `ffmpeg` extracts one JPEG frame at 10% of the duration (`0s` when shorter than 1s), scaled to a max width of 1280px → `PutObject` to `videos/{id}/thumbnail.jpg`; persist `thumbnail_key` (`phase-03-videos/TD-07`).
6. Set `processing_status = 'ready'`, clear `processing_error`; delete the temporary files (always, also on failure).

**Failure handling:** an `@OnWorkerEvent('failed')` handler marks `processing_status = 'failed'` with `processing_error` when the job will not be retried again — `UnrecoverableError`, or `attemptsMade` reached `attempts` (`phase-03-videos/TD-12`). Intermediate failures keep `processing`.

#### Processing lifecycle (status transitions)

| From → To (`processing_status`) | Actor | When |
|---------------------------------|-------|------|
| — → `awaiting_upload` (with `status = 'draft'`) | API — POST /videos | Upload starts: draft pre-registered (`phase-03-videos/TD-11`) |
| `awaiting_upload` → `processing` | API — upload complete | Multipart completed, size verified, job enqueued (`phase-03-videos/TD-09`) |
| `awaiting_upload` → `failed` | API — upload complete | Stored size ≠ declared size (UPLOAD_SIZE_MISMATCH) (`phase-03-videos/TD-10`) |
| `processing` → `ready` | Worker | Metadata + thumbnail persisted (`phase-03-videos/TD-07`) |
| `processing` → `failed` | Worker | Unrecoverable media error, or retries exhausted (`phase-03-videos/TD-12`) |
| `awaiting_upload` (stays) | — | Upload abandoned — no cleanup in this phase (validation.md AMB-3) |

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
