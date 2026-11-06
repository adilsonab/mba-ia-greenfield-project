# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/14 completed

### SI-03.1 — Dependências e namespaces de configuração (storage, fila, vídeos)
- **Status:** completed
- **Tests:** 9 passing (`src/config/env.validation.integration-spec.ts`); AC #1 verified by `test/app.e2e-spec.ts` booting the full `AppModule` with the new `.env` (1 passing); `tsc --noEmit` exit 0
- **Observations:**
  - Installed `@aws-sdk/client-s3@3.1163.0`, `@aws-sdk/s3-request-presigner@3.1163.0`, `@nestjs/bullmq@11.0.5`, `bullmq@5.81.5` — matches `library-refs.md`.
  - Registered `storageConfig`, `queueConfig` and `videosConfig` in the `ConfigModule.forRoot` `load` array of `AppModule` so the namespaces are injectable via `ConfigType` in later SIs.
  - `test/app.e2e-spec.ts` `beforeAll` (full `AppModule` compile + DB connect + mailer) runs close to Jest's default 5 s hook timeout on a cold cache: one test-runner run timed out, two re-runs passed (also with the default timeout). Pre-existing flakiness risk, not caused by this SI; SI-03.13 already plans a `testTimeout` in `test/jest-e2e.json`.
  - `.env` (local, git-ignored) received the same new keys as `.env.example`.

### SI-03.2 — Infra: object storage e Redis no Compose, FFmpeg na imagem de dev
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — StorageModule: clientes S3, bucket, multipart e URLs pré-assinadas
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Entidade Video e migration CreateVideos
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho e plano de upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint GET /videos/:publicId/upload (retomada do upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete (conclusão e enfileiramento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — MediaModule: extração de metadados (ffprobe) e thumbnail (ffmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video worker: entrypoint, processor da fila e serviço no Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Endpoint GET /videos/:publicId (detalhe, status e metadados)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint GET /videos/:publicId/stream (reprodução via streaming)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoint GET /videos/:publicId/download (download do vídeo)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Teste e2e do pipeline completo com worker real
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Documentação: CLAUDE.md, OpenAPI, diagrama de arquitetura e README
- **Status:** pending
- **Tests:** —
- **Observations:** none
