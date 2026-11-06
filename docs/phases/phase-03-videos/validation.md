---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-06T11:02:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-06T10:32:28-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-FS storage in tests vs real S3 storage (TD-01/TD-16)"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "'extração de duração e metadados' — metadata field set and storage shape unspecified"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Pre-registration as draft — source of the required title at upload start undefined"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Draft rows whose upload never completes — DB lifecycle (abort/cleanup) unaddressed"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Local S3-Compatible Server Image"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — S3 Client Library"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Presigned URL Endpoint Reachability"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Bucket and Object Key Layout"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Queue Technology"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Video Worker Deployment Model"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — FFmpeg Integration"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — 10GB Upload Protocol"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Upload Completion and Processing Trigger"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Upload Validation and Part-Sizing Policy"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Video Status Model"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Processing Failure and Retry Policy"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Unique Short Video URL Identifier"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Stream and Download Access Policy"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-16
    status: resolved
    summary: "TD-16 pending — Async Pipeline Test Strategy"
    resolved_by: phase-03-videos/TD-16
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI scope deferred — `## UI Inventory` carries the deferred placeholder; Check 7 does not apply.)_

## Resolved Issues

- **IC-1** _(resolved_by clarification)_ — Real S3-compatible storage (MinIO per `phase-03-videos/TD-01`) is used in development **and** in tests, accessed through the S3 API (`TD-02`); the testing guide's *"Object Storage — Local Filesystem"* strategy (`references/external-systems.md`) does not apply to this project's storage, because presigned multipart (`TD-08`) and Range/206 presigned GETs (`TD-14`) only exist on real S3-compatible storage. Updating the testing guide is tracked as a separate task (out of this phase's scope).
- **AMB-1** _(resolved_by clarification)_ — Persisted metadata = **typed columns** for what the platform shows or queries — duration (seconds, fractional), width and height (pixels), video codec, audio codec (nullable — video may have no audio stream), bitrate (bits/s), container format and file size (bytes) — **plus** one `jsonb` column holding the full raw ffprobe output (audit/future use). Exact column names and types are fixed in the plan's Data Model.
- **AMB-2** _(resolved_by clarification)_ — The upload-start request accepts an **optional** title; when omitted, the draft's title defaults to the uploaded file name without its extension. The title column is therefore always populated (NOT NULL). Editing the title remains Phase 04 scope.
- **AMB-3** _(resolved_by clarification)_ — Drafts whose upload is never completed **stay** in their pre-upload processing state (`awaiting_upload`, per `TD-11`); this phase adds no abort endpoint and no cleanup job (video management/deletion belongs to Phase 04's panel). The abandoned storage parts are reclaimed by the storage's incomplete-upload expiry (`TD-10`).
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decided: A (Chainguard MinIO build — `cgr.dev/chainguard/minio`).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decided: A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decided: A (Dual endpoint config + `storage.localhost` shared public hostname alias).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decided: A (Single bucket, per-video prefix).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decided: A (BullMQ on Redis/Valkey via `@nestjs/bullmq` 11.x).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decided: A (Same NestJS codebase, separate entrypoint and `video-worker` Compose service).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decided: A (Debian `ffmpeg` package + `child_process.execFile`).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided: A (S3 multipart upload with presigned part URLs, direct to storage).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decided: A (Explicit completion endpoint on the API).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decided: A (Server-dictated upload plan + `HeadObject` verification on completion).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decided: B (Two orthogonal columns — publication `status` + `processing_status`).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 decided: A (Queue-native retries, then terminal `failed`).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 decided: B (11-char base64url random id from `crypto.randomBytes`, unique column + retry).
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 decided: A (Presigned GET URLs returned as JSON; storage serves Range/206).
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — TD-15 decided: A (Owner-only until publication exists).
- **OQ-16** _(resolved_by phase-03-videos/TD-16)_ — TD-16 decided: A (E2E against the running `video-worker` service + processor integration tests).
