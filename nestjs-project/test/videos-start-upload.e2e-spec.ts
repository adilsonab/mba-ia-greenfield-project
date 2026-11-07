// Generated from nestjs-project/specs/videos-start-upload.plan.md (SI-03.5).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { clearThrottler, createTestApp } from './helpers/app.helper';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';

interface StartUploadBody {
  public_id: string;
  title: string;
  status: string;
  processing_status: string;
  upload: {
    part_size_bytes: number;
    part_count: number;
    expires_at: string;
    parts: { part_number: number; url: string }[];
  };
}

interface ErrorBody {
  error: string;
  message: string | string[];
}

describe('videos-start-upload', () => {
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    app = await createTestApp();
    videoRepository = app.get(DataSource).getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    clearThrottler(app);
    owner = await createAuthenticatedUser(app, 'start_upload');
  });

  const startUpload = (body: Record<string, unknown>, token?: string) => {
    const req = request(app.getHttpServer()).post('/videos').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  // 1. Iniciar upload e pré-cadastrar o rascunho

  test('start-upload-cria-rascunho-com-plano-de-partes', async () => {
    const res = await startUpload(
      {
        file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 134217728,
      },
      owner.accessToken,
    ).expect(201);

    const body = res.body as StartUploadBody;
    expect(body.status).toBe('draft');
    expect(body.processing_status).toBe('awaiting_upload');
    expect(body.title).toBe('aula');
    expect(body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body.upload.part_size_bytes).toBe(67108864);
    expect(body.upload.part_count).toBe(2);
    expect(body.upload.parts.map((p) => p.part_number)).toEqual([1, 2]);
    body.upload.parts.forEach((p) => expect(p.url).not.toHaveLength(0));
    expect(new Date(body.upload.expires_at).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const rows = await videoRepository.findBy({ public_id: body.public_id });
    expect(rows).toHaveLength(1);
    const [video] = rows;
    expect(video.channel_id).toBe(owner.channelId);
    expect(video.upload_id).toEqual(expect.any(String));
    expect(video.storage_key).toBe(`videos/${video.id}/original`);
    expect(video.declared_size_bytes).toBe(134217728);
    expect(video.original_file_name).toBe('aula.mp4');
    expect(video.content_type).toBe('video/mp4');
  });

  test('start-upload-com-titulo-informado', async () => {
    const res = await startUpload(
      {
        file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 1048576,
        title: 'Minha aula',
      },
      owner.accessToken,
    ).expect(201);

    expect((res.body as StartUploadBody).title).toBe('Minha aula');
  });

  test('start-upload-url-de-parte-aceita-put-direto-no-storage', async () => {
    const size = 10485760;
    const res = await startUpload(
      { file_name: 'clip.mp4', content_type: 'video/mp4', size_bytes: size },
      owner.accessToken,
    ).expect(201);
    const body = res.body as StartUploadBody;
    expect(body.upload.part_count).toBe(1);

    // Straight to the storage (storage.localhost) — the API never sees the bytes.
    const put = await fetch(body.upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(size),
    });

    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  // 2. Rejeitar inícios de upload inválidos

  test('start-upload-rejeita-tamanho-acima-de-10gib', async () => {
    const res = await startUpload(
      {
        file_name: 'grande.mp4',
        content_type: 'video/mp4',
        size_bytes: 10737418241,
      },
      owner.accessToken,
    ).expect(400);

    const body = res.body as ErrorBody;
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.message)).toBe(true);
    expect((body.message as string[]).join(' ')).toContain('size_bytes');
    expect(await videoRepository.count()).toBe(0);
  });

  test('start-upload-rejeita-content-type-fora-da-allowlist', async () => {
    const res = await startUpload(
      { file_name: 'foto.png', content_type: 'image/png', size_bytes: 1048576 },
      owner.accessToken,
    ).expect(400);

    const body = res.body as ErrorBody;
    expect(body.error).toBe('VALIDATION_ERROR');
    expect((body.message as string[]).join(' ')).toContain('content_type');
    expect(await videoRepository.count()).toBe(0);
  });

  test('start-upload-exige-autenticacao', async () => {
    await startUpload({
      file_name: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 1048576,
    }).expect(401);

    expect(await videoRepository.count()).toBe(0);
  });
});
