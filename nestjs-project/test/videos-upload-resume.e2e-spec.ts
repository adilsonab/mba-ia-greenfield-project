// Generated from nestjs-project/specs/videos-upload-resume.plan.md (SI-03.6).
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

interface StartUploadBody {
  public_id: string;
  upload: {
    part_size_bytes: number;
    part_count: number;
    parts: { part_number: number; url: string }[];
  };
}

interface ResumeBody {
  public_id: string;
  part_size_bytes: number;
  part_count: number;
  expires_at: string;
  uploaded_parts: { part_number: number; etag: string; size_bytes: number }[];
  parts: { part_number: number; url: string }[];
}

describe('videos-upload-resume', () => {
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  let started: StartUploadBody;

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
    owner = await createAuthenticatedUser(app, 'resume_owner');
    other = await createAuthenticatedUser(app, 'resume_other');

    // Setup: the owner starts a 2-part upload (size = part size + 1 MiB).
    const partSize = 64 * 1024 * 1024;
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: partSize + 1048576,
      })
      .expect(201);
    started = res.body as StartUploadBody;
  });

  const resume = (publicId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/videos/${publicId}/upload`)
      .set('Authorization', `Bearer ${token}`);

  // 1. Retomar um upload em andamento

  test('resume-lista-partes-enviadas-e-assina-so-as-faltantes', async () => {
    const partSize = started.upload.part_size_bytes;
    const put = await fetch(started.upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(partSize),
    });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    const res = await resume(started.public_id, owner.accessToken).expect(200);

    const body = res.body as ResumeBody;
    expect(body.part_size_bytes).toBe(partSize);
    expect(body.part_count).toBe(2);
    expect(body.uploaded_parts).toEqual([
      { part_number: 1, etag, size_bytes: partSize },
    ]);
    expect(body.parts.map((p) => p.part_number)).toEqual([2]);
    expect(body.parts[0].url).not.toHaveLength(0);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  // 2. Recusar retomadas inválidas

  test('resume-video-de-outro-usuario-retorna-404', async () => {
    const res = await resume(started.public_id, other.accessToken).expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  test('resume-public-id-inexistente-retorna-404', async () => {
    const res = await resume('AAAAAAAAAAA', owner.accessToken).expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  test('resume-video-em-processing-retorna-409', async () => {
    await videoRepository.update(
      { public_id: started.public_id },
      { processing_status: VideoProcessingStatus.PROCESSING },
    );

    const res = await resume(started.public_id, owner.accessToken).expect(409);

    expect((res.body as { error: string }).error).toBe(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    );
  });

  test('resume-multipart-descartado-retorna-410', async () => {
    const video = await videoRepository.findOneByOrFail({
      public_id: started.public_id,
    });
    await app
      .get(StorageService)
      .abortMultipartUpload(video.storage_key, video.upload_id!);

    const res = await resume(started.public_id, owner.accessToken).expect(410);

    expect((res.body as { error: string }).error).toBe('UPLOAD_EXPIRED');
  });
});
