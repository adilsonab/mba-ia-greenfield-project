import { ApiProperty } from '@nestjs/swagger';
import {
  type Video,
  VideoProcessingStatus,
  VideoStatus,
} from '../entities/video.entity';

export class VideoDetailResponseDto {
  @ApiProperty({ example: 'kq3Fz9_aB1c' })
  public_id: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.READY,
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ type: String, nullable: true, example: null })
  processing_error: string | null;

  @ApiProperty({ example: 'aula.mp4' })
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ type: Number, nullable: true, example: 134217728 })
  size_bytes: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 3.025 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 4500000 })
  bitrate: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  container_format: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned GET of the thumbnail (1h); null until one exists',
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}

/**
 * Builds the public view of a video. Internal fields (`id`, `channel_id`,
 * storage keys, `upload_id`, `declared_size_bytes`, raw `metadata`) are never
 * copied (### API Contracts → GET /videos/:publicId).
 */
export function toVideoDetailResponse(
  video: Video,
  thumbnailUrl: string | null,
): VideoDetailResponseDto {
  return {
    public_id: video.public_id,
    title: video.title,
    status: video.status,
    processing_status: video.processing_status,
    processing_error: video.processing_error,
    original_file_name: video.original_file_name,
    content_type: video.content_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    bitrate: video.bitrate,
    container_format: video.container_format,
    thumbnail_url: thumbnailUrl,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}
