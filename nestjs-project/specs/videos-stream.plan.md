---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/:publicId/stream — Test Plan

## Application Overview

`GET /videos/:publicId/stream` devolve ao dono de um vídeo `ready` uma URL pré-assinada de curta duração (`url`, `expires_at` ~1h) que o player carrega direto do object storage. O storage atende requisições com `Range` respondendo `206 Partial Content`, então a reprodução começa sem baixar o arquivo inteiro e sem tráfego de vídeo pela API. Vídeo que ainda não está `ready` responde `409 VIDEO_NOT_READY`; vídeo de outro usuário responde `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Obter a URL de streaming de um vídeo pronto

**Setup:** `beforeAll` cria o app com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts`; `beforeEach` executa `cleanAllTables` e limpa o `ThrottlerStorage`; dois usuários são cadastrados, confirmados e autenticados (dono e não-dono). O dono cria o vídeo (`POST /videos`), envia o arquivo (2 MiB, 1 parte) e conclui o upload; o estado `ready` é então preparado diretamente no banco (`processing_status = 'ready'`), sem depender do worker. Storage (MinIO) e Postgres reais do Compose.

#### 1.1. stream-retorna-url-com-expiracao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/:publicId/stream com o token do dono
    - expect: status `200`
    - expect: `url` não vazia apontando para o host público do storage
    - expect: `expires_at` em ISO-8601, entre 55 e 65 minutos no futuro

#### 1.2. stream-url-atende-range-com-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Obter `url` via GET /videos/:publicId/stream com o token do dono
    - expect: status `200`
  2. `GET` em `url` com header `Range: bytes=0-1023` (de dentro do container)
    - expect: o storage responde `206`
    - expect: o corpo tem exatamente 1024 bytes, iguais aos primeiros 1024 bytes do arquivo enviado
    - expect: header `Content-Range: bytes 0-1023/2097152`

### 2. Recusar streaming inválido

**Setup:** mesmo do grupo 1.

#### 2.1. stream-video-em-processing-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Atualizar diretamente no banco o vídeo do dono para `processing_status = 'processing'`
    - expect: a linha é atualizada
  2. GET /videos/:publicId/stream com o token do dono
    - expect: status `409`
    - expect: `error` = `"VIDEO_NOT_READY"`

#### 2.2. stream-video-de-outro-usuario-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/:publicId/stream com o token do não-dono, usando o `public_id` do vídeo `ready` do dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
