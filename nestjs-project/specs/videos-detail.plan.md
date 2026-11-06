---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-detail.e2e-spec.ts
---

# GET /videos/:publicId — Test Plan

## Application Overview

`GET /videos/:publicId` devolve ao dono o estado do vídeo: título, os dois eixos de status (`status` e `processing_status`), `processing_error`, os metadados extraídos pelo worker (duração, dimensões, codecs, bitrate, formato, tamanho) e uma `thumbnail_url` pré-assinada quando a thumbnail existe. Campos internos (`id`, `channel_id`, `storage_key`, `thumbnail_key`, `upload_id`, `declared_size_bytes`, `metadata`) nunca são expostos. Vídeo de outro usuário responde `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Consultar o detalhe do próprio vídeo

**Setup:** `beforeAll` cria o app com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts`; `beforeEach` executa `cleanAllTables` e limpa o `ThrottlerStorage`; dois usuários são cadastrados, confirmados e autenticados (dono e não-dono). Para o cenário de vídeo processado, o estado `ready` é preparado diretamente (sem depender do worker): `PutObject` de um JPEG em `videos/{id}/thumbnail.jpg` e update da linha com `processing_status = 'ready'`, `thumbnail_key` e os metadados. Storage (MinIO) e Postgres reais do Compose.

#### 1.1. detail-video-recem-criado

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos com o token do dono (`file_name: "aula.mp4"`, `content_type: "video/mp4"`, `size_bytes: 1048576`)
    - expect: status `201`
  2. GET /videos/:publicId com o token do dono
    - expect: status `200`
    - expect: `status` = `"draft"`, `processing_status` = `"awaiting_upload"` e `processing_error` = `null`
    - expect: `thumbnail_url` = `null` e os campos de metadados (`duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `container_format`, `size_bytes`) são `null`
    - expect: `title` = `"aula"`, `original_file_name` = `"aula.mp4"`, `content_type` = `"video/mp4"`, `created_at` e `updated_at` em ISO-8601

#### 1.2. detail-video-processado-com-thumbnail

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Criar o vídeo via POST /videos e preparar o estado `ready` (thumbnail no storage + metadados no banco: `duration_seconds: 3`, `width: 1920`, `height: 1080`, `video_codec: "h264"`, `audio_codec: "aac"`, `container_format: "mov,mp4,m4a,3gp,3g2,mj2"`, `size_bytes: 1048576`)
    - expect: a linha fica `ready` com `thumbnail_key` preenchido
  2. GET /videos/:publicId com o token do dono
    - expect: status `200`
    - expect: `processing_status` = `"ready"` e os metadados iguais aos preparados
    - expect: `thumbnail_url` é uma URL não vazia
  3. `GET` em `thumbnail_url` (de dentro do container)
    - expect: o storage responde `200` com `Content-Type: image/jpeg`

#### 1.3. detail-nao-expoe-campos-internos

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/:publicId com o token do dono, para o vídeo `ready` do cenário 1.2
    - expect: o body não contém as chaves `id`, `channel_id`, `storage_key`, `thumbnail_key`, `upload_id`, `declared_size_bytes` nem `metadata`

### 2. Proteger o detalhe de não-donos

**Setup:** mesmo do grupo 1.

#### 2.1. detail-video-de-outro-usuario-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/:publicId com o token do não-dono, usando o `public_id` do vídeo do dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
