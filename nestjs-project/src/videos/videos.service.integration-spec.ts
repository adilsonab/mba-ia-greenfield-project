import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
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
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real Postgres + MinIO)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let admin: S3Client;
  const bucketConfig = testStorageConfig();

  beforeAll(async () => {
    admin = adminS3Client();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(bucketConfig)
      .compile();
    await module.init();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await destroyBucket(admin, bucketConfig.bucket);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    jest.restoreAllMocks();
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const n = ++counter;
    const user = await dataSource
      .getRepository(User)
      .save({ email: `uploader_${n}@example.com`, password: 'hashed' });
    const channel = await dataSource.getRepository(Channel).save({
      name: `uploader${n}`,
      nickname: `uploader${n}`,
      user_id: user.id,
    });
    return { user, channel };
  }

  describe('startUpload', () => {
    it("should persist the draft in the caller's channel and open a real multipart upload", async () => {
      const { user, channel } = await createUserWithChannel();

      const result = await service.startUpload(user.id, {
        file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 134217728,
      });

      const video = await videoRepository.findOneByOrFail({
        public_id: result.public_id,
      });
      expect(video.channel_id).toBe(channel.id);
      expect(video.processing_status).toBe(
        VideoProcessingStatus.AWAITING_UPLOAD,
      );
      expect(video.storage_key).toBe(`videos/${video.id}/original`);
      expect(video.declared_size_bytes).toBe(134217728);
      expect(video.upload_id).toEqual(expect.any(String));

      // The multipart upload exists in the storage (no parts uploaded yet).
      await expect(
        storage.listParts(video.storage_key, video.upload_id!),
      ).resolves.toEqual([]);
      expect(result.upload.part_count).toBe(2);
    });

    it('should delete the draft row when the storage fails (compensation)', async () => {
      const { user } = await createUserWithChannel();
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockRejectedValueOnce(new Error('storage unavailable'));

      await expect(
        service.startUpload(user.id, {
          file_name: 'aula.mp4',
          content_type: 'video/mp4',
          size_bytes: 1048576,
        }),
      ).rejects.toThrow('storage unavailable');

      expect(await videoRepository.count()).toBe(0);
    });
  });

  describe('resumeUpload', () => {
    it('should report the stored part and re-sign only the missing one (1 of 2 uploaded to real MinIO)', async () => {
      const { user } = await createUserWithChannel();
      const partSize = 64 * 1024 * 1024;
      const started = await service.startUpload(user.id, {
        file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: partSize + 1024 * 1024,
      });
      expect(started.upload.part_count).toBe(2);

      const put = await fetch(started.upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(partSize),
      });
      expect(put.status).toBe(200);

      const resumed = await service.resumeUpload(user.id, started.public_id);

      expect(resumed.uploaded_parts).toEqual([
        {
          part_number: 1,
          etag: put.headers.get('etag'),
          size_bytes: partSize,
        },
      ]);
      expect(resumed.parts.map((p) => p.part_number)).toEqual([2]);
      expect(resumed.part_count).toBe(2);
    });
  });
});
