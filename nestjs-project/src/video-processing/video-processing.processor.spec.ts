import { readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { MediaProbeService } from '../media/media-probe.service';
import { UnsupportedMediaError } from '../media/media.types';
import { ThumbnailService } from '../media/thumbnail.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import type { VideoProcessJobData } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

const probeResult = {
  duration_seconds: 3,
  width: 1920,
  height: 1080,
  video_codec: 'h264',
  audio_codec: 'aac',
  bitrate: 286269,
  container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
  raw: { format: {} },
};

function job(
  overrides: Partial<Job<VideoProcessJobData>> = {},
): Job<VideoProcessJobData> {
  return {
    data: { videoId: 'video-1' },
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job<VideoProcessJobData>;
}

async function leftoverWorkDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((d) =>
    d.startsWith('video-video-1-'),
  );
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let repo: { findOneBy: jest.Mock; update: jest.Mock; save: jest.Mock };
  let storage: {
    downloadToFile: jest.Mock;
    putObject: jest.Mock;
  };
  let probe: { probe: jest.Mock };
  let thumbnails: { extractFrame: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'video-1',
        storage_key: 'videos/video-1/original',
        processing_status: VideoProcessingStatus.PROCESSING,
      }),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn((v: Video) => Promise.resolve(v)),
    };
    storage = {
      downloadToFile: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    probe = { probe: jest.fn().mockResolvedValue(probeResult) };
    thumbnails = {
      // Writes the JPEG the processor will read back.
      extractFrame: jest.fn((_in: string, out: string) =>
        writeFile(out, Buffer.from([0xff, 0xd8, 0xff])),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: MediaProbeService, useValue: probe },
        { provide: ThumbnailService, useValue: thumbnails },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  describe('process', () => {
    it('should mark processing, probe, upload the thumbnail and save the ready video', async () => {
      await processor.process(job());

      expect(repo.update).toHaveBeenCalledWith('video-1', {
        processing_status: VideoProcessingStatus.PROCESSING,
      });
      expect(storage.downloadToFile).toHaveBeenCalledWith(
        'videos/video-1/original',
        expect.any(String),
      );
      expect(thumbnails.extractFrame).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/thumbnail\.jpg$/),
        3,
      );
      expect(storage.putObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          processing_status: VideoProcessingStatus.READY,
          processing_error: null,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          duration_seconds: 3,
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          metadata: probeResult.raw,
        }),
      );
    });

    it('should finish without changes when the video no longer exists', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await processor.process(job());

      expect(repo.update).not.toHaveBeenCalled();
      expect(storage.downloadToFile).not.toHaveBeenCalled();
    });

    it('should finish without changes when the video is already ready (re-delivery)', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'video-1',
        processing_status: VideoProcessingStatus.READY,
      });

      await processor.process(job());

      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should turn an unsupported media error into UnrecoverableError (no retry)', async () => {
      probe.probe.mockRejectedValueOnce(
        new UnsupportedMediaError('moov atom not found'),
      );

      const error = await processor.process(job()).catch((e: Error) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe(
        'Unsupported or corrupt media: moov atom not found',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should rethrow transient errors so BullMQ retries them', async () => {
      storage.downloadToFile.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(processor.process(job())).rejects.toThrow('socket hang up');
    });

    it('should remove the temporary work directory even when processing fails', async () => {
      probe.probe.mockRejectedValueOnce(new Error('boom'));

      await expect(processor.process(job())).rejects.toThrow('boom');

      expect(await leftoverWorkDirs()).toEqual([]);
    });
  });

  describe('onFailed', () => {
    it('should keep the video processing while retries remain', async () => {
      await processor.onFailed(job({ attemptsMade: 1 }), new Error('timeout'));

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should mark the video failed after the last attempt', async () => {
      await processor.onFailed(job({ attemptsMade: 3 }), new Error('timeout'));

      expect(repo.update).toHaveBeenCalledWith('video-1', {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'Processing failed after 3 attempts: timeout',
      });
    });

    it('should mark the video failed immediately on UnrecoverableError', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1 }),
        new UnrecoverableError('Unsupported or corrupt media: bad file'),
      );

      expect(repo.update).toHaveBeenCalledWith('video-1', {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'Unsupported or corrupt media: bad file',
      });
    });

    it('should never throw from the background handler', async () => {
      repo.update.mockRejectedValueOnce(new Error('db down'));

      await expect(
        processor.onFailed(job({ attemptsMade: 3 }), new Error('timeout')),
      ).resolves.toBeUndefined();
    });
  });
  describe('onError', () => {
    it('should log worker connection errors without throwing', () => {
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      expect(() =>
        processor.onError(new Error('Connection is closed.')),
      ).not.toThrow();
      expect(logged).toHaveBeenCalledWith(
        'Worker error: Connection is closed.',
      );
      logged.mockRestore();
    });
  });
});
