import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UploadExpiredException,
  VideoNotFoundException,
  VideoUploadNotInProgressException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { StartUploadDto } from './dto/start-upload.dto';
import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from './entities/video.entity';
import { VideosService } from './videos.service';

const PART_SIZE = 64 * 1024 * 1024;

function uniqueViolation(detail: string): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), {
    code: '23505',
    detail,
  });
}

describe('VideosService', () => {
  let service: VideosService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findOne: jest.Mock;
  };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    listParts: jest.Mock;
    presignExpiresSeconds: number;
  };

  /** A stored video owned by `user-1`, still awaiting its 2-part upload. */
  const storedVideo = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-1',
      public_id: 'pubVideo001',
      channel_id: 'channel-1',
      channel: { id: 'channel-1', user_id: 'user-1' },
      processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
      declared_size_bytes: 2 * PART_SIZE,
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-1',
      ...overrides,
    }) as Video;

  const savedVideo = (call: number): Partial<Video> =>
    (repo.save.mock.calls as [Partial<Video>][])[call][0];

  const dto: StartUploadDto = {
    file_name: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: 2 * PART_SIZE,
  };

  beforeEach(async () => {
    repo = {
      create: jest.fn((fields: Partial<Video>) => ({ ...fields })),
      save: jest.fn((video: Partial<Video>) => Promise.resolve(video)),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(storedVideo()),
    };
    channels = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadParts: jest.fn(
        (_key: string, _uploadId: string, partNumbers: number[]) =>
          Promise.resolve(
            partNumbers.map((n) => ({ partNumber: n, url: `https://s/${n}` })),
          ),
      ),
      listParts: jest.fn().mockResolvedValue([]),
      presignExpiresSeconds: 3600,
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        {
          provide: videosConfig.KEY,
          useValue: { uploadPartSizeBytes: PART_SIZE },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('startUpload', () => {
    it('should pre-register a draft in the caller channel and return one URL per part', async () => {
      const result = await service.startUpload('user-1', dto);

      expect(channels.findByUserId).toHaveBeenCalledWith('user-1');
      const saved = savedVideo(0);
      expect(saved).toMatchObject({
        channel_id: 'channel-1',
        status: VideoStatus.DRAFT,
        processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
        declared_size_bytes: 2 * PART_SIZE,
        storage_key: `videos/${saved.id}/original`,
      });
      expect(repo.update).toHaveBeenCalledWith(saved.id, {
        upload_id: 'upload-1',
      });
      expect(result.upload.part_count).toBe(2);
      expect(result.upload.part_size_bytes).toBe(PART_SIZE);
      expect(result.upload.parts.map((p) => p.part_number)).toEqual([1, 2]);
      expect(result.status).toBe(VideoStatus.DRAFT);
    });

    it('should round the part count up when the size is not a multiple of the part size', async () => {
      const result = await service.startUpload('user-1', {
        ...dto,
        size_bytes: PART_SIZE + 1,
      });

      expect(result.upload.part_count).toBe(2);
    });

    it('should default the title to the file name without its extension', async () => {
      const result = await service.startUpload('user-1', dto);

      expect(result.title).toBe('aula');
    });

    it('should keep the title sent by the client', async () => {
      const result = await service.startUpload('user-1', {
        ...dto,
        title: 'Minha aula',
      });

      expect(result.title).toBe('Minha aula');
    });

    it('should retry with a new public_id when the insert hits the unique constraint', async () => {
      repo.save
        .mockRejectedValueOnce(
          uniqueViolation('Key (public_id)=(abc) already exists.'),
        )
        .mockImplementationOnce((video: Partial<Video>) =>
          Promise.resolve(video),
        );

      await service.startUpload('user-1', dto);

      expect(repo.save).toHaveBeenCalledTimes(2);
      const first = savedVideo(0);
      const second = savedVideo(1);
      expect(first.public_id).not.toBe(second.public_id);
    });

    it('should not retry on unique violations of other columns', async () => {
      repo.save.mockRejectedValueOnce(
        uniqueViolation('Key (id)=(x) already exists.'),
      );

      await expect(service.startUpload('user-1', dto)).rejects.toBeInstanceOf(
        QueryFailedError,
      );
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('should delete the draft when the storage fails to open the multipart upload', async () => {
      storage.createMultipartUpload.mockRejectedValueOnce(
        new Error('storage down'),
      );

      await expect(service.startUpload('user-1', dto)).rejects.toThrow(
        'storage down',
      );
      const saved = savedVideo(0);
      expect(repo.delete).toHaveBeenCalledWith(saved.id);
    });

    it('should fail loudly when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValueOnce(null);

      await expect(service.startUpload('user-1', dto)).rejects.toThrow(
        'has no channel',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('findOwnedByPublicId', () => {
    it('should return the video when the caller owns its channel', async () => {
      await expect(
        service.findOwnedByPublicId('user-1', 'pubVideo001'),
      ).resolves.toMatchObject({ id: 'video-1' });
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { public_id: 'pubVideo001' },
        relations: { channel: true },
      });
    });

    it('should raise VIDEO_NOT_FOUND when the video does not exist', async () => {
      repo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.findOwnedByPublicId('user-1', 'missing0000'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should raise VIDEO_NOT_FOUND (not a 403) when another user owns the video', async () => {
      await expect(
        service.findOwnedByPublicId('user-2', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('resumeUpload', () => {
    it('should list the stored parts and sign only the missing ones', async () => {
      storage.listParts.mockResolvedValueOnce([
        { partNumber: 1, etag: '"etag-1"', sizeBytes: PART_SIZE },
      ]);

      const result = await service.resumeUpload('user-1', 'pubVideo001');

      expect(storage.listParts).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
      );
      expect(storage.presignUploadParts).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        [2],
        3600,
      );
      expect(result).toMatchObject({
        public_id: 'pubVideo001',
        part_size_bytes: PART_SIZE,
        part_count: 2,
        uploaded_parts: [
          { part_number: 1, etag: '"etag-1"', size_bytes: PART_SIZE },
        ],
        parts: [{ part_number: 2, url: 'https://s/2' }],
      });
    });

    it('should raise VIDEO_UPLOAD_NOT_IN_PROGRESS when the video is past awaiting_upload', async () => {
      repo.findOne.mockResolvedValueOnce(
        storedVideo({ processing_status: VideoProcessingStatus.PROCESSING }),
      );

      await expect(
        service.resumeUpload('user-1', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should raise UPLOAD_EXPIRED when the storage no longer has the multipart upload', async () => {
      storage.listParts.mockRejectedValueOnce(
        new StorageUploadNotFoundError('upload-1'),
      );

      await expect(
        service.resumeUpload('user-1', 'pubVideo001'),
      ).rejects.toBeInstanceOf(UploadExpiredException);
    });

    it('should propagate unexpected storage errors untouched', async () => {
      storage.listParts.mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        service.resumeUpload('user-1', 'pubVideo001'),
      ).rejects.toThrow('connection reset');
    });

    it('should not disclose videos of other users', async () => {
      await expect(
        service.resumeUpload('user-2', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.listParts).not.toHaveBeenCalled();
    });
  });
});
