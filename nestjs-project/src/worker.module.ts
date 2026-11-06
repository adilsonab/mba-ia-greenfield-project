import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import videosConfig from './config/videos.config';
import { typeOrmRootModule } from './database/typeorm-root.module';
import { queueRootModule } from './video-processing/queue-root.module';
import { VideoProcessingWorkerModule } from './video-processing/video-processing-worker.module';

/**
 * Root module of the video worker process (phase-03-videos/TD-06): same
 * codebase and conventions as the API, but no HTTP layer — no controllers,
 * auth, mail or throttling.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig, videosConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    typeOrmRootModule(),
    queueRootModule(),
    VideoProcessingWorkerModule,
  ],
})
export class WorkerModule {}
