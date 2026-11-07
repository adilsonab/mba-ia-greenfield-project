---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete — Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` conclui o multipart upload de um vídeo do próprio usuário em `awaiting_upload`: valida que a lista de partes cobre todo o plano, chama `CompleteMultipartUpload` no storage, confere o tamanho real do objeto com `HeadObject` e, se tudo confere, publica o job `video.process` na fila `video-processing` e move o vídeo para `processing_status: "processing"`, respondendo `202`. Partes faltando ou ETags inválidos respondem `400 UPLOAD_INCOMPLETE`; tamanho real diferente do declarado responde `422 UPLOAD_SIZE_MISMATCH` (o objeto é apagado e o vídeo vira `failed`); repetir a conclusão responde `409 VIDEO_UPLOAD_NOT_IN_PROGRESS`; vídeo de outro usuário responde `404 VIDEO_NOT_FOUND`. A presença do job na fila com `jobId` = id do vídeo é verificada pelo teste de integração do SI (o `video-worker` em execução pode consumir o job antes de uma asserção HTTP).

## Test Scenarios

### 1. Concluir o upload e iniciar o processamento

**Setup:** `beforeAll` cria o app com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts`; `beforeEach` executa `cleanAllTables` e limpa o `ThrottlerStorage`; dois usuários são cadastrados, confirmados e autenticados (dono e não-dono). O dono inicia um upload via `POST /videos` e envia as partes direto nas URLs pré-assinadas (`PUT`, guardando os `ETag`). Storage (MinIO), Redis e Postgres reais do Compose.

#### 1.1. complete-conclui-e-move-para-processing

**Covers AC:** #1, #3
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Iniciar upload de 2 partes (`size_bytes` = `part_size_bytes + 1048576`) e enviar as 2 partes com os bytes exatos do plano
    - expect: cada `PUT` responde `200` com `ETag`
  2. POST /videos/:publicId/upload/complete com o token do dono e body `{ "parts": [{ "part_number": 1, "etag": <ETag1> }, { "part_number": 2, "etag": <ETag2> }] }`
    - expect: status `202`
    - expect: body `{ public_id: <publicId>, processing_status: "processing" }`
  3. Consultar a linha do vídeo no banco
    - expect: `size_bytes` = `declared_size_bytes`
    - expect: `upload_id` é nulo
    - expect: `processing_status` é `processing` ou já um estado posterior do worker (`ready`/`failed`)

#### 1.2. complete-repetido-retorna-409

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Concluir com sucesso um upload de 1 parte (`POST .../upload/complete` → `202`)
    - expect: status `202`
  2. Repetir POST /videos/:publicId/upload/complete com o mesmo body
    - expect: status `409`
    - expect: `error` = `"VIDEO_UPLOAD_NOT_IN_PROGRESS"`

### 2. Recusar conclusões inválidas

**Setup:** mesmo do grupo 1.

#### 2.1. complete-sem-todas-as-partes-retorna-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Iniciar upload de 2 partes e enviar apenas a parte 1
    - expect: o `PUT` da parte 1 responde `200` com `ETag`
  2. POST /videos/:publicId/upload/complete com `{ "parts": [{ "part_number": 1, "etag": <ETag1> }] }`
    - expect: status `400`
    - expect: `error` = `"UPLOAD_INCOMPLETE"`
    - expect: o vídeo continua `awaiting_upload` com `upload_id` preenchido

#### 2.2. complete-com-etag-adulterado-retorna-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Iniciar upload de 1 parte e enviá-la
    - expect: o `PUT` responde `200` com `ETag`
  2. POST /videos/:publicId/upload/complete com `{ "parts": [{ "part_number": 1, "etag": "\"00000000000000000000000000000000\"" }] }`
    - expect: status `400`
    - expect: `error` = `"UPLOAD_INCOMPLETE"`

#### 2.3. complete-tamanho-divergente-retorna-422-e-marca-failed

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Iniciar upload de 1 parte com `size_bytes` = `10485760` e enviar só `9437184` bytes nessa parte (última parte não tem tamanho mínimo)
    - expect: o `PUT` responde `200` com `ETag`
  2. POST /videos/:publicId/upload/complete com a parte enviada
    - expect: status `422`
    - expect: `error` = `"UPLOAD_SIZE_MISMATCH"`
  3. Consultar o vídeo no banco e o objeto no storage
    - expect: `processing_status` = `failed` e `processing_error` preenchido
    - expect: `HeadObject` em `storage_key` responde "não encontrado" (objeto apagado)

#### 2.4. complete-video-de-outro-usuario-retorna-404

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos/:publicId/upload/complete com o token do não-dono e um body válido para o vídeo do dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
    - expect: o vídeo do dono continua `awaiting_upload`
