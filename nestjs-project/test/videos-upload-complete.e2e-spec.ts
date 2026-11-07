// Generated from nestjs-project/specs/videos-upload-complete.plan.md (SI-03.7).
// Job presence in the queue (AC #2) is covered by the SI's integration test.
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

const MIB = 1024 * 1024;

interface StartUploadBody {
  public_id: string;
  upload: {
    part_size_bytes: number;
    part_count: number;
    parts: { part_number: number; url: string }[];
  };
}

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;

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
    owner = await createAuthenticatedUser(app, 'complete_owner');
    other = await createAuthenticatedUser(app, 'complete_other');
  });

  const startUpload = async (sizeBytes: number): Promise<StartUploadBody> => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    return res.body as StartUploadBody;
  };

  /** PUTs `bytes` straight to the storage and returns the ETag. */
  const putPart = async (url: string, bytes: number): Promise<string> => {
    const res = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  };

  const complete = (
    publicId: string,
    parts: { part_number: number; etag: string }[],
    token = owner.accessToken,
  ) =>
    request(app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });

  const findVideo = (publicId: string) =>
    videoRepository.findOneByOrFail({ public_id: publicId });

  // 1. Concluir o upload e iniciar o processamento

  test('complete-conclui-e-move-para-processing', async () => {
    const partSize = 64 * MIB;
    const started = await startUpload(partSize + MIB);
    const etag1 = await putPart(started.upload.parts[0].url, partSize);
    const etag2 = await putPart(started.upload.parts[1].url, MIB);

    const res = await complete(started.public_id, [
      { part_number: 1, etag: etag1 },
      { part_number: 2, etag: etag2 },
    ]).expect(202);

    expect(res.body).toEqual({
      public_id: started.public_id,
      processing_status: 'processing',
    });
    const video = await findVideo(started.public_id);
    expect(video.size_bytes).toBe(video.declared_size_bytes);
    expect(video.upload_id).toBeNull();
    expect([
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
    ]).toContain(video.processing_status);
  });

  test('complete-repetido-retorna-409', async () => {
    const started = await startUpload(MIB);
    const etag = await putPart(started.upload.parts[0].url, MIB);
    await complete(started.public_id, [{ part_number: 1, etag }]).expect(202);

    const res = await complete(started.public_id, [
      { part_number: 1, etag },
    ]).expect(409);

    expect((res.body as { error: string }).error).toBe(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    );
  });

  // 2. Recusar conclusões inválidas

  test('complete-sem-todas-as-partes-retorna-400', async () => {
    const partSize = 64 * MIB;
    const started = await startUpload(partSize + MIB);
    const etag1 = await putPart(started.upload.parts[0].url, partSize);

    const res = await complete(started.public_id, [
      { part_number: 1, etag: etag1 },
    ]).expect(400);

    expect((res.body as { error: string }).error).toBe('UPLOAD_INCOMPLETE');
    const video = await findVideo(started.public_id);
    expect(video.processing_status).toBe(VideoProcessingStatus.AWAITING_UPLOAD);
    expect(video.upload_id).toEqual(expect.any(String));
  });

  test('complete-com-etag-adulterado-retorna-400', async () => {
    const started = await startUpload(MIB);
    await putPart(started.upload.parts[0].url, MIB);

    const res = await complete(started.public_id, [
      { part_number: 1, etag: '"00000000000000000000000000000000"' },
    ]).expect(400);

    expect((res.body as { error: string }).error).toBe('UPLOAD_INCOMPLETE');
  });

  test('complete-tamanho-divergente-retorna-422-e-marca-failed', async () => {
    const started = await startUpload(10485760);
    const etag = await putPart(started.upload.parts[0].url, 9437184);

    const res = await complete(started.public_id, [
      { part_number: 1, etag },
    ]).expect(422);

    expect((res.body as { error: string }).error).toBe('UPLOAD_SIZE_MISMATCH');
    const video = await findVideo(started.public_id);
    expect(video.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(video.processing_error).toEqual(expect.any(String));
    expect(
      await app.get(StorageService).headObject(video.storage_key),
    ).toBeNull();
  });

  test('complete-video-de-outro-usuario-retorna-404', async () => {
    const started = await startUpload(MIB);
    const etag = await putPart(started.upload.parts[0].url, MIB);

    const res = await complete(
      started.public_id,
      [{ part_number: 1, etag }],
      other.accessToken,
    ).expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    const video = await findVideo(started.public_id);
    expect(video.processing_status).toBe(VideoProcessingStatus.AWAITING_UPLOAD);
  });
});
