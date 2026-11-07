import { ApiProperty } from '@nestjs/swagger';
import { VideoProcessingStatus } from '../entities/video.entity';

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'kq3Fz9_aB1c' })
  public_id: string;

  @ApiProperty({
    enum: [VideoProcessingStatus.PROCESSING],
    example: VideoProcessingStatus.PROCESSING,
  })
  processing_status: VideoProcessingStatus;
}
