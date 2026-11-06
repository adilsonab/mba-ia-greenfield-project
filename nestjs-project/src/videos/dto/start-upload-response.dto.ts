import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingStatus, VideoStatus } from '../entities/video.entity';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description:
      'Presigned UploadPart URL — send `PUT` with the raw bytes of this part and keep the `ETag` response header',
  })
  url: string;
}

export class UploadPlanDto {
  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 2 })
  part_count: number;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];
}

export class StartUploadResponseDto {
  @ApiProperty({ example: 'kq3Fz9_aB1c', minLength: 11, maxLength: 11 })
  public_id: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    enum: VideoProcessingStatus,
    example: VideoProcessingStatus.AWAITING_UPLOAD,
  })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
