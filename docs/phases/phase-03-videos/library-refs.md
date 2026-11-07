---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1163.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-06T11:53:01-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1163.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-06T11:53:01-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com/__branch__11.0.0"
    fetched_at: "2026-11-06T11:53:01-03:00"
  "bullmq":
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq/v5.81.5"
    fetched_at: "2026-11-06T11:53:01-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-06T11:49:57-03:00"
---

# Library References — phase-03-videos

Distilled from Context7 for the surfaces the Phase 03 TDs use. Versions are the ones to install; they are compatible with the installed toolchain (NestJS 11.1.16, CommonJS, Jest 30 + ts-jest).

**Version-pin rationale (verified on npm, 2026-11-06):**

- `@nestjs/bullmq` is pinned to the **11.x** line: `12.x` is ESM-only (`"type": "module"`), which ts-jest in this CommonJS project cannot load from `node_modules` (`phase-03-videos/TD-05`). `11.0.5` peers: `bullmq ^3||^4||^5||^6`, `@nestjs/core ^10||^11`.
- `bullmq` is pinned to **5.x** (`5.81.5`, CommonJS `dist/cjs`): the documented API used here (`attempts`/`backoff`, `UnrecoverableError`, stalled-job recovery) is identical in 6.x, but 5.x is the line Context7 documents for this version and the one `@nestjs/bullmq` 11 was built against. 6.x's new Postgres backend is not used (`TD-05` chose Redis).
- AWS SDK v3 packages must share the **same version** (`client-s3` and `s3-request-presigner` are released in lockstep).

### @aws-sdk/client-s3

Used by: `phase-03-videos/TD-02` (client), `TD-03` (dual endpoint), `TD-04` (keys), `TD-08`/`TD-09`/`TD-10` (multipart handshake + verification).

- **Client against MinIO:** `new S3Client({ endpoint, forcePathStyle: true, region, credentials: { accessKeyId, secretAccessKey } })`. `forcePathStyle: true` puts the bucket in the path (`host/bucket/key`) instead of a subdomain — required for MinIO and for the `storage.localhost` public host (`TD-03`). `endpoint` accepts a URL string. Two client instances per `TD-03`: one with the internal endpoint (server-side calls), one with the public endpoint used **only** for presigning.
- **Multipart commands** (`TD-08`):
  - `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → returns `UploadId`.
  - `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` — **presigned**, not sent by the API; `PartNumber` is an integer `1..10000`. The client's `PUT` response carries the part `ETag`.
  - `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` — `Parts` must be the client-reported ETags in ascending `PartNumber`; an invalid/missing part yields HTTP 400.
  - `ListPartsCommand({ Bucket, Key, UploadId })` — returns already-uploaded parts (`PartNumber`, `ETag`, `Size`); max 1000 per page — enough for the 160-part plan (`TD-10`). Used for resume.
  - `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` — discards parts (not used by an endpoint in this phase per AMB-3 resolution; available for tests/cleanup).
- **Verification on completion** (`TD-10`): `HeadObjectCommand({ Bucket, Key })` → `ContentLength` (bytes), `ContentType`, `ETag`, `AcceptRanges: "bytes"` — no body download.
- **Worker I/O** (`TD-06`/`TD-07`): `GetObjectCommand` to read the original (stream `Body` to a temp file for ffprobe/ffmpeg), `PutObjectCommand({ Bucket, Key, Body, ContentType: 'image/jpeg' })` to store the thumbnail.
- **Gotcha — ETag & CORS:** a browser can only read the part `ETag` response header if the storage's CORS config exposes it (`ExposeHeaders: ETag`). Not exercised in this phase (no browser client), but part of the cross-layer contract the future upload screen depends on (`TD-08`).
- **S3 limits (AWS docs):** single `PUT` ≤ 5 GB (why `TD-08` rejects a single presigned PUT); multipart parts 5 MiB–5 GiB except the last part (no minimum); ≤ 10,000 parts.

### @aws-sdk/s3-request-presigner

Used by: `TD-03`, `TD-08` (part URLs), `TD-14` (stream/download URLs).

- `getSignedUrl(client, command, { expiresIn })` — presigns any S3 command; `expiresIn` is in **seconds**, default `900` when omitted. Plan defaults: part URLs `3600` (`TD-10`), stream/download URLs `3600` (`TD-14`).
- Presign `UploadPartCommand` per part number for the upload plan; presign `GetObjectCommand({ Bucket, Key })` for streaming — the storage answers `Range` with `206 Partial Content`.
- **Download:** `GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="<name>"' })` — response-header overrides **must be signed** (only valid via Authorization header or presigned URL), which is exactly the presigned flow.
- The presigner does **not** compare `expiresIn` with credential expiry — with static MinIO/S3 keys this is not a concern.
- The URL host is the presigning client's endpoint → must be the public endpoint (`TD-03`); SigV4 signs the `Host`.

### @nestjs/bullmq

Used by: `TD-05` (queue integration), `TD-06` (worker process), `TD-12` (retry defaults), `TD-16` (tests).

- **Root connection from config:** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [...], useFactory: (cfg) => ({ connection: { host, port } }) })` — fits the project's `registerAs` + `ConfigType` convention (`phase-01-configuracao-base/TD-03`); host is the Compose service name, never `localhost`.
- **Queue registration:** `BullModule.registerQueue({ name: '<queue>', defaultJobOptions: {...} })`. The queue name is the injection token and the `@Processor()` argument; queues are shared across processes connected to the same Redis — the API (producer) and the `video-worker` process (consumer) both register the same name.
- **Producer:** `constructor(@InjectQueue('<queue>') private readonly queue: Queue) {}` then `queue.add(name, data, opts)`.
- **Consumer:** `@Processor('<queue>') class X extends WorkerHost { async process(job: Job): Promise<...> }` registered as a provider — only in the worker's module (`TD-06`), so the API process never consumes jobs.
- **Events:** `@OnWorkerEvent('failed' | 'completed' | 'active')` inside the `@Processor` class — the hook for marking `processing_status = failed` after the final attempt (`TD-12`).
- **Testing:** `getQueueToken('<queue>')` retrieves the `Queue` from a testing module (publisher assertions per the testing guide's `external-systems.md`).
- The "separate process" sandboxed-processor feature (`processors: [path]`) has **no DI** — not used; `TD-06` runs a full Nest application context instead.

### bullmq

Used by: `TD-05`, `TD-12`.

- **Retries:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 10000 } })` → retry delay `2^(attempt-1) * delay` (10s, 20s, …) — matches `TD-12` defaults (can be set once as `defaultJobOptions` on `registerQueue`).
- **Permanent failures:** throw `new UnrecoverableError(msg)` from the processor → job goes straight to failed, **overriding `attempts`** — the mechanism for `TD-12`'s "permanent ffprobe errors short-circuit to `failed`".
- **Stalled jobs:** jobs whose lock expires (worker crash) are moved back to wait (or failed after max stalled count) by the stalled-check timer — the "worker restart" recovery in `TD-12`.
- **Connection:** Workers require ioredis `maxRetriesPerRequest: null` (BullMQ sets it by default for Workers and warns if overridden) — do not pass a custom ioredis instance with a different value.
- **Retention:** `removeOnComplete` / `removeOnFail` job options bound Redis growth; the DB (`processing_status`, error reason) is the durable record of the outcome, so completed jobs can be removed.
