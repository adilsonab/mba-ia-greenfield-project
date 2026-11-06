---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 20
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-06T11:02:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-06T10:32:28-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide prescribes local-FS storage in tests vs real S3 storage (TD-01/TD-16)"
  - id: AMB-1
    status: open
    summary: "'extração de duração e metadados' — metadata field set and storage shape unspecified"
  - id: AMB-2
    status: open
    summary: "Pre-registration as draft — source of the required title at upload start undefined"
  - id: AMB-3
    status: open
    summary: "Draft rows whose upload never completes — DB lifecycle (abort/cleanup) unaddressed"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Local S3-Compatible Server Image"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — S3 Client Library"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Presigned URL Endpoint Reachability"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Bucket and Object Key Layout"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Queue Technology"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Video Worker Deployment Model"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — FFmpeg Integration"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — 10GB Upload Protocol"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Upload Completion and Processing Trigger"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Upload Validation and Part-Sizing Policy"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Video Status Model"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Processing Failure and Retry Policy"
  - id: OQ-13
    status: open
    summary: "TD-13 pending — Unique Short Video URL Identifier"
  - id: OQ-14
    status: open
    summary: "TD-14 pending — Streaming and Download Delivery"
  - id: OQ-15
    status: open
    summary: "TD-15 pending — Stream and Download Access Policy"
  - id: OQ-16
    status: open
    summary: "TD-16 pending — Async Pipeline Test Strategy"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `## Testing Requirements` carries the testing guide's external-system strategy *"Object Storage — Local Filesystem: Local filesystem storage in development and tests. S3 in production."* / *"In tests, use the local filesystem adapter — no mocking needed."*, while the phase's storage TDs recommend real S3-compatible storage running in Compose and exercised by the tests: `phase-03-videos/TD-01` (MinIO container), `phase-03-videos/TD-02` (AWS SDK against MinIO locally and S3 in production) and `phase-03-videos/TD-16` (e2e uploads through presigned URLs to the real storage, polled until processed). Both cannot hold: a local-filesystem adapter cannot serve presigned multipart URLs (`TD-08`) nor Range/206 presigned GETs (`TD-14`). Explicit choice: (a) real S3-compatible storage in dev **and** tests, recording that the testing guide's local-filesystem strategy does not apply to this project's storage (guide update tracked as a separate task); (b) keep the guide's local-filesystem adapter for tests and revisit `TD-08`/`TD-14`/`TD-16`, which depend on presigning.

### Ambiguities

- **AMB-1** — Capability *"Processamento automático do vídeo após upload (extração de duração e metadados)"* names duration explicitly but leaves "metadados" open: no TD or scope text says which ffprobe fields are persisted (e.g., width/height, codecs, bitrate, container format, file size) nor whether they are typed columns or a raw document. The Data Model of the plan cannot be written without it. Explicit choice: define the persisted metadata set and its storage shape (typed columns for the fields the platform will query/show vs. a raw JSON document for the full ffprobe output, or both).
- **AMB-2** — Capability *"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"* creates the video row before any user editing (title/description editing belongs to Phase 04 — *"Edição das informações do vídeo: título, descrição, categoria e thumbnail customizada"*). It is undefined where the draft's title comes from at upload start. Explicit choice: (a) client sends a title in the upload-start request (required or optional); (b) derive the initial title from the uploaded file name; (c) title nullable until Phase 04 editing.
- **AMB-3** — The upload flow (`TD-08`/`TD-09`) pre-registers a draft and relies on an explicit completion call; `TD-10` handles abandoned **storage** parts via the storage's incomplete-upload expiry, but nothing addresses the **database** row of a draft whose upload is never completed (client crash, user gives up). The scope does not say whether such drafts stay forever in their pre-upload state, can be aborted by the owner, or are cleaned up. Explicit choice: (a) keep them (visible as "awaiting upload" in Phase 04's panel), no cleanup in this phase; (b) add an owner-triggered abort endpoint (aborts the multipart upload and removes/marks the draft); (c) scheduled cleanup of drafts older than the storage expiry.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Local S3-Compatible Server Image. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-2** — TD-02 pending — S3 Client Library. Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-3** — TD-03 pending — Presigned URL Endpoint Reachability (internal vs public host). Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-4** — TD-04 pending — Bucket and Object Key Layout. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-5** — TD-05 pending — Queue Technology. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-6** — TD-06 pending — Video Worker Deployment Model. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-7** — TD-07 pending — FFmpeg Integration (metadata extraction and thumbnail). Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-8** — TD-08 pending — 10GB Upload Protocol. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-9** — TD-09 pending — Upload Completion and Processing Trigger. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-10** — TD-10 pending — Upload Validation and Part-Sizing Policy. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-11** — TD-11 pending — Video Status Model. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-12** — TD-12 pending — Processing Failure and Retry Policy. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-13** — TD-13 pending — Unique Short Video URL Identifier. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-14** — TD-14 pending — Streaming and Download Delivery. Resolution: fill the **Decision:** field of TD-14 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-15** — TD-15 pending — Stream and Download Access Policy. Resolution: fill the **Decision:** field of TD-15 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.
- **OQ-16** — TD-16 pending — Async Pipeline Test Strategy. Resolution: fill the **Decision:** field of TD-16 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve 03`), then re-run `/plan-validate 03`.

### UI Coverage Gaps

_None._ _(UI scope deferred — `## UI Inventory` carries the deferred placeholder; Check 7 does not apply.)_

## Resolved Issues

_No issues resolved yet._
