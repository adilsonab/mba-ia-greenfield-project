export interface PresignedPart {
  part_number: number;
  url: string;
}

export interface UploadedPart {
  part_number: number;
  etag: string;
}

/**
 * Slices `file` by `partSizeBytes` and PUTs each requested part straight to
 * its presigned storage URL — the bytes never go through the API. Returns the
 * `{ part_number, etag }` pairs expected by `POST /videos/:id/upload/complete`.
 */
export async function uploadParts(
  file: Buffer,
  partSizeBytes: number,
  parts: PresignedPart[],
): Promise<UploadedPart[]> {
  const uploaded: UploadedPart[] = [];
  for (const part of parts) {
    const start = (part.part_number - 1) * partSizeBytes;
    const chunk = file.subarray(start, start + partSizeBytes);
    const res = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(chunk),
    });
    const etag = res.headers.get('etag');
    if (!res.ok || !etag) {
      throw new Error(
        `Upload of part ${part.part_number} failed with HTTP ${res.status}`,
      );
    }
    uploaded.push({ part_number: part.part_number, etag });
  }
  return uploaded;
}
