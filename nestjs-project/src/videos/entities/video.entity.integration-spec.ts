import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoProcessingStatus, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `owner${n}`,
        nickname: `owner${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    const id = randomUUID();
    return {
      id,
      public_id: `pub${String(++counter).padStart(8, '0')}`,
      channel_id: channelId,
      title: 'aula',
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: 134217728,
      storage_key: `videos/${id}/original`,
      ...overrides,
    };
  }

  it('should default status to draft and processing_status to awaiting_upload', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.processing_status).toBe(VideoProcessingStatus.AWAITING_UPLOAD);
    expect(found.processing_error).toBeNull();
    expect(found.size_bytes).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { public_id: 'Duplicated1' }),
      ),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(
          buildVideo(channel.id, { public_id: 'Duplicated1' }),
        ),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject a video whose channel_id does not exist', async () => {
    await expect(
      videoRepository.save(videoRepository.create(buildVideo(randomUUID()))),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should read bigint and numeric columns back as numbers', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, {
          declared_size_bytes: 10737418240,
          size_bytes: 10737418240,
          bitrate: 4500000,
          duration_seconds: 3.025,
        }),
      ),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.declared_size_bytes).toBe(10737418240);
    expect(found.size_bytes).toBe(10737418240);
    expect(found.bitrate).toBe(4500000);
    expect(found.duration_seconds).toBe(3.025);
  });

  it('should persist the raw ffprobe output as jsonb', async () => {
    const channel = await createChannel();
    const metadata = { format: { format_name: 'mov,mp4' }, streams: [] };
    const saved = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id, { metadata })),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
  });
});
