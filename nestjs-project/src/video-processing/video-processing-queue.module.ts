import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videosConfig from '../config/videos.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

/**
 * Registers the `video-processing` queue and its producer. Imported by the API
 * (producer side) and by the worker (consumer side, SI-03.9). The root Redis
 * connection (`BullModule.forRootAsync`) is registered by the host module.
 */
@Module({
  imports: [
    BullModule.registerQueueAsync({
      name: VIDEO_PROCESSING_QUEUE,
      inject: [videosConfig.KEY],
      useFactory: (config: ConfigType<typeof videosConfig>) => ({
        defaultJobOptions: {
          attempts: config.processingAttempts,
          backoff: { type: 'exponential', delay: config.processingBackoffMs },
          removeOnComplete: true,
          // Failed jobs stay in Redis for inspection; the DB row is the durable record.
          removeOnFail: false,
        },
      }),
    }),
  ],
  providers: [VideoProcessingProducer],
  exports: [BullModule, VideoProcessingProducer],
})
export class VideoProcessingQueueModule {}
