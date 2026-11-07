---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/:publicId/download — Test Plan

## Application Overview

`GET /videos/:publicId/download` devolve ao dono de um vídeo `ready` uma URL pré-assinada de curta duração que baixa o arquivo original como anexo: a assinatura inclui `response-content-disposition`, então o storage responde com `Content-Disposition: attachment; filename="<original_file_name>"`. Vídeo que não está `ready` responde `409 VIDEO_NOT_READY`; vídeo de outro usuário responde `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Baixar o vídeo pronto

**Setup:** `beforeAll` cria o app com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts`; `beforeEach` executa `cleanAllTables` e limpa o `ThrottlerStorage`; dois usuários são cadastrados, confirmados e autenticados (dono e não-dono). O dono cria o vídeo com `file_name: "aula.mp4"` (`POST /videos`), envia o arquivo (2 MiB, 1 parte) e conclui o upload; o estado `ready` é então preparado diretamente no banco (`processing_status = 'ready'`), sem depender do worker. Storage (MinIO) e Postgres reais do Compose.

#### 1.1. download-retorna-url-com-expiracao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/:publicId/download com o token do dono
    - expect: status `200`
    - expect: `url` não vazia e `expires_at` em ISO-8601 no futuro

#### 1.2. download-url-entrega-anexo-com-nome-original

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Obter `url` via GET /videos/:publicId/download com o token do dono
    - expect: status `200`
  2. `GET` em `url` (de dentro do container)
    - expect: o storage responde `200`
    - expect: header `Content-Disposition` = `attachment; filename="aula.mp4"`
    - expect: `Content-Length` = `2097152` (igual a `size_bytes`) e o corpo idêntico ao arquivo enviado

### 2. Recusar download inválido

**Setup:** mesmo do grupo 1, exceto onde indicado.

#### 2.1. download-video-aguardando-upload-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. Criar um segundo vídeo via POST /videos com o token do dono, sem enviar nem concluir o upload (fica `awaiting_upload`)
    - expect: status `201`
  2. GET /videos/:publicId/download com o token do dono para esse vídeo
    - expect: status `409`
    - expect: `error` = `"VIDEO_NOT_READY"`

#### 2.2. download-video-de-outro-usuario-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. GET /videos/:publicId/download com o token do não-dono, usando o `public_id` do vídeo `ready` do dono
    - expect: status `404`
    - expect: `error` = `"VIDEO_NOT_FOUND"`
