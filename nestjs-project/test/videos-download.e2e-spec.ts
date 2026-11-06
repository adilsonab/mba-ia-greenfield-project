// Generated from nestjs-project/specs/videos-download.plan.md (SI-03.12).
import { randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { clearThrottler, createTestApp } from './helpers/app.helper';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';

const FILE_SIZE = 2 * 1024 * 1024;

interface StartUploadBody {
  public_id: string;
  upload: { parts: { part_number: number; url: string }[] };
}

describe('videos-download', () => {
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  let publicId: string;
  let fileBytes: Buffer;

  beforeAll(async () => {
    app = await createTestApp();
    videoRepository = app.get(DataSource).getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  const startUpload = async (token: string): Promise<StartUploadBody> =>
    (
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          file_name: 'aula.mp4',
          content_type: 'video/mp4',
          size_bytes: FILE_SIZE,
        })
        .expect(201)
    ).body as StartUploadBody;

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    clearThrottler(app);
    owner = await createAuthenticatedUser(app, 'download_owner');
    other = await createAuthenticatedUser(app, 'download_other');

    // Setup: create → upload (2 MiB, 1 part) → complete the multipart through
    // the storage (NOT the API endpoint, which would enqueue a job the running
    // video-worker could race with) → mark ready in the DB directly.
    const started = await startUpload(owner.accessToken);
    publicId = started.public_id;
    fileBytes = randomBytes(FILE_SIZE);
    const put = await fetch(started.upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(fileBytes),
    });
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    await app
      .get(StorageService)
      .completeMultipartUpload(video.storage_key, video.upload_id!, [
        { partNumber: 1, etag: put.headers.get('etag')! },
      ]);
    await videoRepository.update(video.id, {
      upload_id: null,
      size_bytes: FILE_SIZE,
      processing_status: VideoProcessingStatus.READY,
    });
  });

  const getDownload = (token: string, id: string = publicId) =>
    request(app.getHttpServer())
      .get(`/videos/${id}/download`)
      .set('Authorization', `Bearer ${token}`);

  // 1. Obter a URL de download de um vídeo pronto

  test('download-retorna-url-com-expiracao', async () => {
    const res = await getDownload(owner.accessToken).expect(200);

    const body = res.body as { url: string; expires_at: string };
    expect(body.url).toBeTruthy();
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('download-url-entrega-anexo-com-nome-original', async () => {
    const res = await getDownload(owner.accessToken).expect(200);
    const { url } = res.body as { url: string };

    const file = await fetch(url);

    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
    expect(file.headers.get('content-length')).toBe(String(FILE_SIZE));
    const body = Buffer.from(await file.arrayBuffer());
    expect(body.equals(fileBytes)).toBe(true);
  });

  // 2. Recusar download inválido

  test('download-video-aguardando-upload-retorna-409', async () => {
    const pending = await startUpload(owner.accessToken);

    const res = await getDownload(owner.accessToken, pending.public_id).expect(
      409,
    );

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
  });

  test('download-video-de-outro-usuario-retorna-404', async () => {
    const res = await getDownload(other.accessToken).expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });
});
