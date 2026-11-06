/**
 * Storage-level errors. They describe what the object storage reported and
 * know nothing about videos; callers translate them into domain exceptions.
 */
export class StorageUploadNotFoundError extends Error {
  constructor(public readonly uploadId: string) {
    super(`Multipart upload ${uploadId} does not exist`);
    this.name = 'StorageUploadNotFoundError';
  }
}

export class StorageInvalidPartError extends Error {
  constructor(public readonly reason: string) {
    super(`Multipart upload parts were rejected: ${reason}`);
    this.name = 'StorageInvalidPartError';
  }
}
