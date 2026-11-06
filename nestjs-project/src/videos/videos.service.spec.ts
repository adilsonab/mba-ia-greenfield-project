import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
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
  };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    presignExpiresSeconds: number;
  };

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
});
