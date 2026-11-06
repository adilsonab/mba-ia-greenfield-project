import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Consumer side of `video-processing`. Imported only by WorkerModule, so the
 * API process never registers the processor (phase-03-videos/TD-06).
 * UsersModule (which imports ChannelsModule) registers the User and Channel
 * entities that Video's relation graph needs, from their owning modules.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    UsersModule,
    VideoProcessingQueueModule,
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessingProcessor],
})
export class VideoProcessingWorkerModule {}
