// Generated from nestjs-project/specs/videos-detail.plan.md (SI-03.10).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { videoThumbnailKey } from '../src/storage/storage.constants';
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

const INTERNAL_FIELDS = [
  'id',
  'channel_id',
  'storage_key',
  'thumbnail_key',
  'upload_id',
  'declared_size_bytes',
  'metadata',
];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

type DetailBody = Record<string, unknown>;

describe('videos-detail', () => {
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
    owner = await createAuthenticatedUser(app, 'detail_owner');
    other = await createAuthenticatedUser(app, 'detail_other');
  });

  const createVideo = async (): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 1048576,
      })
      .expect(201);
    return (res.body as { public_id: string }).public_id;
  };

  /** Setup: prepares `ready` directly (thumbnail in storage + metadata), without the worker. */
  const markReady = async (publicId: string): Promise<void> => {
    const video = await videoRepository.findOneByOrFail({
      public_id: publicId,
    });
    const thumbnailKey = videoThumbnailKey(video.id);
    await app.get(StorageService).putObject(thumbnailKey, JPEG, 'image/jpeg');
    await videoRepository.update(video.id, {
      processing_status: VideoProcessingStatus.READY,
      thumbnail_key: thumbnailKey,
      upload_id: null,
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      size_bytes: 1048576,
    });
  };

  const getDetail = (publicId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${token}`);

  // 1. Consultar o detalhe do próprio vídeo

  test('detail-video-recem-criado', async () => {
    const publicId = await createVideo();

    const res = await getDetail(publicId, owner.accessToken).expect(200);

    const body = res.body as DetailBody;
    expect(body).toMatchObject({
      public_id: publicId,
      status: 'draft',
      processing_status: 'awaiting_upload',
      processing_error: null,
      thumbnail_url: null,
      title: 'aula',
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      bitrate: null,
      container_format: null,
      size_bytes: null,
    });
    expect(new Date(body.created_at as string).toISOString()).toBe(
      body.created_at,
    );
    expect(new Date(body.updated_at as string).toISOString()).toBe(
      body.updated_at,
    );
  });

  test('detail-video-processado-com-thumbnail', async () => {
    const publicId = await createVideo();
    await markReady(publicId);

    const res = await getDetail(publicId, owner.accessToken).expect(200);

    const body = res.body as DetailBody;
    expect(body).toMatchObject({
      processing_status: 'ready',
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      size_bytes: 1048576,
    });
    expect(typeof body.thumbnail_url).toBe('string');

    const thumbnail = await fetch(body.thumbnail_url as string);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  test('detail-nao-expoe-campos-internos', async () => {
    const publicId = await createVideo();
    await markReady(publicId);

    const res = await getDetail(publicId, owner.accessToken).expect(200);

    for (const field of INTERNAL_FIELDS) {
      expect(res.body).not.toHaveProperty(field);
    }
  });

  // 2. Proteger o detalhe de não-donos

  test('detail-video-de-outro-usuario-retorna-404', async () => {
    const publicId = await createVideo();

    const res = await getDetail(publicId, other.accessToken).expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });
});
