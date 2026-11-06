---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-06
scope_description: "Backend foundation for video upload and processing: local S3-compatible storage, S3 client and key layout, presigned-URL reachability, queue technology, video worker deployment and FFmpeg integration, 10GB direct-to-storage upload protocol and policies, processing trigger, video status lifecycle and failure policy, unique short URL id, streaming/download delivery and access, and the async-pipeline test strategy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module (draft pre-registration, upload handshake, stream/download URLs), the video table migration, the storage and queue integrations, and the video worker process (same codebase, separate Compose service — see TD-06). `compose.yaml` gains the object storage, queue and worker services.
- `next-frontend/` — no open decision in this document: the video UI is out of this phase's scope. The Cross-layer TDs below (TD-03, TD-08, TD-09, TD-10, TD-13, TD-14) define the HTTP/storage contract the future upload/player screens will consume; the frontend implementation is deferred to the phase that introduces those screens.

_Inherited constraints (not reopened):_ namespaced `registerAs` configs validated by Joi (`phase-01-configuracao-base/TD-01..TD-04`); class-validator DTOs, domain exception filter, `@nestjs/throttler` and global JWT guard (`phase-02-auth/TD-02, TD-06..TD-08`); `@nestjs/swagger` + exported `openapi.json` for every new endpoint (`openapi-docs-nestjs/TD-01..TD-02`); BFF model on the frontend — the browser never calls the API directly (`next-frontend-config-base/TD-03`).

_Version facts gathered for this research (2026-11-06):_ installed `@nestjs/core` 11.1.16, `jest` 30.3, `typeorm` 0.3.28, Node 25.6 on Debian bookworm, project compiled as CommonJS. Latest `@nestjs/bullmq` (12.x), `pg-boss` (12.x), `@tus/server` (2.x) and `nanoid` (6.x) are **ESM-only** packages; CommonJS-compatible lines are `@nestjs/bullmq` 11.0.5, `pg-boss` 11.1.2, `@tus/server` 1.10.2. `fluent-ffmpeg` is deprecated on npm. Official MinIO images (`minio/minio`, `quay.io/minio/minio`) are no longer pullable.

---

## TD-01: Local S3-Compatible Server Image

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture fixes object storage as S3-compatible (S3 in production, MinIO locally). That choice is not reopened. What is open is **which container image** provides it in `compose.yaml`: MinIO stopped publishing community images in Oct/2025, the project was archived in 2026, and on 2026-11-06 `minio/minio`, `quay.io/minio/minio` and `bitnami/minio` all fail `docker manifest inspect`. Without a pullable image, the storage service cannot come up in Compose.

**Options:**

### Option A: Chainguard MinIO build (`cgr.dev/chainguard/minio`)
- Same MinIO server (AGPLv3), rebuilt from source by Chainguard and published for free; verified locally: `RELEASE.2026-10-23T20-06-51Z` boots and answers `/minio/health/live`. Companion `cgr.dev/chainguard/minio-client` exists for `mc`.
- **Pros:** Literally "MinIO" as the brief and the architecture diagram state; identical S3 API; actively rebuilt with CVE fixes; zero build time.
- **Cons:** Free tier exposes only the `latest` tag (pin by digest for reproducibility). The image runs as `nonroot` (uid 65532), which fails with `file access denied` on a named volume — the service needs `user: "0"` or a volume ownership step. Third-party distribution.

### Option B: Build MinIO from source in a project Dockerfile
- A multi-stage Dockerfile compiles the archived MinIO source (Go) at a pinned tag and produces a local image.
- **Pros:** Full control and pinning; no dependency on a third-party registry.
- **Cons:** Slow first build (Go toolchain, minutes); the source is archived — no upstream security fixes; adds a build artifact the team must maintain.

### Option C: Alternative S3-compatible server (SeaweedFS / RustFS)
- Swap MinIO for another S3-compatible server with official images (`chrislusf/seaweedfs`, `rustfs/rustfs` — both pullable today).
- **Pros:** Actively maintained upstream images; still S3 API, so the application code (TD-02) is unchanged.
- **Cons:** Deviates from "MinIO locally" stated in the architecture docs and in the phase brief; S3 feature parity for multipart/presign edge cases must be re-verified; less familiar to the team.

**Recommendation:** **Option A (Chainguard MinIO)** — keeps the architecture's "MinIO locally / S3 in production" statement true with no build cost; the `nonroot` volume issue is a one-line Compose setting, and pinning by digest gives reproducibility. Because the application only speaks the S3 API (TD-02), switching to Option C later is a Compose-only change.

**Decision:** A (Chainguard MinIO build — `cgr.dev/chainguard/minio`)

---

## TD-02: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Both the API (multipart handshake, presigned URLs, object checks) and the worker (download source, upload thumbnail) talk to storage. The client must work against MinIO locally and AWS S3 in production without code changes, and must presign multipart `UploadPart` requests (TD-08). Depends on TD-01 only through the S3 API.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official modular SDK (3.1163.0). `new S3Client({ endpoint, forcePathStyle: true, region, credentials })` targets MinIO; `getSignedUrl(client, new UploadPartCommand(...))` presigns any command, including multipart parts and `GetObject` with `Range`/`ResponseContentDisposition`.
- **Pros:** Same code for MinIO and S3 (production target); presigns every S3 operation; first-class TypeScript; CommonJS-compatible; huge ecosystem.
- **Cons:** Verbose command-object API; larger dependency footprint than a single-purpose client.

### Option B: MinIO JavaScript client (`minio`)
- MinIO's own S3 client with a compact API (`putObject`, `presignedGetObject`, `presignedPutObject`).
- **Pros:** Smaller, simpler API for common cases.
- **Cons:** No first-class helper to presign individual multipart `UploadPart` calls (the 10GB path); maintained by a vendor whose server is archived; production target is AWS S3, so the AWS SDK is the more natural long-term client.

**Recommendation:** **Option A (AWS SDK v3)** — the 10GB protocol (TD-08) depends on presigning `UploadPart`, which the AWS SDK supports directly, and it is the client that will run unchanged against S3 in production.

**Decision:** A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Presigned URL Endpoint Reachability (internal vs public host)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Containers reach storage by Compose service name (`CLAUDE.md` rule), but presigned URLs are consumed **outside** the Docker network (the browser) and SigV4 signs the `Host` header — a URL signed for the internal host is unreachable from the browser, and a URL signed for the browser host is unreachable from inside containers (where the e2e tests run). This is a contract between the env schema, `compose.yaml`, the API and the client. Depends on TD-01/TD-02.

**Options:**

### Option A: Dual endpoint config + shared public hostname alias
- Two env keys: `S3_ENDPOINT` (internal, e.g. `http://storage:9000`) for server-side calls and `S3_PUBLIC_ENDPOINT` used only to presign. The public host is a name resolvable from both sides — e.g. `storage.localhost` (browsers resolve `*.localhost` to 127.0.0.1; the Compose network alias makes containers resolve it to the storage service), with port 9000 published.
- **Pros:** No manual host-machine setup; the same presigned URL works for the browser and for e2e tests inside the container; production simply sets `S3_PUBLIC_ENDPOINT` to the S3/CDN host.
- **Cons:** Two S3 client instances (internal + presign); relies on `*.localhost` resolution and a network alias — must be verified early in implementation.

### Option B: Single endpoint + host-file entry
- One endpoint (`http://storage:9000`) for everything; developers add `127.0.0.1 storage` to their OS hosts file so the browser resolves it.
- **Pros:** One client, one env key.
- **Cons:** Requires manual OS configuration on every machine (including the evaluator's) — the stack no longer "just runs" with `docker compose up`.

### Option C: Reverse proxy as the single public origin
- Add an nginx/Caddy service that exposes storage under one origin reachable from both sides and rewrites the `Host`.
- **Pros:** Single origin; production-like topology.
- **Cons:** One more infra service and its configuration for a local-only problem; Host rewriting must preserve SigV4 validity.

**Recommendation:** **Option A (dual endpoint + `storage.localhost` alias)** — the only option that works out of the box for both the browser and the in-container test runner without touching the host OS; production differs only by env value.

**Decision:** A (Dual endpoint config + `storage.localhost` shared public hostname alias)

---

## TD-04: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The API writes the original upload, the worker reads it and writes the thumbnail, and the DB stores the keys. The layout is cited by the API, the worker, the env schema and the bucket bootstrap — a cross-component contract. Phase 04 will add custom thumbnails.

**Options:**

### Option A: Single bucket, per-video prefix
- One bucket (`S3_BUCKET`, e.g. `streamtube`) with deterministic keys: `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** One bucket to bootstrap and configure; all artifacts of a video live under one prefix (easy cleanup/deletion in later phases); deterministic keys make worker retries idempotent (TD-12).
- **Cons:** Access policies cannot differ per artifact type at the bucket level (irrelevant while all access is via presigned URLs).

### Option B: One bucket per artifact type
- `videos` bucket for originals, `thumbnails` bucket for images; keys `{videoId}.{ext}`.
- **Pros:** Per-type bucket policies/lifecycle (e.g., public-read thumbnails later).
- **Cons:** Two buckets to bootstrap and configure via env; deleting a video touches two buckets; more config surface for no current need.

**Recommendation:** **Option A (single bucket, per-video prefix)** — every access in this phase goes through presigned URLs (TD-14/TD-15), so per-bucket policies bring no benefit, and a per-video prefix keeps worker retries idempotent and later deletion trivial.

**Decision:** A (Single bucket, per-video prefix)

---

## TD-05: Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as "TBD" — the main stack decision of the phase. The API publishes a processing job after upload (TD-09); the worker (TD-06) consumes it with retries (TD-12). The queue must run as real infrastructure in Compose and be exercised by tests. Compatibility constraint: the project is CommonJS with Jest/ts-jest, which does not load ESM-only packages from `node_modules` without extra configuration.

**Options:**

### Option A: BullMQ on Redis/Valkey via `@nestjs/bullmq` 11.x
- Official NestJS integration (`BullModule.forRoot/registerQueue`, `@Processor` + `WorkerHost`) over BullMQ 5.x/6.x with a Redis-compatible container (`redis:7-alpine` or `valkey/valkey:8-alpine`, both pullable).
- **Pros:** First-party NestJS docs recipe; built-in attempts/backoff, stalled-job recovery, concurrency and job progress; CommonJS line (11.0.5) fits the current toolchain; the queue is a visible, dedicated Compose service.
- **Cons:** Adds one infra service (Redis) used only by the queue; job state lives outside PostgreSQL (no transactional enqueue with the video row).

### Option B: BullMQ 6 with the PostgreSQL backend
- BullMQ 6 (Jul/2026) runs the same API on PostgreSQL ≥13 via `createPostgresBackend`; jobs live in a `bullmq` schema of the existing database.
- **Pros:** No new infra service; same BullMQ semantics as Option A; jobs share the DB the project already operates.
- **Cons:** NestJS integration of the pluggable backend exists only in `@nestjs/bullmq` 12.x, which is **ESM-only** (Jest/ESM migration or manual wiring needed); backend is ~3 months old; no dedicated queue container in Compose — weaker evidence for "fila subindo no Compose". (`pg-boss` 11.x is the CommonJS alternative in this family, with the same no-new-container trade-off and no official NestJS module.)

### Option C: RabbitMQ via `@golevelup/nestjs-rabbitmq`
- AMQP broker container (`rabbitmq:4-management-alpine`, pullable) with a mature community NestJS module.
- **Pros:** Industry-standard broker; dead-letter exchanges and acks; management UI.
- **Cons:** Retries/backoff must be built from DLX + TTL topology (not built in); more configuration (exchanges, queues, bindings); the module requires `@nestjs/core` ≥11.1.24 (installed: 11.1.16 → upgrade needed).

**Recommendation:** **Option A (BullMQ on Redis/Valkey, `@nestjs/bullmq` 11.x)** — it is the official NestJS recipe, ships the retry/backoff/stalled-job features TD-12 needs without custom topology, stays on the CommonJS toolchain the test suite runs on, and gives a dedicated queue service in Compose. The cost is one small Redis container.

**Decision:** A (BullMQ on Redis/Valkey via `@nestjs/bullmq` 11.x)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-06: Video Worker Deployment Model

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture defines a separate "Video Worker" container that consumes the queue, reads/writes storage and updates the DB. FFmpeg work is CPU-heavy and must not compete with the API serving requests. The choice determines whether the worker reuses entities, config and migrations, and how many Dockerfiles/test setups the repo carries. Depends on TD-05.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- `nestjs-project` gains a worker entrypoint (`NestFactory.createApplicationContext(WorkerModule)` — no HTTP server) run by a `video-worker` Compose service built from the same dev image (with FFmpeg installed).
- **Pros:** Reuses `Video` entity, `registerAs` configs, Joi validation, storage service and test helpers — no duplication; one dependency manifest; process isolation from the API as the diagram requires.
- **Cons:** The image is shared, so the API image also carries FFmpeg (acceptable in dev; a production split could use separate build targets).

### Option B: Separate subproject (`video-worker/`)
- A new standalone Node project with its own `package.json`, config and DB access.
- **Pros:** Hard isolation; independent deploy and dependency set.
- **Cons:** Duplicates entity/config/validation code or forces a shared package (monorepo tooling not in place); a second test setup and lint/tsc pipeline to keep green.

### Option C: Processor inside the API process
- `@Processor` registered in the API module; jobs run in the API container.
- **Pros:** Zero extra service.
- **Cons:** Contradicts the architecture's separate worker container; FFmpeg CPU spikes degrade API latency — the very "sem impacto na performance" concern of the phase.

**Recommendation:** **Option A (same codebase, separate entrypoint + `video-worker` service)** — delivers the separate worker container of the architecture while reusing every existing convention (entities, config, repository pattern, tests); Option B's isolation is not worth duplicating code at this project's size.

**Decision:** A (Same NestJS codebase, separate entrypoint and `video-worker` Compose service)

---

## TD-07: FFmpeg Integration (metadata extraction and thumbnail)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration and metadata (`ffprobe`) and render one frame as the thumbnail (`ffmpeg`). The choice covers how binaries get into the image and how Node invokes them. `fluent-ffmpeg` — the historical wrapper — is deprecated on npm and is excluded.

**Options:**

### Option A: Debian `ffmpeg` package + `child_process.execFile`
- Install `ffmpeg` (5.1 in bookworm, the base of the project's Node image) in the dev Dockerfile; the worker runs `ffprobe -v error -print_format json -show_format -show_streams <input>` and `ffmpeg -ss <t> -i <input> -frames:v 1 ...` via `execFile` with argument arrays (no shell).
- **Pros:** No npm dependency; JSON output from ffprobe maps directly to typed metadata; OS-maintained binaries; argument arrays avoid shell injection.
- **Cons:** A small typed wrapper (parse ffprobe JSON, map exit codes to errors) must be written and tested.

### Option B: npm static binaries (`ffmpeg-static` / `ffprobe-static`) + `child_process`
- Binaries downloaded at `npm install` time and resolved by path.
- **Pros:** Binaries versioned in `package.json`; no Dockerfile change.
- **Cons:** `ffprobe-static` has not been updated since 2022; install-time downloads of large binaries inside the bind-mounted `node_modules`; still needs the same wrapper as Option A.

**Recommendation:** **Option A (Debian ffmpeg + execFile)** — maintained binaries from the base image's distribution, no stale npm packages, and a thin typed wrapper we own and test. Thumbnail policy for the plan: one JPEG frame at **10% of the duration** (falling back to `0s` for clips shorter than 1s), scaled to a max width of 1280px.

**Decision:** A (Debian `ffmpeg` package + `child_process.execFile`)

---

## TD-08: 10GB Upload Protocol

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The bytes of a 10GB file must not flow through the API process (the phase's core non-functional requirement), and the project plan's "Pontos de Atenção" require that the upload can **resume after a connection failure**. A single S3 `PUT` is capped at 5GB, while multipart allows up to 10,000 parts of 5MiB–5GiB. The handshake lives on both sides: the API defines it now; the future upload screen will implement the client part. Depends on TD-02/TD-03.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (direct to storage)
- API: `CreateMultipartUpload` and returns presigned `UploadPart` URLs; the client `PUT`s each part straight to storage and keeps the returned `ETag`s; the API then calls `CompleteMultipartUpload`. To resume, the client asks the API for the already-uploaded parts (`ListParts`) and fresh URLs for the missing ones.
- **Pros:** Zero upload bytes through the API; resumable per part; parallel parts; native S3 protocol (works unchanged on AWS S3); no new service.
- **Cons:** The client must slice the file and track ETags (more client logic); presigned URL expiry must be handled by re-requesting part URLs.

### Option B: tus resumable protocol (`tusd` container or `@tus/server` + S3 store)
- A tus server receives chunks (`PATCH` with offsets) and writes them to S3 multipart behind the scenes; clients use `tus-js-client`.
- **Pros:** Standard resumable protocol with mature clients; resume by offset is built in.
- **Cons:** Bytes flow through the tus server (a new service to run, or the API process itself if embedded — exactly what the phase avoids); `@tus/server` 2.x and `@tus/s3-store` are ESM-only; one more component between client and storage.

### Option C: Single presigned PUT URL
- The API returns one presigned `PutObject` URL; the client uploads the whole file in one request.
- **Pros:** Simplest possible client and API.
- **Cons:** AWS S3 caps a single PUT at 5GB — fails the 10GB requirement in production; no resume: a dropped connection at 9GB restarts from zero.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — the only option that meets 10GB on real S3, keeps every upload byte off the API, and is resumable per part without adding a service; the extra client logic belongs to the future upload screen.

**Decision:** A (S3 multipart upload with presigned part URLs, direct to storage)

---

## TD-09: Upload Completion and Processing Trigger

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is pre-registered as a draft when the upload starts; something must detect "upload finished" and publish the processing job (TD-05). The trigger defines an endpoint contract and whether storage talks back to the system. Depends on TD-08.

**Options:**

### Option A: Explicit completion endpoint on the API
- `POST /videos/:id/upload/complete` with the part ETags: the API validates ownership, calls `CompleteMultipartUpload`, verifies the object (`HeadObject`), moves the video to processing and enqueues the job.
- **Pros:** Single place for validation, status transition and enqueue; works identically on MinIO and S3; trivial to test end-to-end; required anyway by TD-08 Option A (someone must complete the multipart upload).
- **Cons:** A client that never calls the endpoint leaves an incomplete upload (handled by the stale-upload cleanup in TD-10).

### Option B: Storage event notifications
- MinIO/S3 bucket notifications (`s3:ObjectCreated:*`) post to a webhook or the queue when the object lands.
- **Pros:** Processing starts even if the client crashes after the last byte.
- **Cons:** Different configuration per provider (MinIO targets vs S3 → SQS/EventBridge); extra bootstrap and a new inbound contract; still needs the completion call for multipart; harder to test deterministically.

**Recommendation:** **Option A (explicit completion endpoint)** — the multipart protocol already requires a completion call, so making the API own it puts validation, the status transition and the enqueue in one tested place with no provider-specific wiring.

**Decision:** A (Explicit completion endpoint on the API)

---

## TD-10: Upload Validation and Part-Sizing Policy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Presigned URLs cannot enforce a total-size cap by themselves, so the 10GB limit, the accepted file types, the part size and the URL lifetime are policies shared by the env schema, the API and the client. Abandoned uploads consume storage ("Pontos de Atenção" — storage costs). Depends on TD-08/TD-09.

**Options:**

### Option A: Server-dictated upload plan + verification on completion
- The client declares file name, MIME type and size when starting; the API rejects size > 10GiB or non-video MIME, computes the part plan with a fixed part size (env, e.g. 64MiB → 160 parts for 10GiB) and presigns only those part numbers; on completion the API checks the real object size with `HeadObject` and fails the upload if it exceeds the limit. Stale multipart uploads expire via the storage's incomplete-upload cleanup.
- **Pros:** The API controls the 10,000-part / 5MiB-minimum S3 constraints; early rejection before any byte is sent; the declared size is verified against the real object, so a lying client cannot bypass the cap.
- **Cons:** The part size is not tunable by the client per network condition.

### Option B: Client-driven parts, validation only after upload
- The client chooses the part size and requests URLs for any part number; size and type are only checked on completion or by the worker (ffprobe as source of truth).
- **Pros:** Maximum client flexibility.
- **Cons:** Oversized or non-video files are only rejected after being fully stored; the client must know S3's part constraints; easier to abuse storage.

**Recommendation:** **Option A (server-dictated plan + `HeadObject` verification)** — rejects invalid uploads before a byte moves, keeps S3's part constraints server-side, and closes the "declared vs real size" loophole. Defaults for the plan: max size `10 GiB`, part size `64 MiB`, part URL expiry `1h` (re-requestable for resume), MIME allowlist `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`.

**Decision:** A (Server-dictated upload plan + `HeadObject` verification on completion)

---

## TD-11: Video Status Model

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The phase needs a status lifecycle reflected in the database (draft at pre-registration → processing → ready or failed). Phase 04 adds a "rascunho → publicação" flow and visibility — so the word "draft" is about to mean two different things (upload not finished vs. not published). The model chosen now determines whether Phase 04 extends or migrates it.

**Options:**

### Option A: Single lifecycle enum `status`
- One column: `draft` (pre-registered, awaiting upload) → `processing` → `ready` | `failed`.
- **Pros:** Mirrors the phase's lifecycle literally in a single column; simplest queries and tests.
- **Cons:** Phase 04's publication flow overloads `draft`: a `ready` video that is not yet published is also a "draft" in Phase 04 terms, forcing an enum migration or an ambiguous meaning.

### Option B: Two orthogonal columns — publication `status` + `processing_status`
- `status` (publication: `draft` now; Phase 04 adds `published`) and `processing_status` (`awaiting_upload` → `processing` → `ready` | `failed`). Pre-registration creates `status=draft, processing_status=awaiting_upload`.
- **Pros:** Each axis has one meaning; Phase 04 only adds `published` to `status` without touching processing; "is it watchable?" and "is it public?" are independent questions in queries.
- **Cons:** Two columns to keep consistent; the lifecycle is read across two fields instead of one.

**Recommendation:** **Option B (two orthogonal columns)** — the phase's lifecycle is fully represented (`draft` at pre-registration, then `processing_status` → `processing` → `ready`/`failed`) while leaving Phase 04's publication flow a pure extension instead of a migration of overloaded values.

**Decision:** B (Two orthogonal columns — publication `status` + `processing_status`)

---

## TD-12: Processing Failure and Retry Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** FFmpeg can fail transiently (storage hiccup, worker restart) or permanently (corrupt/unsupported file). A video must never stay in `processing` forever, and the failure must be visible in the DB. Depends on TD-05/TD-11.

**Options:**

### Option A: Queue-native retries, then terminal `failed`
- The job is enqueued with a fixed number of attempts and exponential backoff; the processor is idempotent (deterministic keys, TD-04); after the last attempt the worker sets `processing_status=failed` and stores a short error reason. Stalled jobs (worker crash) are re-delivered by the queue.
- **Pros:** Transient errors self-heal; permanent errors end in a visible terminal state; uses features built into the queue (TD-05 Option A).
- **Cons:** A corrupt file is retried pointlessly (bounded by the attempt count).

### Option B: Fail fast, manual reprocess
- No automatic retry: the first error sets `failed`; an owner-triggered "reprocess" endpoint re-enqueues.
- **Pros:** Simple; no wasted retries on corrupt files.
- **Cons:** A transient blip permanently fails the video until someone acts; adds an endpoint not required by the phase.

### Option C: Retries + dead-letter queue
- Like Option A, but exhausted jobs move to a dedicated DLQ for inspection/replay.
- **Pros:** Operational visibility and replay tooling.
- **Cons:** Extra queue and tooling for a need the phase does not have; the DB `failed` state already carries the user-visible outcome.

**Recommendation:** **Option A (queue-native retries, then `failed`)** — self-heals transient errors, guarantees a terminal DB state, and costs no extra components. Defaults for the plan: `3` attempts, exponential backoff starting at `10s`; permanent ffprobe errors (unreadable/no video stream) may short-circuit to `failed` without further retries.

**Decision:** A (Queue-native retries, then terminal `failed`)

---

## TD-13: Unique Short Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique identifier for its public URL; the "Pontos de Atenção" ask for a **short** URL that never conflicts. Phase 04 introduces "unlisted" videos (reachable only by link), so the identifier must not be guessable or enumerable. The id appears in API routes and in frontend URLs — a cross-layer contract. Note: `nanoid` 6.x is ESM-only.

**Options:**

### Option A: Expose the UUID primary key
- Use the `id` (UUID v4) in the URL.
- **Pros:** Zero extra column or logic; collision-free by construction; not enumerable.
- **Cons:** 36 characters — not "short" as the project plan asks.

### Option B: Random short id from `crypto.randomBytes`, unique column + retry
- A separate `public_id`: 8 random bytes encoded base64url → 11 characters (64-bit space), stored with a `UNIQUE` constraint; on the (astronomically rare) unique violation the insert is retried with a new value — the same retry pattern already used for channel nicknames.
- **Pros:** Short, YouTube-like; not enumerable (random); no dependency (Node `crypto`, avoids the ESM-only `nanoid`); DB constraint guarantees "never conflicts".
- **Cons:** Needs the retry-on-unique-violation path and its test.

### Option C: Encoded sequential id (Sqids/Hashids over a sequence)
- Encode a DB sequence number into a short string.
- **Pros:** Short and collision-free by construction; no retry path.
- **Cons:** Reversible/enumerable — anyone can walk the sequence, which breaks Phase 04's unlisted videos; leaks upload volume.

**Recommendation:** **Option B (11-char base64url random id + unique constraint)** — meets "short" and "never conflicts" (DB-enforced) while staying unguessable for Phase 04's unlisted videos, with no new dependency; the UUID stays the internal primary key.

**Decision:** B (11-char base64url random id from `crypto.randomBytes`, unique column + retry)

---

## TD-14: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTTP `Range` → `206 Partial Content`), and the user must be able to download the file. The architecture diagram shows the frontend streaming **directly from object storage**. Under the BFF model (inherited), the browser never calls the API — so the API must hand the frontend something the `<video>` element can load directly. Depends on TD-02/TD-03.

**Options:**

### Option A: API issues short-lived presigned GET URLs (storage serves the bytes)
- `GET /videos/:publicId/stream` and `GET /videos/:publicId/download` return JSON with a presigned `GetObject` URL and its expiry; S3/MinIO natively answers `Range` requests with `206`; the download URL is signed with `ResponseContentDisposition=attachment; filename=...`.
- **Pros:** Matches the architecture (frontend streams from storage); zero video bytes through the API; Range/206 and seeking handled by the storage; same mechanism for stream and download; works through the BFF (JSON, no redirect handling).
- **Cons:** URLs are bearer links until they expire (mitigated by short expiry); authorization is checked when the URL is issued, not per byte request.

### Option B: API proxies the bytes with Range passthrough
- The API reads the `Range` header, calls `GetObject` with that range and pipes a `206` response.
- **Pros:** Authorization on every request; storage never exposed to clients.
- **Cons:** All video traffic flows through the API — bandwidth and connections compete with business requests (contradicts the phase's performance goal and the diagram).

### Option C: Adaptive streaming (HLS/DASH transcoding)
- The worker transcodes into HLS segments and a playlist; the player loads segments.
- **Pros:** Adaptive bitrate; production-grade streaming.
- **Cons:** Heavy transcoding (CPU/time/storage multiplied) far beyond the phase's "stream without full download" capability; new player requirements on the frontend.

**Recommendation:** **Option A (presigned GET URLs returned as JSON)** — the storage already implements Range/206, the bytes never touch the API, and it is exactly the "frontend streams from Object Storage" relation in the architecture; short expiry (default `1h` for the plan) limits link sharing.

**Decision:** A (Presigned GET URLs returned as JSON; storage serves Range/206)

---

## TD-15: Stream and Download Access Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The platform lets anonymous users watch freely, but Phase 03 has no publication flow yet — that arrives in Phase 04 (draft → published, public/unlisted). Who may obtain stream/download URLs now feeds the Authorization Matrix and the global JWT guard (`@Public()` opt-out). Depends on TD-11/TD-14.

**Options:**

### Option A: Owner-only until publication exists
- Only the authenticated owner of the video's channel gets stream/download URLs, and only when `processing_status=ready`; Phase 04 extends the rule to public/unlisted published videos (anonymous allowed).
- **Pros:** Never exposes unpublished content; Phase 04 extends a rule instead of tightening a public one; owner can verify the processed result.
- **Cons:** No anonymous playback demonstrable in this phase.

### Option B: Public for every ready video
- Endpoints marked `@Public()`; anyone with the `publicId` gets URLs once processing is ready.
- **Pros:** Demonstrates anonymous playback now.
- **Cons:** Exposes videos that are still drafts (not published) — Phase 04 would have to close an already-open door, a breaking behavior change.

**Recommendation:** **Option A (owner-only until publication)** — keeps drafts private, which is the safe default, and lets Phase 04 introduce anonymous access exactly where its visibility rules (public/unlisted) define it.

**Decision:** A (Owner-only until publication exists)

---

## TD-16: Async Pipeline Test Strategy

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** The testing guide covers processors at unit + integration level, but not how to prove the **whole asynchronous pipeline** (API → storage → queue → worker → DB) with real Compose infrastructure — and the phase brief forbids mocking what can run for real. The choice touches the dev Dockerfile (FFmpeg in the test runner), `compose.yaml` (worker service) and the e2e suite. A 10GB file cannot be uploaded in CI-like runs, so the size limit is proven by policy tests while the multipart path is exercised with a small multi-part file. Depends on TD-05/TD-06/TD-07.

**Options:**

### Option A: E2E against the running `video-worker` service, polling the DB
- E2E uploads a small generated video (ffmpeg `testsrc`, multi-part ≥ 5MiB parts) through presigned URLs, calls completion, then polls the video until `ready`/`failed` with a timeout; processor logic is also covered by integration tests (real DB/storage/FFmpeg) inside the API container.
- **Pros:** Exercises the real queue, the real worker container and real storage — the literal acceptance evidence; fixtures generated at test time (no binary files in git).
- **Cons:** Depends on the worker container running current code (bind mount + watch); polling adds seconds and needs a sensible timeout.

### Option B: In-process worker started inside the e2e test
- The e2e bootstraps the `WorkerModule` in the Jest process alongside the API app, against the same real Redis/storage/DB.
- **Pros:** Deterministic — no dependency on another container's state; same code paths as the worker.
- **Cons:** The `video-worker` container itself is never exercised by tests; the dev worker container would compete for the same jobs unless queues are isolated.

### Option C: Split, no full-pipeline test
- E2E asserts only that the job is enqueued; processing is covered by processor integration tests.
- **Pros:** Fastest, simplest.
- **Cons:** Never proves upload → processing → ready end-to-end — weak evidence for the phase deliverables.

**Recommendation:** **Option A (e2e against the running worker + processor integration tests)** — it is the only option that proves the delivered pipeline with the real worker container, which is exactly what the phase must demonstrate; FFmpeg is installed in the shared dev image (TD-06/TD-07) so fixtures are generated at test time.

**Decision:** A (E2E against the running `video-worker` service + processor integration tests)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Repo-wide | Local S3-compatible server image | A — Chainguard MinIO | A |
| TD-02 | Backend | S3 client library | A — AWS SDK v3 | A |
| TD-03 | Cross-layer | Presigned URL endpoint reachability | A — Dual endpoint + `storage.localhost` alias | A |
| TD-04 | Backend | Bucket and object key layout | A — Single bucket, per-video prefix | A |
| TD-05 | Backend | Queue technology | A — BullMQ on Redis/Valkey (`@nestjs/bullmq` 11.x) | A |
| TD-06 | Backend | Video worker deployment model | A — Same codebase, separate entrypoint + service | A |
| TD-07 | Backend | FFmpeg integration | A — Debian ffmpeg + `execFile` | A |
| TD-08 | Cross-layer | 10GB upload protocol | A — S3 multipart with presigned part URLs | A |
| TD-09 | Cross-layer | Upload completion and processing trigger | A — Explicit completion endpoint | A |
| TD-10 | Cross-layer | Upload validation and part-sizing policy | A — Server-dictated plan + `HeadObject` check | A |
| TD-11 | Backend | Video status model | B — Publication `status` + `processing_status` | B |
| TD-12 | Backend | Processing failure and retry policy | A — Queue retries, then `failed` | A |
| TD-13 | Cross-layer | Unique short video URL identifier | B — 11-char base64url random id + unique | B |
| TD-14 | Cross-layer | Streaming and download delivery | A — Presigned GET URLs as JSON | A |
| TD-15 | Backend | Stream and download access policy | A — Owner-only until publication | A |
| TD-16 | Repo-wide | Async pipeline test strategy | A — E2E against running worker + integration | A |
