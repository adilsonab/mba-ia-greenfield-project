import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { MediaModule } from '../media/media.module';
import storageConfig from '../config/storage.config';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  adminS3Client,
  destroyBucket,
  testStorageConfig,
} from '../test/storage-test-bucket';
import {
  createFixtureDir,
  type FixtureDir,
  generateCorruptFile,
  generateVideoFixture,
} from '../test/video-fixture';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import type { VideoProcessJobData } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function jobFor(
  videoId: string,
  overrides: Partial<Job<VideoProcessJobData>> = {},
): Job<VideoProcessJobData> {
  return {
    data: { videoId },
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job<VideoProcessJobData>;
}

/**
 * Exercises the processor directly (no queue) against the real Postgres,
 * MinIO and ffprobe/ffmpeg. The full queue → worker container path is
 * covered by the SI-03.13 e2e.
 */
describe('VideoProcessingProcessor (integration — real Postgres + MinIO + FFmpeg)', () => {
  let module: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let admin: S3Client;
  let fixtures: FixtureDir;
  const bucketConfig = testStorageConfig();

  beforeAll(async () => {
    admin = adminS3Client();
    fixtures = await createFixtureDir();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingProcessor],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(bucketConfig)
      .compile();
    await module.init();

    processor = module.get(VideoProcessingProcessor);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await destroyBucket(admin, bucketConfig.bucket);
    await fixtures.cleanup();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  /** Persists a video in `processing` whose original is `filePath`, uploaded to MinIO. */
  async function storedVideo(filePath: string): Promise<Video> {
    const n = ++counter;
    const user = await dataSource
      .getRepository(User)
      .save({ email: `worker_${n}@example.com`, password: 'hashed' });
    const channel = await dataSource.getRepository(Channel).save({
      name: `worker${n}`,
      nickname: `worker${n}`,
      user_id: user.id,
    });
    const bytes = await readFile(filePath);
    const id = randomUUID();
    await storage.putObject(videoOriginalKey(id), bytes, 'video/mp4');
    return videoRepository.save({
      id,
      public_id: `wrk${String(n).padStart(8, '0')}`,
      channel_id: channel.id,
      title: 'aula',
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: bytes.length,
      size_bytes: bytes.length,
      storage_key: videoOriginalKey(id),
      processing_status: VideoProcessingStatus.PROCESSING,
    });
  }

  it('should leave a valid video ready with metadata and a stored thumbnail', async () => {
    const file = await generateVideoFixture(fixtures.path, 'valid.mp4');
    const video = await storedVideo(file);

    await processor.process(jobFor(video.id));

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.processing_status).toBe(VideoProcessingStatus.READY);
    expect(processed.duration_seconds).toBeCloseTo(3, 1);
    expect(processed.width).toBe(1920);
    expect(processed.height).toBe(1080);
    expect(processed.video_codec).toBe('h264');
    expect(processed.audio_codec).toBe('aac');
    expect(processed.container_format).toContain('mp4');
    expect(processed.bitrate).toBeGreaterThan(0);
    expect(processed.metadata).toHaveProperty('streams');
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    const thumbnail = await storage.headObject(processed.thumbnail_key!);
    expect(thumbnail?.contentType).toBe('image/jpeg');
    expect(thumbnail?.contentLength).toBeGreaterThan(0);
  });

  it('should not change a video that is already ready when the job is re-delivered', async () => {
    const file = await generateVideoFixture(fixtures.path, 'again.mp4');
    const video = await storedVideo(file);
    await processor.process(jobFor(video.id));
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    await processor.process(jobFor(video.id));

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.updated_at.getTime()).toBe(first.updated_at.getTime());
  });

  it('should fail a non-video file permanently and record the reason', async () => {
    const file = await generateCorruptFile(fixtures.path, 'corrupt.mp4');
    const video = await storedVideo(file);

    const error = await processor
      .process(jobFor(video.id))
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    await processor.onFailed(jobFor(video.id), error as Error);

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(failed.processing_error).toMatch(/^Unsupported or corrupt media:/);
    expect(failed.thumbnail_key).toBeNull();
  });

  it('should keep the video processing on an intermediate failure and fail it after the last attempt', async () => {
    const file = await generateVideoFixture(fixtures.path, 'retry.mp4');
    const video = await storedVideo(file);
    const transient = new Error('storage timeout');

    await processor.onFailed(jobFor(video.id, { attemptsMade: 2 }), transient);
    expect(
      (await videoRepository.findOneByOrFail({ id: video.id }))
        .processing_status,
    ).toBe(VideoProcessingStatus.PROCESSING);

    await processor.onFailed(jobFor(video.id, { attemptsMade: 3 }), transient);
    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(failed.processing_error).toBe(
      'Processing failed after 3 attempts: storage timeout',
    );
  });
});
