import { ApiProperty } from '@nestjs/swagger';
import { UploadPartUrlDto } from './start-upload-response.dto';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size_bytes: number;
}

export class ResumeUploadResponseDto {
  @ApiProperty({ example: 'kq3Fz9_aB1c' })
  public_id: string;

  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 2 })
  part_count: number;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;

  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Parts already stored (from ListParts)',
  })
  uploaded_parts: UploadedPartDto[];

  @ApiProperty({
    type: [UploadPartUrlDto],
    description: 'Fresh presigned URLs for the part numbers not uploaded yet',
  })
  parts: UploadPartUrlDto[];
}
