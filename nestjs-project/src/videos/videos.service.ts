import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UploadExpiredException,
  VideoNotFoundException,
  VideoUploadNotInProgressException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { ResumeUploadResponseDto } from './dto/resume-upload-response.dto';
import type { StartUploadDto } from './dto/start-upload.dto';
import type { StartUploadResponseDto } from './dto/start-upload-response.dto';
import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from './entities/video.entity';
import { defaultTitleFromFileName, generatePublicId } from './public-id.util';
import {
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes('public_id')
  );
}

function partNumbersUpTo(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft in the caller's channel and opens the
   * multipart upload (phase-03-videos/TD-08, TD-10, TD-11, TD-13).
   */
  async startUpload(
    userId: string,
    dto: StartUploadDto,
  ): Promise<StartUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every registered user owns a channel (Phase 02); absence is a broken invariant.
      throw new Error(`User ${userId} has no channel`);
    }

    const partSize = this.config.uploadPartSizeBytes;
    const partCount = Math.ceil(dto.size_bytes / partSize);
    const title =
      dto.title ??
      defaultTitleFromFileName(dto.file_name, VIDEO_TITLE_MAX_LENGTH);

    const video = await this.insertDraft({
      channel_id: channel.id,
      title,
      original_file_name: dto.file_name,
      content_type: dto.content_type,
      declared_size_bytes: dto.size_bytes,
    });

    try {
      const uploadId = await this.storageService.createMultipartUpload(
        video.storage_key,
        dto.content_type,
      );
      await this.videoRepository.update(video.id, { upload_id: uploadId });

      const expiresAt = new Date(
        Date.now() + this.partUrlExpiresSeconds() * 1000,
      );
      const parts = await this.storageService.presignUploadParts(
        video.storage_key,
        uploadId,
        partNumbersUpTo(partCount),
        this.partUrlExpiresSeconds(),
      );

      return {
        public_id: video.public_id,
        title: video.title,
        status: video.status,
        processing_status: video.processing_status,
        upload: {
          part_size_bytes: partSize,
          part_count: partCount,
          expires_at: expiresAt.toISOString(),
          parts: parts.map((p) => ({ part_number: p.partNumber, url: p.url })),
        },
      };
    } catch (error) {
      // Compensation: a draft without a multipart upload can never be completed.
      await this.videoRepository.delete(video.id);
      throw error;
    }
  }

  /**
   * Loads a video owned by the caller. Missing videos and videos of other
   * users both raise VIDEO_NOT_FOUND, so a draft's existence is never
   * disclosed (### Authorization Matrix, phase-03-videos/TD-15).
   */
  async findOwnedByPublicId(userId: string, publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * Resume support: lists the stored parts and re-signs only the missing ones
   * (phase-03-videos/TD-08, TD-10).
   */
  async resumeUpload(
    userId: string,
    publicId: string,
  ): Promise<ResumeUploadResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    const uploadId = this.requireUploadInProgress(video);

    const partSize = this.config.uploadPartSizeBytes;
    const partCount = Math.ceil(video.declared_size_bytes / partSize);

    let uploaded: Awaited<ReturnType<StorageService['listParts']>>;
    try {
      uploaded = await this.storageService.listParts(
        video.storage_key,
        uploadId,
      );
    } catch (error) {
      if (error instanceof StorageUploadNotFoundError) {
        throw new UploadExpiredException();
      }
      throw error;
    }

    const uploadedNumbers = new Set(uploaded.map((p) => p.partNumber));
    const missing = partNumbersUpTo(partCount).filter(
      (n) => !uploadedNumbers.has(n),
    );
    const expiresIn = this.partUrlExpiresSeconds();
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const parts = await this.storageService.presignUploadParts(
      video.storage_key,
      uploadId,
      missing,
      expiresIn,
    );

    return {
      public_id: video.public_id,
      part_size_bytes: partSize,
      part_count: partCount,
      expires_at: expiresAt.toISOString(),
      uploaded_parts: uploaded.map((p) => ({
        part_number: p.partNumber,
        etag: p.etag,
        size_bytes: p.sizeBytes,
      })),
      parts: parts.map((p) => ({ part_number: p.partNumber, url: p.url })),
    };
  }

  /** Only `awaiting_upload` videos have an open multipart upload. */
  private requireUploadInProgress(video: Video): string {
    if (video.processing_status !== VideoProcessingStatus.AWAITING_UPLOAD) {
      throw new VideoUploadNotInProgressException();
    }
    if (!video.upload_id) {
      // awaiting_upload without an upload id cannot be resumed or completed.
      throw new UploadExpiredException();
    }
    return video.upload_id;
  }

  /** Part URLs expire after the configured presign window (TD-10 default 1h). */
  private partUrlExpiresSeconds(): number {
    return this.storageService.presignExpiresSeconds;
  }

  /** Inserts the draft, retrying with a new `public_id` on the rare collision (TD-13). */
  private async insertDraft(
    fields: Pick<
      Video,
      | 'channel_id'
      | 'title'
      | 'original_file_name'
      | 'content_type'
      | 'declared_size_bytes'
    >,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      const id = randomUUID();
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            id,
            public_id: generatePublicId(),
            status: VideoStatus.DRAFT,
            processing_status: VideoProcessingStatus.AWAITING_UPLOAD,
            storage_key: videoOriginalKey(id),
          }),
        );
      } catch (error) {
        if (!isPublicIdCollision(error) || attempt >= PUBLIC_ID_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }
}
