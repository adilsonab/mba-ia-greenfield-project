import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UploadExpiredException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoUploadNotInProgressException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import {
  StorageInvalidPartError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
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
  let producer: { enqueue: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
    presignGetObject: jest.Mock;
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
      thumbnail_key: null,
      created_at: new Date('2026-11-06T10:00:00Z'),
      updated_at: new Date('2026-11-06T10:00:00Z'),
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
    producer = { enqueue: jest.fn().mockResolvedValue(undefined) };
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
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({
        contentLength: 2 * PART_SIZE,
        contentType: 'video/mp4',
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignGetObject: jest.fn().mockResolvedValue({
        url: 'https://s/thumb',
        expiresAt: new Date(),
      }),
      presignExpiresSeconds: 3600,
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
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

  describe('completeUpload', () => {
    const allParts = {
      parts: [
        { part_number: 2, etag: '"etag-2"' },
        { part_number: 1, etag: '"etag-1"' },
      ],
    };

    it('should complete, verify, enqueue and only then move the video to processing', async () => {
      const result = await service.completeUpload(
        'user-1',
        'pubVideo001',
        allParts,
      );

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        [
          { partNumber: 2, etag: '"etag-2"' },
          { partNumber: 1, etag: '"etag-1"' },
        ],
      );
      expect(storage.headObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
      expect(repo.update).toHaveBeenCalledWith('video-1', {
        size_bytes: 2 * PART_SIZE,
        upload_id: null,
        processing_status: VideoProcessingStatus.PROCESSING,
      });
      const enqueueOrder = producer.enqueue.mock.invocationCallOrder[0];
      const updateOrder = repo.update.mock.invocationCallOrder[0];
      expect(enqueueOrder).toBeLessThan(updateOrder);
      expect(result).toEqual({
        public_id: 'pubVideo001',
        processing_status: VideoProcessingStatus.PROCESSING,
      });
    });

    it('should raise UPLOAD_INCOMPLETE without calling the storage when a part of the plan is missing', async () => {
      await expect(
        service.completeUpload('user-1', 'pubVideo001', {
          parts: [{ part_number: 1, etag: '"etag-1"' }],
        }),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should raise UPLOAD_INCOMPLETE for duplicated or out-of-plan part numbers', async () => {
      await expect(
        service.completeUpload('user-1', 'pubVideo001', {
          parts: [
            { part_number: 1, etag: '"a"' },
            { part_number: 1, etag: '"b"' },
          ],
        }),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      await expect(
        service.completeUpload('user-1', 'pubVideo001', {
          parts: [
            { part_number: 1, etag: '"a"' },
            { part_number: 3, etag: '"b"' },
          ],
        }),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
    });

    it('should map a part/ETag rejected by the storage to UPLOAD_INCOMPLETE', async () => {
      storage.completeMultipartUpload.mockRejectedValueOnce(
        new StorageInvalidPartError('InvalidPart'),
      );

      await expect(
        service.completeUpload('user-1', 'pubVideo001', allParts),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should map a vanished multipart upload to UPLOAD_EXPIRED', async () => {
      storage.completeMultipartUpload.mockRejectedValueOnce(
        new StorageUploadNotFoundError('upload-1'),
      );

      await expect(
        service.completeUpload('user-1', 'pubVideo001', allParts),
      ).rejects.toBeInstanceOf(UploadExpiredException);
    });

    it('should delete the object, mark the video failed and raise UPLOAD_SIZE_MISMATCH when sizes differ', async () => {
      storage.headObject.mockResolvedValueOnce({
        contentLength: 2 * PART_SIZE - 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload('user-1', 'pubVideo001', allParts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repo.update).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({
          upload_id: null,
          processing_status: VideoProcessingStatus.FAILED,
          processing_error: expect.stringContaining('does not match') as string,
        }),
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should raise VIDEO_UPLOAD_NOT_IN_PROGRESS when completing twice', async () => {
      repo.findOne.mockResolvedValueOnce(
        storedVideo({ processing_status: VideoProcessingStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload('user-1', 'pubVideo001', allParts),
      ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
    });
  });

  describe('getDetail', () => {
    it('should sign the thumbnail only when the video has one', async () => {
      const result = await service.getDetail('user-1', 'pubVideo001');

      expect(storage.presignGetObject).not.toHaveBeenCalled();
      expect(result.thumbnail_url).toBeNull();
    });

    it('should return a presigned thumbnail URL for a processed video', async () => {
      repo.findOne.mockResolvedValueOnce(
        storedVideo({
          processing_status: VideoProcessingStatus.READY,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );

      const result = await service.getDetail('user-1', 'pubVideo001');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
      );
      expect(result.thumbnail_url).toBe('https://s/thumb');
      expect(result.processing_status).toBe(VideoProcessingStatus.READY);
    });

    it('should delegate ownership to findOwnedByPublicId (404 for other users)', async () => {
      await expect(
        service.getDetail('user-2', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl', () => {
    it('should presign the original for a ready video and return url + expires_at', async () => {
      const expiresAt = new Date('2026-11-06T11:00:00Z');
      repo.findOne.mockResolvedValueOnce(
        storedVideo({ processing_status: VideoProcessingStatus.READY }),
      );
      storage.presignGetObject.mockResolvedValueOnce({
        url: 'https://s/stream',
        expiresAt,
      });

      const result = await service.getStreamUrl('user-1', 'pubVideo001');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(result).toEqual({
        url: 'https://s/stream',
        expires_at: '2026-11-06T11:00:00.000Z',
      });
    });

    it.each([
      VideoProcessingStatus.AWAITING_UPLOAD,
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.FAILED,
    ])('should raise VIDEO_NOT_READY while the video is %s', async (status) => {
      repo.findOne.mockResolvedValueOnce(
        storedVideo({ processing_status: status }),
      );

      await expect(
        service.getStreamUrl('user-1', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('should not disclose videos of other users', async () => {
      await expect(
        service.getStreamUrl('user-2', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
  describe('getDownloadUrl', () => {
    it('should presign the original as an attachment named after the uploaded file', async () => {
      const expiresAt = new Date('2026-11-06T11:00:00Z');
      repo.findOne.mockResolvedValueOnce(
        storedVideo({
          processing_status: VideoProcessingStatus.READY,
          original_file_name: 'aula.mp4',
        }),
      );
      storage.presignGetObject.mockResolvedValueOnce({
        url: 'https://s/download',
        expiresAt,
      });

      const result = await service.getDownloadUrl('user-1', 'pubVideo001');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original',
        { downloadFileName: 'aula.mp4' },
      );
      expect(result).toEqual({
        url: 'https://s/download',
        expires_at: '2026-11-06T11:00:00.000Z',
      });
    });

    it.each([
      VideoProcessingStatus.AWAITING_UPLOAD,
      VideoProcessingStatus.PROCESSING,
      VideoProcessingStatus.FAILED,
    ])('should raise VIDEO_NOT_READY while the video is %s', async (status) => {
      repo.findOne.mockResolvedValueOnce(
        storedVideo({ processing_status: status }),
      );

      await expect(
        service.getDownloadUrl('user-1', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('should not disclose videos of other users', async () => {
      await expect(
        service.getDownloadUrl('user-2', 'pubVideo001'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
