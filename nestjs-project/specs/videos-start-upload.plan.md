---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-start-upload.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo: pré-cadastra o vídeo como rascunho (`status: "draft"`, `processing_status: "awaiting_upload"`) no canal do usuário autenticado, abre um multipart upload no object storage e devolve o plano de upload — o tamanho de parte, a quantidade de partes e uma URL pré-assinada de `UploadPart` por parte. O cliente envia os bytes de cada parte direto ao storage com `PUT`; nenhum byte do arquivo passa pela API. O título é opcional e, quando omitido, deriva do nome do arquivo sem extensão. Tamanho acima de 10 GiB ou tipo MIME fora da allowlist são rejeitados com `VALIDATION_ERROR` antes de qualquer byte ser enviado.

## Test Scenarios

### 1. Iniciar upload e pré-cadastrar o rascunho

**Setup:** `beforeAll` cria o app com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo a config global do `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `ValidationExceptionFilter`, `DomainExceptionFilter`); `beforeEach` executa `cleanAllTables` e limpa o `ThrottlerStorage`; um usuário é cadastrado, confirmado e autenticado (mesmo fluxo de `test/auth.e2e-spec.ts`) para obter o `access_token`. Storage (MinIO) e Postgres reais do Compose.

#### 1.1. start-upload-cria-rascunho-com-plano-de-partes

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ "file_name": "aula.mp4", "content_type": "video/mp4", "size_bytes": 134217728 }`
    - expect: status `201`
    - expect: `status` = `"draft"` e `processing_status` = `"awaiting_upload"`
    - expect: `title` = `"aula"`
    - expect: `public_id` com 11 caracteres no alfabeto base64url (`[A-Za-z0-9_-]`)
    - expect: `upload.part_size_bytes` = `67108864`, `upload.part_count` = `2` e `upload.parts` com `part_number` `1` e `2`, cada um com `url` não vazia
    - expect: `upload.expires_at` é uma data ISO-8601 no futuro
  2. Consultar a tabela `videos` pelo `public_id` retornado
    - expect: existe exatamente uma linha, com `channel_id` igual ao canal do usuário autenticado
    - expect: `upload_id` preenchido e `storage_key` = `videos/{id}/original`
    - expect: `declared_size_bytes` = `134217728`, `original_file_name` = `"aula.mp4"` e `content_type` = `"video/mp4"`

#### 1.2. start-upload-com-titulo-informado

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos com token válido e body `{ "file_name": "aula.mp4", "content_type": "video/mp4", "size_bytes": 1048576, "title": "Minha aula" }`
    - expect: status `201`
    - expect: `title` = `"Minha aula"`

#### 1.3. start-upload-url-de-parte-aceita-put-direto-no-storage

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos com token válido e body `{ "file_name": "clip.mp4", "content_type": "video/mp4", "size_bytes": 10485760 }`
    - expect: status `201` com `upload.part_count` = `1`
  2. `PUT` em `upload.parts[0].url` com 10485760 bytes, feito de dentro do container `nestjs-api` (host `storage.localhost`), sem passar pela API
    - expect: o storage responde `200`
    - expect: a resposta traz o header `ETag` não vazio

### 2. Rejeitar inícios de upload inválidos

**Setup:** mesmo do grupo 1.

#### 2.1. start-upload-rejeita-tamanho-acima-de-10gib

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos com token válido e body `{ "file_name": "grande.mp4", "content_type": "video/mp4", "size_bytes": 10737418241 }`
    - expect: status `400`
    - expect: `error` = `"VALIDATION_ERROR"` e `message` é um array citando `size_bytes`
    - expect: nenhuma linha é criada na tabela `videos`

#### 2.2. start-upload-rejeita-content-type-fora-da-allowlist

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos com token válido e body `{ "file_name": "foto.png", "content_type": "image/png", "size_bytes": 1048576 }`
    - expect: status `400`
    - expect: `error` = `"VALIDATION_ERROR"` e `message` cita `content_type`
    - expect: nenhuma linha é criada na tabela `videos`

#### 2.3. start-upload-exige-autenticacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T16:03:30Z

**Steps:**
  1. POST /videos sem header `Authorization` e com body válido
    - expect: status `401`
    - expect: nenhuma linha é criada na tabela `videos`
