import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
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
import { videoOriginalKey } from '../storage/storage.constants';
import {
  StorageInvalidPartError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { ResumeUploadResponseDto } from './dto/resume-upload-response.dto';
import type { SignedUrlResponseDto } from './dto/signed-url-response.dto';
import type { StartUploadDto } from './dto/start-upload.dto';
import {
  toVideoDetailResponse,
  type VideoDetailResponseDto,
} from './dto/video-detail-response.dto';
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
    private readonly processingProducer: VideoProcessingProducer,
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

  /**
   * Completes the multipart upload, verifies the stored object and enqueues
   * processing (phase-03-videos/TD-09, TD-10). Order: complete → HeadObject →
   * enqueue → status write; the worker also sets `processing` when it starts,
   * so a crash between enqueue and the write self-heals.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    const uploadId = this.requireUploadInProgress(video);

    const partCount = Math.ceil(
      video.declared_size_bytes / this.config.uploadPartSizeBytes,
    );
    if (!this.coversWholePlan(dto, partCount)) {
      throw new UploadIncompleteException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        dto.parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
      );
    } catch (error) {
      if (error instanceof StorageInvalidPartError) {
        throw new UploadIncompleteException();
      }
      if (error instanceof StorageUploadNotFoundError) {
        throw new UploadExpiredException();
      }
      throw error;
    }

    const stored = await this.storageService.headObject(video.storage_key);
    if (!stored) {
      throw new Error(
        `Object ${video.storage_key} missing right after completing its upload`,
      );
    }

    if (stored.contentLength !== video.declared_size_bytes) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.update(video.id, {
        upload_id: null,
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: `Uploaded size ${stored.contentLength} bytes does not match the declared ${video.declared_size_bytes} bytes`,
      });
      throw new UploadSizeMismatchException();
    }

    await this.processingProducer.enqueue(video.id);
    await this.videoRepository.update(video.id, {
      size_bytes: stored.contentLength,
      upload_id: null,
      processing_status: VideoProcessingStatus.PROCESSING,
    });

    return {
      public_id: video.public_id,
      processing_status: VideoProcessingStatus.PROCESSING,
    };
  }

  /** `parts` must list each part number of the plan exactly once. */
  private coversWholePlan(dto: CompleteUploadDto, partCount: number): boolean {
    const numbers = new Set(dto.parts.map((p) => p.part_number));
    if (numbers.size !== dto.parts.length || numbers.size !== partCount) {
      return false;
    }
    return partNumbersUpTo(partCount).every((n) => numbers.has(n));
  }

  /**
   * Owner-facing detail: status lifecycle, extracted metadata and a presigned
   * thumbnail URL when one exists (phase-03-videos/TD-11, TD-14).
   */
  async getDetail(
    userId: string,
    publicId: string,
  ): Promise<VideoDetailResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    const thumbnailUrl = video.thumbnail_key
      ? (await this.storageService.presignGetObject(video.thumbnail_key)).url
      : null;
    return toVideoDetailResponse(video, thumbnailUrl);
  }

  /**
   * Short-lived URL the player loads directly from the storage, which serves
   * Range requests with 206 — no video bytes through the API
   * (phase-03-videos/TD-14, TD-15).
   */
  async getStreamUrl(
    userId: string,
    publicId: string,
  ): Promise<SignedUrlResponseDto> {
    const video = await this.findOwnedReadyVideo(userId, publicId);
    const signed = await this.storageService.presignGetObject(
      video.storage_key,
    );
    return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
  }

  /** Stream/download are only available once processing finished (TD-15). */
  private async findOwnedReadyVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.processing_status !== VideoProcessingStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
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
