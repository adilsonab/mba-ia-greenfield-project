// Full pipeline e2e (SI-03.13, phase-03-videos/TD-16): upload multipart direto
// ao storage → complete → fila (BullMQ/Redis) → video-worker (FFmpeg) → banco
// → stream/download.
//
// PRÉ-CONDIÇÃO: os serviços `storage`, `redis` e **`video-worker`** do Compose
// precisam estar rodando (`docker compose up -d`). Sem o worker, os vídeos
// nunca saem de `processing` e os testes estouram o timeout de polling.
import { readFile } from 'fs/promises';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createFixtureDir,
  type FixtureDir,
  generateCorruptFile,
  generateVideoFixture,
} from '../src/test/video-fixture';
import { clearThrottler, createTestApp } from './helpers/app.helper';
import {
  type AuthenticatedUser,
  createAuthenticatedUser,
} from './helpers/auth.helper';
import { type PresignedPart, uploadParts } from './helpers/video-upload.helper';

/** S3 minimum part size, so a ~7 MiB fixture already needs 2 parts. */
const PART_SIZE = 5 * 1024 * 1024;
const FIXTURE = { durationSeconds: 3, width: 1280, height: 720 };
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

interface StartUploadBody {
  public_id: string;
  processing_status: string;
  upload: {
    part_size_bytes: number;
    part_count: number;
    parts: PresignedPart[];
  };
}

interface VideoDetailBody {
  processing_status: string;
  processing_error: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  thumbnail_url: string | null;
}

describe('videos-pipeline', () => {
  let app: INestApplication<App>;
  let fixtures: FixtureDir;
  let videoFile: Buffer;
  let corruptFile: Buffer;
  let owner: AuthenticatedUser;
  const originalPartSize = process.env.VIDEO_UPLOAD_PART_SIZE_BYTES;

  beforeAll(async () => {
    // Read by the `videos` config factory when the app boots.
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(PART_SIZE);
    app = await createTestApp();

    fixtures = await createFixtureDir();
    videoFile = await readFile(
      await generateVideoFixture(fixtures.path, 'aula.mp4', {
        ...FIXTURE,
        minSizeBytes: PART_SIZE + 2 * 1024 * 1024,
      }),
    );
    corruptFile = await readFile(
      await generateCorruptFile(fixtures.path, 'corrompido.mp4'),
    );
  });

  afterAll(async () => {
    await app.close();
    await fixtures.cleanup();
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = originalPartSize;
  });

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    clearThrottler(app);
    owner = await createAuthenticatedUser(app, 'pipeline_owner');
  });

  const api = () => request(app.getHttpServer());
  const auth = () => `Bearer ${owner.accessToken}`;

  const startUpload = async (
    file: Buffer,
    fileName: string,
  ): Promise<StartUploadBody> =>
    (
      await api()
        .post('/videos')
        .set('Authorization', auth())
        .send({
          file_name: fileName,
          content_type: 'video/mp4',
          size_bytes: file.length,
        })
        .expect(201)
    ).body as StartUploadBody;

  const getDetail = async (publicId: string): Promise<VideoDetailBody> =>
    (
      await api()
        .get(`/videos/${publicId}`)
        .set('Authorization', auth())
        .expect(200)
    ).body as VideoDetailBody;

  const complete = (publicId: string, parts: unknown[]) =>
    api()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', auth())
      .send({ parts })
      .expect(202);

  /** Polls the detail endpoint until processing reaches a final status. */
  const waitForFinalStatus = async (
    publicId: string,
  ): Promise<VideoDetailBody> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const detail = await getDetail(publicId);
      if (['ready', 'failed'].includes(detail.processing_status)) {
        return detail;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Video ${publicId} still ${detail.processing_status} after ${POLL_TIMEOUT_MS}ms — is the video-worker running?`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  const expectProcessedVideo = (detail: VideoDetailBody): void => {
    expect(detail.processing_status).toBe('ready');
    expect(detail.processing_error).toBeNull();
    expect(detail.duration_seconds).toBeCloseTo(FIXTURE.durationSeconds, 0);
    expect(detail.width).toBe(FIXTURE.width);
    expect(detail.height).toBe(FIXTURE.height);
  };

  test('pipeline-video-valido-em-2-partes-chega-a-ready-com-stream-e-download', async () => {
    const started = await startUpload(videoFile, 'aula.mp4');
    expect(started.upload.part_size_bytes).toBe(PART_SIZE);
    expect(started.upload.part_count).toBe(2);
    // The bytes go to the storage, never to the API.
    for (const part of started.upload.parts) {
      expect(new URL(part.url).host).toBe('storage.localhost:9000');
    }
    expect((await getDetail(started.public_id)).processing_status).toBe(
      'awaiting_upload',
    );

    const parts = await uploadParts(
      videoFile,
      started.upload.part_size_bytes,
      started.upload.parts,
    );
    await complete(started.public_id, parts);

    expect(['processing', 'ready']).toContain(
      (await getDetail(started.public_id)).processing_status,
    );
    const detail = await waitForFinalStatus(started.public_id);
    expectProcessedVideo(detail);

    expect(detail.thumbnail_url).toBeTruthy();
    const thumbnail = await fetch(detail.thumbnail_url!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');

    const stream = await api()
      .get(`/videos/${started.public_id}/stream`)
      .set('Authorization', auth())
      .expect(200);
    const partial = await fetch((stream.body as { url: string }).url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 0-1023/${videoFile.length}`,
    );

    const download = await api()
      .get(`/videos/${started.public_id}/download`)
      .set('Authorization', auth())
      .expect(200);
    const file = await fetch((download.body as { url: string }).url, {
      headers: { Range: 'bytes=0-0' },
    });
    expect(file.ok).toBe(true);
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
  });

  test('pipeline-upload-retomado-apos-parte-1-conclui-e-processa', async () => {
    const started = await startUpload(videoFile, 'aula.mp4');
    const partSize = started.upload.part_size_bytes;
    const firstPart = await uploadParts(videoFile, partSize, [
      started.upload.parts[0],
    ]);

    // Upload "interrupted": ask the API what is missing and continue.
    const resumed = (
      await api()
        .get(`/videos/${started.public_id}/upload`)
        .set('Authorization', auth())
        .expect(200)
    ).body as {
      uploaded_parts: { part_number: number; etag: string }[];
      parts: PresignedPart[];
    };
    expect(resumed.uploaded_parts.map((p) => p.part_number)).toEqual([1]);
    expect(resumed.parts.map((p) => p.part_number)).toEqual([2]);

    const rest = await uploadParts(videoFile, partSize, resumed.parts);
    await complete(started.public_id, [...firstPart, ...rest]);

    expectProcessedVideo(await waitForFinalStatus(started.public_id));
  });

  test('pipeline-arquivo-que-nao-e-video-termina-em-failed', async () => {
    const started = await startUpload(corruptFile, 'corrompido.mp4');
    const parts = await uploadParts(
      corruptFile,
      started.upload.part_size_bytes,
      started.upload.parts,
    );
    await complete(started.public_id, parts);

    const detail = await waitForFinalStatus(started.public_id);

    expect(detail.processing_status).toBe('failed');
    expect(detail.processing_error).toBeTruthy();
  });
});
