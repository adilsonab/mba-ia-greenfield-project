---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-resume.e2e-spec.ts
---

# GET /videos/:publicId/upload — Test Plan

## Application Overview

`GET /videos/:publicId/upload` permite retomar um upload interrompido: para um vídeo do próprio usuário ainda em `awaiting_upload`, consulta o storage (`ListParts`) e devolve as partes já armazenadas (`uploaded_parts`) e URLs pré-assinadas novas apenas para as partes que faltam (`parts`). Vídeos de outro usuário e `publicId` inexistente respondem `404 VIDEO_NOT_FOUND` (sem revelar existência); vídeos fora de `awaiting_upload` respondem `409 VIDEO_UPLOAD_NOT_IN_PROGRESS`; um multipart que o storage já descartou responde `410 UPLOAD_EXPIRED`.

## Test Scenarios

### 1. Retomar um upload em andamento

**Setup:** `beforeAll` cria o app com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts`; `beforeEach` executa `cleanAllTables` e limpa o `ThrottlerStorage`; dois usuários são cadastrados, confirmados e autenticados (dono e não-dono). O dono inicia um upload de 2 partes via `POST /videos` com `size_bytes` = `part_size_bytes + 1048576`. Storage (MinIO) e Postgres reais do Compose.

#### 1.1. resume-lista-partes-enviadas-e-assina-so-as-faltantes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. `PUT` em `upload.parts[0].url` com exatamente `part_size_bytes` bytes, direto no storage
    - expect: o storage responde `200` com `ETag`
  2. GET /videos/:publicId/upload com o token do dono
    - expect: status `200`
    - expect: `part_size_bytes` e `part_count` = `2` iguais aos do plano original
    - expect: `uploaded_parts` contém exatamente `{ part_number: 1, etag: <ETag do passo 1>, size_bytes: part_size_bytes }`
    - expect: `parts` contém apenas `part_number: 2`, com `url` não vazia
    - expect: `expires_at` é uma data ISO-8601 no futuro

### 2. Recusar retomadas inválidas

**Setup:** mesmo do grupo 1.

#### 2.1. resume-video-de-outro-usuario-retorna-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/:publicId/upload com o token do não-dono, usando o `public_id` do vídeo do dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`

#### 2.2. resume-public-id-inexistente-retorna-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/AAAAAAAAAAA/upload com o token do dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`

#### 2.3. resume-video-em-processing-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Atualizar diretamente no banco o vídeo do dono para `processing_status = 'processing'`
    - expect: a linha é atualizada
  2. GET /videos/:publicId/upload com o token do dono
    - expect: status `409`
    - expect: `error` = `"VIDEO_UPLOAD_NOT_IN_PROGRESS"`

#### 2.4. resume-multipart-descartado-retorna-410

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Abortar o multipart do vídeo direto no storage (`AbortMultipartUpload` com o `upload_id` da linha)
    - expect: o storage confirma o abort
  2. GET /videos/:publicId/upload com o token do dono
    - expect: status `410`
    - expect: `error` = `"UPLOAD_EXPIRED"`
