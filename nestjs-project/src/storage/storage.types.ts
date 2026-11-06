export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
}

export interface StoredObjectInfo {
  contentLength: number;
  contentType: string | undefined;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}
