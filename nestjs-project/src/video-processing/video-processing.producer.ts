import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  private readonly logger = new Logger(VideoProcessingProducer.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {
    // BullMQ "Going to production": without an `error` listener a Redis
    // connection error (e.g. "Connection is closed") is an unhandled
    // EventEmitter error that crashes the process. Background event handler:
    // log only; `enqueue` still rejects for its caller.
    this.queue.on('error', (error: Error) => {
      this.logger.error(
        `Queue ${VIDEO_PROCESSING_QUEUE} error: ${error.message}`,
      );
    });
  }

  /**
   * Publishes `video.process`. `jobId = videoId`, so enqueueing the same video
   * twice while the job exists is ignored by BullMQ (phase-03-videos/TD-12).
   */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId });
  }
}
