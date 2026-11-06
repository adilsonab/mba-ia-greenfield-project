import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { MediaProbeService } from '../media/media-probe.service';
import { type ProbeResult, UnsupportedMediaError } from '../media/media.types';
import { ThumbnailService } from '../media/thumbnail.service';
import { videoThumbnailKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessJobData,
} from './video-processing.constants';

const MAX_ERROR_LENGTH = 1000;

/**
 * Consumes `video.process` (### Events/Messages). Registered only in the
 * worker process (phase-03-videos/TD-06) — the API never consumes jobs.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbe: MediaProbeService,
    private readonly thumbnails: ThumbnailService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    // 1. Idempotent re-delivery: nothing to do for deleted or finished videos.
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video || video.processing_status === VideoProcessingStatus.READY) {
      return;
    }

    // 2. Self-heals the producer's crash window between enqueue and status write.
    await this.videoRepository.update(video.id, {
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    const workDir = await mkdtemp(join(tmpdir(), `video-${video.id}-`));
    try {
      // 3. Download the original.
      const input = join(workDir, 'original');
      await this.storageService.downloadToFile(video.storage_key, input);

      // 4. Metadata (phase-03-videos/TD-07, validation.md AMB-1).
      const probe = await this.probeOrFailPermanently(input);

      // 5. Thumbnail at a deterministic key — retries overwrite it (TD-04).
      const thumbnailPath = join(workDir, 'thumbnail.jpg');
      await this.thumbnails.extractFrame(
        input,
        thumbnailPath,
        probe.duration_seconds,
      );
      const thumbnailKey = videoThumbnailKey(video.id);
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      // 6. Ready. `save` (not `update`): QueryDeepPartialEntity rejects the
      // Record<string, unknown> type of the jsonb `metadata` column.
      Object.assign(video, {
        duration_seconds: probe.duration_seconds,
        width: probe.width,
        height: probe.height,
        video_codec: probe.video_codec,
        audio_codec: probe.audio_codec,
        bitrate: probe.bitrate,
        container_format: probe.container_format,
        metadata: probe.raw,
        thumbnail_key: thumbnailKey,
        processing_status: VideoProcessingStatus.READY,
        processing_error: null,
      });
      await this.videoRepository.save(video);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Fires on every failed attempt (BullMQ). Marks the video `failed` only when
   * no retry will follow — UnrecoverableError or attempts exhausted
   * (phase-03-videos/TD-12). Background handler: never rethrows.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const unrecoverable =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError';
    if (!unrecoverable && job.attemptsMade < attempts) {
      return; // a retry is scheduled; the video stays `processing`
    }

    const reason = unrecoverable
      ? error.message
      : `Processing failed after ${job.attemptsMade} attempts: ${error.message}`;
    try {
      await this.videoRepository.update(job.data.videoId, {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: reason.slice(0, MAX_ERROR_LENGTH),
      });
    } catch (updateError) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${(updateError as Error).message}`,
      );
    }
  }

  private async probeOrFailPermanently(filePath: string): Promise<ProbeResult> {
    try {
      return await this.mediaProbe.probe(filePath);
    } catch (error) {
      if (error instanceof UnsupportedMediaError) {
        // Retrying a corrupt / non-video file can never succeed.
        throw new UnrecoverableError(
          `Unsupported or corrupt media: ${error.message}`,
        );
      }
      throw error;
    }
  }
}
