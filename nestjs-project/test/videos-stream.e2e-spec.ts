// Generated from nestjs-project/specs/videos-stream.plan.md (SI-03.11).
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

describe('videos-stream', () => {
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

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    clearThrottler(app);
    owner = await createAuthenticatedUser(app, 'stream_owner');
    other = await createAuthenticatedUser(app, 'stream_other');

    // Setup: create → upload (2 MiB, 1 part) → complete the multipart through
    // the storage (NOT the API endpoint, which would enqueue a job the running
    // video-worker could race with) → mark ready in the DB directly.
    const server = app.getHttpServer();
    const started = (
      await request(server)
        .post('/videos')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          file_name: 'aula.mp4',
          content_type: 'video/mp4',
          size_bytes: FILE_SIZE,
        })
        .expect(201)
    ).body as StartUploadBody;
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

  const getStream = (token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${publicId}/stream`)
      .set('Authorization', `Bearer ${token}`);

  // 1. Obter a URL de streaming de um vídeo pronto

  test('stream-retorna-url-com-expiracao', async () => {
    const res = await getStream(owner.accessToken).expect(200);

    const body = res.body as { url: string; expires_at: string };
    expect(new URL(body.url).host).toBe('storage.localhost:9000');
    const minutesAhead =
      (new Date(body.expires_at).getTime() - Date.now()) / 60000;
    expect(minutesAhead).toBeGreaterThan(55);
    expect(minutesAhead).toBeLessThan(65);
  });

  test('stream-url-atende-range-com-206', async () => {
    const res = await getStream(owner.accessToken).expect(200);
    const { url } = res.body as { url: string };

    const partial = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 0-1023/${FILE_SIZE}`,
    );
    const body = Buffer.from(await partial.arrayBuffer());
    expect(body.length).toBe(1024);
    expect(body.equals(fileBytes.subarray(0, 1024))).toBe(true);
  });

  // 2. Recusar streaming inválido

  test('stream-video-em-processing-retorna-409', async () => {
    await videoRepository.update(
      { public_id: publicId },
      { processing_status: VideoProcessingStatus.PROCESSING },
    );

    const res = await getStream(owner.accessToken).expect(409);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
  });

  test('stream-video-de-outro-usuario-retorna-404', async () => {
    const res = await getStream(other.accessToken).expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });
});
