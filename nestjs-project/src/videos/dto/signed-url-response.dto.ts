import { ApiProperty } from '@nestjs/swagger';

/** Short-lived presigned URL served directly by the object storage. */
export class SignedUrlResponseDto {
  @ApiProperty({
    description:
      'Presigned GET URL — the storage answers Range requests with 206 Partial Content',
  })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}
