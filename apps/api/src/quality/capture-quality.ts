export interface QualityIssue {
  code: string;
  /** Shown to the end user by the SDK. */
  message: string;
}

const MIN_BYTES = 20 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Server-side gate on uploads. Only format and size for now; blur, glare, framing and
 * face-count checks belong in the image analysis service (Python/OpenCV) and in the SDK.
 */
export function checkCaptureQuality(image: Buffer): { mimeType: string | null; issues: QualityIssue[] } {
  const mimeType = detectImageType(image);
  const issues: QualityIssue[] = [];
  if (!mimeType) {
    issues.push({ code: 'unsupported_format', message: 'Formato de imagem não suportado. Use a câmera para capturar.' });
  }
  if (image.length < MIN_BYTES) {
    issues.push({
      code: 'low_resolution',
      message: 'A imagem ficou pequena demais. Aproxime a câmera e procure um lugar mais iluminado.',
    });
  }
  if (image.length > MAX_BYTES) {
    issues.push({ code: 'file_too_large', message: 'A imagem é grande demais. Tente capturar novamente.' });
  }
  return { mimeType, issues };
}

export function detectImageType(image: Buffer): string | null {
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return 'image/jpeg';
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
