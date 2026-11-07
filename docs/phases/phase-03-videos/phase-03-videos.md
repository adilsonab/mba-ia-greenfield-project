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

### SI-03.1 — Dependências e namespaces de configuração (storage, fila, vídeos)

**Description:** Instala as bibliotecas da fase e cria os namespaces de configuração `storage`, `queue` e `videos` no padrão `registerAs` + Joi herdado, para que storage, fila e políticas de upload sejam lidos de um único lugar pela API e pelo worker.

**Technical actions:**

1. Instalar em `nestjs-project` as versões fixadas em `library-refs.md`: `@aws-sdk/client-s3@^3.1163.0`, `@aws-sdk/s3-request-presigner@^3.1163.0` (mesma versão, per `phase-03-videos/TD-02`), `@nestjs/bullmq@^11.0.5` e `bullmq@^5.81.5` (linha CommonJS, per `phase-03-videos/TD-05`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (default `http://storage:9000`), `S3_PUBLIC_ENDPOINT` (default `http://storage.localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY` (obrigatória), `S3_SECRET_KEY` (obrigatória), `S3_BUCKET` (default `streamtube`) e `S3_PRESIGN_EXPIRES_SECONDS` (default `3600`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-14`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`) e `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-05`)
4. Criar `src/config/videos.config.ts` — `registerAs('videos', ...)` lendo `VIDEO_MAX_SIZE_BYTES` (default `10737418240`), `VIDEO_UPLOAD_PART_SIZE_BYTES` (default `67108864`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`) e `VIDEO_PROCESSING_BACKOFF_MS` (default `10000`) (per `phase-03-videos/TD-10`, `phase-03-videos/TD-12`)
5. Atualizar `src/config/env.validation.ts` (Joi — `S3_ACCESS_KEY` e `S3_SECRET_KEY` obrigatórias, demais com default; `VIDEO_UPLOAD_PART_SIZE_BYTES` entre 5 MiB e 5 GiB) e `.env.example` com todas as novas chaves, usando nomes de serviço do Compose como host (per `phase-01-configuracao-base/TD-02`, `phase-01-configuracao-base/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (novas chaves) | Integration: obrigatórias, defaults e limites | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação sobe com o `.env` derivado do novo `.env.example` e a suíte existente continua verde
- Validar o ambiente sem `S3_ACCESS_KEY` resulta em erro de validação Joi citando `S3_ACCESS_KEY`
- Validar o ambiente com `VIDEO_UPLOAD_PART_SIZE_BYTES` abaixo de 5 MiB resulta em erro de validação
- Validar o ambiente sem `VIDEO_MAX_SIZE_BYTES` aplica o default `10737418240`

---

### SI-03.2 — Infra: object storage e Redis no Compose, FFmpeg na imagem de dev

**Description:** Sobe a infraestrutura real da fase no `compose.yaml` — o servidor S3-compatível e o Redis da fila — e instala o FFmpeg na imagem de desenvolvimento compartilhada por API e worker.

**Technical actions:**

1. Adicionar o serviço `storage` em `nestjs-project/compose.yaml` — imagem `cgr.dev/chainguard/minio` fixada por digest, `command: server /data --console-address :9001`, `user: "0"` (a imagem roda como `nonroot` e falha com `file access denied` no volume), volume nomeado `storage-data:/data`, portas `9000` e `9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` vindos de `S3_ACCESS_KEY`/`S3_SECRET_KEY` (per `phase-03-videos/TD-01`)
2. Declarar o alias de rede `storage.localhost` para o serviço `storage` na rede default do Compose, para que o host público das URLs pré-assinadas resolva tanto no navegador quanto dentro dos containers (per `phase-03-videos/TD-03`)
3. Adicionar o serviço `redis` (`redis:7-alpine`) com healthcheck `redis-cli ping` e fazer `nestjs-api` depender de `storage` e `redis` (per `phase-03-videos/TD-05`)
4. Atualizar `nestjs-project/Dockerfile.dev` para instalar o pacote Debian `ffmpeg` (bookworm) junto de `procps curl` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-16`)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — as variáveis `S3_ACCESS_KEY`/`S3_SECRET_KEY` precisam existir no `.env`

**Acceptance criteria:**

- `docker compose up -d` sobe `nestjs-api`, `db`, `mailpit`, `storage` e `redis`, e `docker compose ps` mostra todos em execução
- `curl http://localhost:9000/minio/health/live` no host responde `200`
- Dentro do container `nestjs-api`, `curl http://storage.localhost:9000/minio/health/live` responde `200` (alias de rede ativo)
- `docker compose exec redis redis-cli ping` responde `PONG`
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` executam com sucesso

---

### SI-03.3 — StorageModule: clientes S3, bucket, multipart e URLs pré-assinadas

**Description:** Cria o módulo que encapsula todo acesso ao object storage (API e worker), com dois clientes S3 — interno para chamadas do servidor e público apenas para assinar URLs — e prova cedo que as URLs pré-assinadas funcionam de dentro dos containers.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` — dois `S3Client` (`forcePathStyle: true`) construídos a partir de `storageConfig`: um com `S3_ENDPOINT` (operações do servidor) e outro com `S3_PUBLIC_ENDPOINT` (usado só por `getSignedUrl`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, library-refs.md → @aws-sdk/client-s3)
2. Garantir o bucket em `onModuleInit` — `HeadBucket` e, se ausente, `CreateBucket`, tolerando a corrida entre API e worker (`BucketAlreadyOwnedByYou`) (per `phase-03-videos/TD-04`)
3. Implementar as operações de multipart — `createMultipartUpload`, `presignUploadParts(key, uploadId, partNumbers, expiresIn)`, `listParts`, `completeMultipartUpload`, `headObject`, `deleteObject` — convertendo `NoSuchUpload`, `InvalidPart` e `InvalidPartOrder` em erros tipados do próprio módulo (`StorageUploadNotFoundError`, `StorageInvalidPartError`), sem conhecer exceções de domínio de vídeos (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
4. Implementar as operações de objeto — `downloadToFile(key, path)` (stream do `GetObject` para arquivo), `putObject(key, body, contentType)` e `presignGetObject(key, { downloadFileName? })` (com `ResponseContentDisposition: attachment; filename="..."` quando `downloadFileName` é informado) (per `phase-03-videos/TD-14`, library-refs.md → @aws-sdk/s3-request-presigner)
5. Criar `src/storage/storage.constants.ts` com os construtores de chave `videoOriginalKey(id)` → `videos/{id}/original` e `videoThumbnailKey(id)` → `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` (multipart via URLs pré-assinadas, MinIO real) | Integration: upload de 2 partes ≥ 5 MiB por `PUT` nas URLs públicas a partir do container, `ListParts`, `CompleteMultipartUpload`, `HeadObject`; `NoSuchUpload` vira `StorageUploadNotFoundError` | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` (leitura pré-assinada, MinIO real) | Integration: GET com `Range` responde `206`; URL de download traz `Content-Disposition: attachment` | `src/storage/storage-presign.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — `storageConfig`; SI-03.2 — serviço `storage` e alias `storage.localhost`

**Acceptance criteria:**

- Ao iniciar o módulo com o bucket inexistente, o bucket `S3_BUCKET` passa a existir no storage
- Uma URL de `UploadPart` gerada pelo serviço aponta para o host de `S3_PUBLIC_ENDPOINT` e aceita `PUT` feito de dentro do container `nestjs-api`, respondendo `200` com header `ETag`
- Completar um multipart de 2 partes produz um objeto cujo `HeadObject.ContentLength` é a soma das partes
- Um `GET` na URL de stream com `Range: bytes=0-1023` responde `206` com `Content-Range`
- Um `GET` na URL de download responde com `Content-Disposition: attachment; filename="<nome informado>"`
- Listar partes de um `uploadId` inexistente resulta em `StorageUploadNotFoundError`

---

### SI-03.4 — Entidade Video e migration CreateVideos

**Description:** Cria a tabela `videos` ligada ao canal, com os dois eixos de status, o identificador público e as colunas de metadados, conforme `### Data Model → Video`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com todas as colunas de `### Data Model → Video` (nomes snake_case verbatim), os enums `VideoStatus` (`'draft'`) e `VideoProcessingStatus` (`'awaiting_upload'`, `'processing'`, `'ready'`, `'failed'`) e a relação `@ManyToOne(() => Channel)` via `channel_id` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-13`, validation.md AMB-1)
2. Criar `src/common/transformers/bigint-number.transformer.ts` e aplicá-lo a `declared_size_bytes`, `size_bytes` e `bitrate`, mapeando o `string` devolvido pelo `pg` para `number`
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate` — tabela `videos`, tipos `videos_status_enum` e `videos_processing_status_enum`, FK para `channels(id)`, índice único em `public_id` e índice em `channel_id`; `down()` remove tabela e tipos (per `.claude/rules/typeorm-migrations.md`)
4. Atualizar `src/database/migrations.integration-spec.ts` — incluir `videos` em `MANAGED_TABLES`, os dois novos enums em `MANAGED_TYPES` e a nova migration na lista executada
5. Atualizar `cleanAllTables` em `src/test/create-test-data-source.ts` para apagar `videos` antes de `channels`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`draft` / `awaiting_upload`), `public_id` único, FK para `channels`, `bigint` lido como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations (com `CreateVideos`) | Integration: aplica e reverte as 3 migrations | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — dependências instaladas; nenhuma dependência de storage

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e os tipos `videos_status_enum` e `videos_processing_status_enum`
- `npm run migration:revert` remove a tabela e os dois tipos, e um novo `migration:run` funciona em seguida
- Inserir um vídeo sem `status` e `processing_status` persiste `draft` e `awaiting_upload`
- Inserir dois vídeos com o mesmo `public_id` viola a constraint única
- Inserir um vídeo com `channel_id` inexistente viola a FK
- Um vídeo com `declared_size_bytes = 10737418240` é lido de volta como o número `10737418240`

---

### SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho e plano de upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-start-upload.plan.md`
**Authorization:** Authenticated — o vídeo é criado no canal do próprio usuário (per `### Authorization Matrix`)

**Description:** Ao iniciar o upload, cria o vídeo como rascunho no canal do usuário, abre o multipart no storage e devolve as URLs pré-assinadas de cada parte — nenhum byte do arquivo passa pela API.

**Technical actions:**

1. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções do `### Error Catalog`: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoUploadNotInProgressException` (`VIDEO_UPLOAD_NOT_IN_PROGRESS`, 409), `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 400), `UploadExpiredException` (`UPLOAD_EXPIRED`, 410), `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422) e `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) (per `phase-02-auth/TD-07`)
2. Adicionar `findByUserId(userId)` ao `ChannelsService` e exportá-lo pelo `ChannelsModule` — o canal continua sendo responsabilidade do módulo de canais
3. Criar `src/videos/dto/start-upload.dto.ts` (`file_name`, `content_type`, `size_bytes`, `title?` com as regras de `#### Validation Rules — Upload Start and Completion`), os DTOs de resposta com `@nestjs/swagger` e `src/videos/public-id.util.ts` (`randomBytes(8).toString('base64url')` → 11 caracteres) (per `phase-03-videos/TD-10`, `phase-03-videos/TD-13`, `openapi-docs-nestjs/TD-01`)
4. Criar `src/videos/videos.service.ts` com `startUpload(userId, dto)` — título padrão a partir do nome do arquivo sem extensão (validation.md AMB-2); insere o vídeo (`draft`/`awaiting_upload`) repetindo com novo `public_id` em violação de unicidade; abre o multipart em `videoOriginalKey(id)`, grava `upload_id` e assina `ceil(size_bytes / part_size)` partes; se o storage falhar, remove a linha criada (compensação) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`, `phase-03-videos/TD-11`, `phase-03-videos/TD-13`)
5. Criar `src/videos/videos.controller.ts` (`POST /videos` → `201`, `@CurrentUser()`) e `src/videos/videos.module.ts` (TypeORM `Video`, `ChannelsModule`, `StorageModule`), registrando `VideosModule` no `AppModule` (per `### API Contracts → POST /videos`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.startUpload` | Unit: título padrão, cálculo de `part_count`, retry em colisão de `public_id`, compensação quando o storage falha (mocks) | `src/videos/videos.service.spec.ts` |
| `VideosService.startUpload` | Integration: linha persistida no canal do usuário com `upload_id`, multipart real aberto no MinIO | `src/videos/videos.service.integration-spec.ts` |
| `generatePublicId` | Unit: 11 caracteres no alfabeto base64url | `src/videos/public-id.util.spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 — `StorageService`; SI-03.4 — entidade `Video`

**Acceptance criteria:**

- `POST /videos` com `{ file_name: "aula.mp4", content_type: "video/mp4", size_bytes: 134217728 }` retorna `201` com `status: "draft"`, `processing_status: "awaiting_upload"`, `title: "aula"`, `public_id` de 11 caracteres e `upload.part_count: 2`
- `POST /videos` com `title: "Minha aula"` retorna `201` com `title: "Minha aula"`
- `POST /videos` com `size_bytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `content_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem access token retorna `401`
- Após um `POST /videos` bem-sucedido, a tabela `videos` tem uma linha no canal do usuário com `upload_id` preenchido e `storage_key = videos/{id}/original`
- Cada `upload.parts[].url` aceita `PUT` com os bytes da parte direto no storage, sem passar pela API

---

### SI-03.6 — Endpoint GET /videos/:publicId/upload (retomada do upload)

**Route:** GET /videos/:publicId/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-resume.plan.md`
**Authorization:** Owner — não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)

**Description:** Permite retomar um upload interrompido: informa as partes já armazenadas e emite URLs novas apenas para as que faltam, cumprindo o "retomar em caso de falha de conexão" do plano do projeto.

**Technical actions:**

1. Adicionar ao `VideosService` o método `findOwnedByPublicId(userId, publicId)` — busca pelo `public_id` junto do canal e lança `VideoNotFoundException` tanto para inexistente quanto para não-dono; reutilizado pelos demais endpoints `/videos/:publicId…` (per `phase-03-videos/TD-15`)
2. Adicionar `resumeUpload(userId, publicId)` — exige `processing_status = 'awaiting_upload'` (`VideoUploadNotInProgressException`), chama `listParts`, calcula as partes faltantes do plano e assina somente essas; `StorageUploadNotFoundError` vira `UploadExpiredException` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
3. Criar o DTO de resposta (`public_id`, `part_size_bytes`, `part_count`, `expires_at`, `uploaded_parts`, `parts`) com `@nestjs/swagger` e expor `GET /videos/:publicId/upload` → `200` no `VideosController` (per `### API Contracts → GET /videos/:publicId/upload`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.resumeUpload` / `findOwnedByPublicId` | Unit: não-dono → `VideoNotFoundException`, status inválido, cálculo das partes faltantes, upload expirado (mocks) | `src/videos/videos.service.spec.ts` |
| `VideosService.resumeUpload` | Integration: com 1 de 2 partes enviada ao MinIO real, devolve 1 em `uploaded_parts` e 1 URL em `parts` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — vídeo em `awaiting_upload` com `upload_id`

**Acceptance criteria:**

- Com 1 das 2 partes já enviada, `GET /videos/:publicId/upload` retorna `200` com `uploaded_parts` contendo `part_number: 1` e `parts` contendo apenas `part_number: 2`
- `GET /videos/:publicId/upload` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:publicId/upload` com um `publicId` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:publicId/upload` de um vídeo já em `processing` retorna `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`
- `GET /videos/:publicId/upload` cujo multipart não existe mais no storage retorna `410` com `error: "UPLOAD_EXPIRED"`

---

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete (conclusão e enfileiramento)

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner — não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)

**Description:** Conclui o multipart, confere o objeto armazenado e publica o job `video.process`, disparando o processamento automático assim que o upload termina.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` no `AppModule` com a conexão de `queueConfig` (host = nome do serviço do Compose) (per `phase-03-videos/TD-05`, library-refs.md → @nestjs/bullmq)
2. Criar `src/video-processing/video-processing.constants.ts` (fila `video-processing`, job `video.process`, tipo `VideoProcessJobData { videoId }`) e `src/video-processing/video-processing-queue.module.ts` — `BullModule.registerQueue` com `defaultJobOptions` (`attempts`, backoff exponencial, `removeOnComplete: true`, `removeOnFail: false` a partir de `videosConfig`) e o produtor `VideoProcessingProducer.enqueue(videoId)` com `jobId = videoId` (per `### Events/Messages → video.process`, `phase-03-videos/TD-12`)
3. Criar `src/videos/dto/complete-upload.dto.ts` (`parts[]` com `part_number` e `etag`, regras de `#### Validation Rules — Upload Start and Completion`) e o DTO de resposta `202` com `@nestjs/swagger`
4. Adicionar `completeUpload(userId, publicId, dto)` ao `VideosService` — dono + `awaiting_upload`; `parts` precisa cobrir `1..part_count` (`UploadIncompleteException`); `completeMultipartUpload` (`StorageInvalidPartError` → `UploadIncompleteException`, `StorageUploadNotFoundError` → `UploadExpiredException`); `headObject` ≠ `declared_size_bytes` → apaga o objeto, marca `failed` com `processing_error` e lança `UploadSizeMismatchException`; senão `enqueue` e grava `size_bytes`, `upload_id = null`, `processing_status = 'processing'`, nessa ordem (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`, `### API Contracts → POST /videos/:publicId/upload/complete`)
5. Expor `POST /videos/:publicId/upload/complete` → `202` no `VideosController`, importando `VideoProcessingQueueModule` no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: partes faltando, ETag inválido, upload expirado, tamanho divergente (apaga + `failed`), ordem enqueue → update (mocks) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: multipart real concluído no MinIO, job `video.process` presente na fila Redis real com `jobId` = id do vídeo e status `processing` no banco | `src/videos/videos.service.integration-spec.ts` |
| `VideoProcessingQueueModule` | Unit: compilation test | `src/video-processing/video-processing-queue.module.spec.ts` |

**Dependencies:** SI-03.5 — vídeo em `awaiting_upload`; SI-03.6 — `findOwnedByPublicId`; SI-03.2 — serviço `redis`

**Acceptance criteria:**

- `POST /videos/:publicId/upload/complete` com todas as partes e ETags corretos retorna `202` com `processing_status: "processing"`
- Após a conclusão, a fila `video-processing` contém um job `video.process` com payload `{ videoId }` e `jobId` igual ao id do vídeo
- Após a conclusão, o vídeo tem `size_bytes` igual ao tamanho do objeto e `upload_id` nulo
- `POST /videos/:publicId/upload/complete` sem a parte 2 do plano retorna `400` com `error: "UPLOAD_INCOMPLETE"`
- `POST /videos/:publicId/upload/complete` com um ETag adulterado retorna `400` com `error: "UPLOAD_INCOMPLETE"`
- `POST /videos/:publicId/upload/complete` com objeto de tamanho diferente do declarado retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"`, remove o objeto e deixa o vídeo `failed` com `processing_error`
- Repetir `POST /videos/:publicId/upload/complete` num vídeo já em `processing` retorna `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`
- `POST /videos/:publicId/upload/complete` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.8 — MediaModule: extração de metadados (ffprobe) e thumbnail (ffmpeg)

**Description:** Cria o invólucro tipado sobre os binários do FFmpeg usado pelo worker — metadados via `ffprobe` e um frame JPEG via `ffmpeg` — chamados com `execFile` e argumentos em array, sem shell.

**Technical actions:**

1. Criar `src/media/media.types.ts` — `ProbeResult` com `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nulo sem stream de áudio), `bitrate`, `container_format` e `raw` (saída completa do ffprobe), mais o erro `UnsupportedMediaError` (per validation.md AMB-1)
2. Criar `src/media/media-probe.service.ts` — `probe(filePath)` executa `ffprobe -v error -print_format json -show_format -show_streams` via `child_process.execFile` (promisificado) e mapeia o primeiro stream de vídeo/áudio; arquivo ilegível ou sem stream de vídeo lança `UnsupportedMediaError` (per `phase-03-videos/TD-07`)
3. Criar `src/media/thumbnail.service.ts` — `extractFrame(inputPath, outputPath, durationSeconds)` executa `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale='min(1280,iw)':-2 <output>.jpg` com `t` = 10% da duração (`0` quando menor que 1s) (per `phase-03-videos/TD-07`)
4. Criar `src/media/media.module.ts` exportando os dois serviços
5. Criar `src/test/video-fixture.ts` — gera vídeos de teste em diretório temporário com `ffmpeg -f lavfi` (`testsrc` + `sine`), com opção de tamanho mínimo (para multipart de ≥ 2 partes) e sem áudio, além de um arquivo corrompido; usado pelos testes de integração e e2e (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` (mapeamento) | Unit: mapeia um JSON de ffprobe de exemplo, incluindo vídeo sem áudio (`audio_codec: null`) | `src/media/media-probe.service.spec.ts` |
| `MediaProbeService` (ffprobe real) | Integration: fixture gerado → duração, dimensões e codecs corretos; arquivo corrompido → `UnsupportedMediaError` | `src/media/media-probe.service.integration-spec.ts` |
| `ThumbnailService` (ffmpeg real) | Integration: gera JPEG válido com largura ≤ 1280 para um fixture 1920×1080, e também para um clipe menor que 1s | `src/media/thumbnail.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — FFmpeg instalado na imagem

**Acceptance criteria:**

- Fazer o probe de um fixture de 3s em 1920×1080 com H.264 + AAC devolve `duration_seconds ≈ 3`, `width: 1920`, `height: 1080`, `video_codec: "h264"` e `audio_codec: "aac"`
- Fazer o probe de um fixture sem áudio devolve `audio_codec: null`
- Fazer o probe de um arquivo corrompido lança `UnsupportedMediaError`
- Extrair o frame de um fixture 1920×1080 produz um JPEG de 1280px de largura
- Extrair o frame de um clipe de 0,5s produz um JPEG (frame em `0s`)

---

### SI-03.9 — Video worker: entrypoint, processor da fila e serviço no Compose

**Description:** Entrega o worker de vídeo como processo separado — mesma base de código, sem servidor HTTP — que consome `video.process`, extrai metadados, gera a thumbnail e fecha o ciclo de status no banco.

**Technical actions:**

1. Criar `src/worker.module.ts` (ConfigModule com os mesmos `registerAs` e validação Joi, `TypeOrmModule.forRootAsync` via `databaseConfig`, `BullModule.forRootAsync`, `VideoProcessingQueueModule`, `StorageModule`, `MediaModule`, entidade `Video` — sem controllers, mail ou throttler) e `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` e `enableShutdownHooks()` (per `phase-03-videos/TD-06`, `phase-01-configuracao-base/TD-04`)
2. Criar `src/video-processing/video-processing.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`, com os passos 1–6 de `### Events/Messages → Processing steps`: idempotência (vídeo ausente ou já `ready` encerra sem mudanças), marca `processing`, baixa o original para um arquivo temporário, `probe` (`UnsupportedMediaError` → `UnrecoverableError`), thumbnail em `videoThumbnailKey(id)`, grava metadados + `thumbnail_key` + `ready`, e apaga os temporários em `finally` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-12`, library-refs.md → bullmq)
3. Adicionar o handler `@OnWorkerEvent('failed')` — marca `processing_status = 'failed'` com `processing_error` (mensagens de `### Error Catalog → Worker-side failures`) somente quando o job não será mais tentado (`UnrecoverableError` ou `attemptsMade >= attempts`) (per `phase-03-videos/TD-12`)
4. Adicionar os scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`) ao `package.json`
5. Adicionar o serviço `video-worker` ao `compose.yaml` — mesmo `build`/`Dockerfile.dev` e volume do `nestjs-api`, `command: npm run start:worker:dev`, `depends_on` em `db` (healthy), `storage` e `redis` (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: vídeo ausente/`ready` não faz nada, erro de mídia vira `UnrecoverableError`, temporários removidos em falha, handler `failed` só marca na última tentativa (mocks) | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration: com fixture real no MinIO e Postgres reais, processar o job deixa o vídeo `ready` com metadados preenchidos e o objeto `videos/{id}/thumbnail.jpg` existente | `src/video-processing/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilation test (sem controllers registrados) | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.7 — fila e produtor; SI-03.8 — `MediaModule`

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker` junto do backend, e `docker compose logs video-worker` mostra o worker conectado à fila `video-processing` sem expor porta HTTP
- Um job `video.process` de um vídeo válido leva o vídeo a `processing_status: "ready"` com `duration_seconds`, `width`, `height`, `video_codec`, `container_format`, `size_bytes` e `metadata` preenchidos
- Após o processamento, o objeto `videos/{id}/thumbnail.jpg` existe no storage e `thumbnail_key` aponta para ele
- Um job de um arquivo que não é vídeo deixa o vídeo `failed` com `processing_error` iniciando por `"Unsupported or corrupt media:"`, sem novas tentativas
- Um erro transitório repetido deixa o vídeo `processing` nas tentativas intermediárias e `failed` com `"Processing failed after 3 attempts:"` após a última
- Reentregar o job de um vídeo já `ready` não altera a linha nem a thumbnail

---

### SI-03.10 — Endpoint GET /videos/:publicId (detalhe, status e metadados)

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-detail.plan.md`
**Authorization:** Owner — não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)

**Description:** Expõe ao dono o estado do vídeo — ciclo de status, erro de processamento, metadados extraídos e a URL da thumbnail — que é o ponto de observação do processamento assíncrono.

**Technical actions:**

1. Criar `src/videos/dto/video-detail.response.ts` com os campos de `### API Contracts → GET /videos/:publicId` e um mapeador que nunca expõe `id`, `channel_id`, `storage_key`, `thumbnail_key`, `upload_id`, `declared_size_bytes` nem `metadata` (per `phase-03-videos/TD-11`, validation.md AMB-1)
2. Adicionar `getDetail(userId, publicId)` ao `VideosService` — reutiliza `findOwnedByPublicId` e preenche `thumbnail_url` com `presignGetObject(thumbnail_key)` apenas quando há thumbnail (per `phase-03-videos/TD-14`)
3. Expor `GET /videos/:publicId` → `200` no `VideosController` com decorators `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Mapeador de `VideoDetailResponse` | Unit: campos internos omitidos, `thumbnail_url` nulo sem thumbnail | `src/videos/dto/video-detail.response.spec.ts` |
| `VideosService.getDetail` | Unit: delega a posse a `findOwnedByPublicId` e só assina a thumbnail quando existe (mocks) | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedByPublicId`; SI-03.3 — `presignGetObject`

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo recém-criado retorna `200` com `status: "draft"`, `processing_status: "awaiting_upload"` e `thumbnail_url: null`
- `GET /videos/:publicId` de um vídeo processado retorna `200` com `processing_status: "ready"`, metadados preenchidos e `thumbnail_url` acessível com `200` e `Content-Type: image/jpeg`
- A resposta de `GET /videos/:publicId` não contém `id`, `channel_id`, `storage_key`, `thumbnail_key`, `upload_id`, `declared_size_bytes` nem `metadata`
- `GET /videos/:publicId` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.11 — Endpoint GET /videos/:publicId/stream (reprodução via streaming)

**Route:** GET /videos/:publicId/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Owner — não-dono recebe `404 VIDEO_NOT_FOUND`; apenas `ready` (per `### Authorization Matrix`)

**Description:** Devolve uma URL de curta duração que o player carrega direto do storage, que responde `Range` com `206 Partial Content` — a reprodução começa sem baixar o arquivo inteiro e sem tráfego de vídeo pela API.

**Technical actions:**

1. Adicionar `getStreamUrl(userId, publicId)` ao `VideosService` — reutiliza `findOwnedByPublicId`, exige `processing_status = 'ready'` (`VideoNotReadyException`) e assina `GetObject` de `storage_key` com o cliente público por `S3_PRESIGN_EXPIRES_SECONDS` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`)
2. Criar o DTO de resposta compartilhado `src/videos/dto/signed-url.response.ts` (`url`, `expires_at`) com `@nestjs/swagger`
3. Expor `GET /videos/:publicId/stream` → `200` no `VideosController` (per `### API Contracts → GET /videos/:publicId/stream`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` | Unit: vídeo não `ready` → `VideoNotReadyException`; `expires_at` coerente com a expiração configurada (mocks) | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.10 — vídeo `ready` observável; SI-03.3 — `presignGetObject`

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `200` com `url` e `expires_at` cerca de 1h no futuro
- Um `GET` na `url` com `Range: bytes=0-1023` responde `206` com exatamente 1024 bytes e `Content-Range: bytes 0-1023/<size_bytes>`
- `GET /videos/:publicId/stream` de um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:publicId/stream` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.12 — Endpoint GET /videos/:publicId/download (download do vídeo)

**Route:** GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Owner — não-dono recebe `404 VIDEO_NOT_FOUND`; apenas `ready` (per `### Authorization Matrix`)

**Description:** Devolve uma URL de curta duração que baixa o arquivo original como anexo, com o nome de arquivo enviado pelo usuário.

**Technical actions:**

1. Adicionar `getDownloadUrl(userId, publicId)` ao `VideosService` — reutiliza `findOwnedByPublicId`, exige `ready` (`VideoNotReadyException`) e assina `GetObject` com `downloadFileName = original_file_name` (gera `ResponseContentDisposition: attachment; filename="..."`, assinado na própria URL) (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`, library-refs.md → @aws-sdk/s3-request-presigner)
2. Expor `GET /videos/:publicId/download` → `200` no `VideosController`, reutilizando `SignedUrlResponse` (per `### API Contracts → GET /videos/:publicId/download`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Unit: vídeo não `ready` → `VideoNotReadyException`; `downloadFileName` repassado ao storage (mocks) | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.11 — `SignedUrlResponse` e o padrão de URL assinada

**Acceptance criteria:**

- `GET /videos/:publicId/download` de um vídeo `ready` retorna `200` com `url` e `expires_at`
- Um `GET` na `url` responde `200` com `Content-Disposition: attachment; filename="<original_file_name>"` e o arquivo completo (`Content-Length` igual a `size_bytes`)
- `GET /videos/:publicId/download` de um vídeo em `awaiting_upload` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:publicId/download` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.13 — Teste e2e do pipeline completo com worker real

**Description:** Prova o fluxo entregue de ponta a ponta com a infraestrutura real do Compose — upload multipart direto ao storage, conclusão, fila, `video-worker`, banco e streaming — exercitando o ciclo `awaiting_upload → processing → ready | failed`.

**Technical actions:**

1. Criar `test/helpers/auth.helper.ts` — cadastra, confirma e autentica um usuário de teste e devolve o `access_token` (reutilizável pelos e2e de vídeos)
2. Criar `test/helpers/video-upload.helper.ts` — fatia um arquivo conforme `upload.part_size_bytes`, envia cada parte por `PUT` nas URLs pré-assinadas (host `storage.localhost`, de dentro do container) e devolve os pares `{ part_number, etag }`
3. Criar `test/videos-pipeline.e2e-spec.ts` — caminho feliz: fixture de `src/test/video-fixture.ts` grande o bastante para 2 partes (com `VIDEO_UPLOAD_PART_SIZE_BYTES` mínimo de teste), `POST /videos` → upload das partes → `POST .../upload/complete` → polling de `GET /videos/:publicId` até `ready` (timeout de 90s) → `GET .../stream` + `Range` → `206` → `GET .../download` → `attachment` (per `phase-03-videos/TD-16`)
4. Cobrir no mesmo arquivo a retomada (envia a parte 1, consulta `GET .../upload`, envia o restante, conclui) e a falha (bytes que não são vídeo declarados como `video/mp4` → polling até `failed` com `processing_error`)
5. Ajustar `test/jest-e2e.json` (`testTimeout` suficiente para o polling) e documentar no topo do arquivo a pré-condição de que o serviço `video-worker` esteja rodando (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline upload → fila → worker → status → streaming/download | E2E (supertest + storage/Redis/worker reais): caminho feliz, retomada e falha de mídia | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.9 — `video-worker` rodando; SI-03.11 e SI-03.12 — endpoints de stream e download

**Acceptance criteria:**

- Um vídeo válido enviado em 2 partes direto ao storage chega a `processing_status: "ready"` dentro do timeout, com duração e dimensões do fixture e `thumbnail_url` acessível
- Durante o pipeline, `GET /videos/:publicId` observa `awaiting_upload` antes da conclusão e `processing` ou `ready` depois dela
- A URL de stream do vídeo processado responde `206` a um pedido com `Range`
- A URL de download do vídeo processado responde com `Content-Disposition: attachment`
- Um upload retomado após enviar só a parte 1 é concluído e processado normalmente
- Um arquivo que não é vídeo termina em `processing_status: "failed"` com `processing_error` preenchido
- Nenhuma requisição do teste envia bytes de vídeo para a API — os bytes vão apenas para as URLs do storage

---

### SI-03.14 — Documentação: CLAUDE.md, OpenAPI, diagrama de arquitetura e README

**Description:** Alinha a documentação de IA e do projeto ao estado real do código após a fase — módulo de vídeos, endpoints, fila/worker e storage — para que nenhum documento cite arquivos ou comportamentos inexistentes.

**Technical actions:**

1. Atualizar o `CLAUDE.md` da raiz — seção "Videos" (módulo `videos`, os 6 endpoints, os dois eixos de status, fila `video-processing` + serviço `video-worker`, storage S3-compatível com bucket único e chaves por vídeo) e a lista de containers, trocando a fila "TBD" por BullMQ + Redis (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-11`)
2. Atualizar `nestjs-project/CLAUDE.md` — serviços `storage`, `redis` e `video-worker` com portas e checagens de prontidão, scripts `start:worker`/`start:worker:dev`, FFmpeg na imagem, o alias `storage.localhost` como exceção documentada à regra de nome de serviço (só para URLs pré-assinadas) e a pré-condição do worker para os e2e (per `phase-03-videos/TD-03`, `phase-03-videos/TD-16`)
3. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export`, contendo os 6 endpoints de vídeos (per `openapi-docs-nestjs/TD-02`)
4. Atualizar `docs/diagrams/software-arch.mermaid` — `ContainerQueue` de "TBD" para "BullMQ (Redis)" e o storage como "S3 / MinIO"
5. Atualizar o `README.md` — Fase 03 como concluída, novos serviços na tabela "Serviços disponíveis" e a lista de endpoints de vídeos

**Tests:** _(empty — documentation only; consistency verified by the acceptance criteria)_

**Dependencies:** SI-03.13 — documenta o comportamento já implementado e testado

**Acceptance criteria:**

- Todo arquivo, script, serviço do Compose e endpoint citado nas seções de vídeos dos dois `CLAUDE.md` existe no repositório e responde como descrito
- `nestjs-project/openapi.json` contém os paths `/videos`, `/videos/{publicId}`, `/videos/{publicId}/upload`, `/videos/{publicId}/upload/complete`, `/videos/{publicId}/stream` e `/videos/{publicId}/download`
- O diagrama de arquitetura não contém mais "TBD" para a fila
- O README lista `storage`, `redis` e `video-worker` com suas portas e marca a Fase 03 como concluída

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

#### GET /videos/:publicId/download (SI-03.12)

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

## Dependency Map

```
SI-03.1 (root — dependências e configuração)
├── SI-03.2 — depends on SI-03.1 (variáveis do storage no .env)
│   ├── SI-03.3 — depends on SI-03.1 + SI-03.2 (storageConfig + serviço storage/alias)
│   └── SI-03.8 — depends on SI-03.2 (FFmpeg na imagem)
└── SI-03.4 — depends on SI-03.1 (entidade + migration; independe do storage)

SI-03.3 + SI-03.4
└── SI-03.5 — POST /videos (StorageService + entidade Video)
    └── SI-03.6 — GET /videos/:publicId/upload (vídeo em awaiting_upload; cria findOwnedByPublicId)
        ├── SI-03.7 — POST .../upload/complete (+ SI-03.2: serviço redis)
        │   └── SI-03.9 — video worker (+ SI-03.8: MediaModule)
        └── SI-03.10 — GET /videos/:publicId (+ SI-03.3: presignGetObject)
            └── SI-03.11 — GET .../stream
                └── SI-03.12 — GET .../download (reusa SignedUrlResponse)

SI-03.9 + SI-03.11 + SI-03.12
└── SI-03.13 — e2e do pipeline completo (worker real)
    └── SI-03.14 — documentação (CLAUDE.md, OpenAPI, diagrama, README)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.4 (parallel) → SI-03.3, SI-03.8 (parallel) → SI-03.5 → SI-03.6 → SI-03.7, SI-03.10 (parallel) → SI-03.9, SI-03.11 (parallel) → SI-03.12 → SI-03.13 → SI-03.14

---

## Deliverables

- [ ] SI-03.1 — Dependências e namespaces de configuração (storage, fila, vídeos)
- [ ] SI-03.2 — Infra: object storage e Redis no Compose, FFmpeg na imagem de dev
- [ ] SI-03.3 — StorageModule: clientes S3, bucket, multipart e URLs pré-assinadas
- [ ] SI-03.4 — Entidade Video e migration CreateVideos
- [ ] SI-03.5 — Endpoint POST /videos (pré-cadastro do rascunho e plano de upload)
- [ ] SI-03.6 — Endpoint GET /videos/:publicId/upload (retomada do upload)
- [ ] SI-03.7 — Endpoint POST /videos/:publicId/upload/complete (conclusão e enfileiramento)
- [ ] SI-03.8 — MediaModule: extração de metadados (ffprobe) e thumbnail (ffmpeg)
- [ ] SI-03.9 — Video worker: entrypoint, processor da fila e serviço no Compose
- [ ] SI-03.10 — Endpoint GET /videos/:publicId (detalhe, status e metadados)
- [ ] SI-03.11 — Endpoint GET /videos/:publicId/stream (reprodução via streaming)
- [ ] SI-03.12 — Endpoint GET /videos/:publicId/download (download do vídeo)
- [ ] SI-03.13 — Teste e2e do pipeline completo com worker real
- [ ] SI-03.14 — Documentação: CLAUDE.md, OpenAPI, diagrama de arquitetura e README

**Phase deliverables** _(from `docs/project-plan.md` → Fase 03)_:

- [ ] Upload de até 10GB funcional — multipart direto ao storage via URLs pré-assinadas, sem bytes passando pela API
- [ ] Processamento automático do vídeo — duração, metadados e thumbnail extraídos pelo `video-worker` após o upload
- [ ] Streaming funcionando — URL pré-assinada atendida com `206 Partial Content`
- [ ] URLs únicas geradas — `public_id` de 11 caracteres, único por constraint no banco

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test`)
- [ ] E2E tests pass, with `video-worker` running (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
