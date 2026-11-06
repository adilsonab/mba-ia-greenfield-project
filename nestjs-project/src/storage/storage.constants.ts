/** Deterministic object keys per video (phase-03-videos/TD-04). */
export const videoOriginalKey = (videoId: string): string =>
  `videos/${videoId}/original`;

export const videoThumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;
