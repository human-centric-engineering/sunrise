/**
 * processImage — EXIF orientation (#1152)
 *
 * Runs against real sharp (image.test.ts mocks it entirely), so the assertions
 * are about the pixels and dimensions that come out, not about which sharp
 * methods were called.
 */
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';

import { processImage } from '@/lib/storage/image';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** A 2-wide x 4-tall (sensor order) JPEG: top half red, bottom half blue. */
async function makeSensorOrderJpeg(orientation?: number): Promise<Buffer> {
  const raw = Buffer.from([
    // 2 x 4 RGB, row by row: two red rows, two blue rows
    ...[255, 0, 0, 255, 0, 0],
    ...[255, 0, 0, 255, 0, 0],
    ...[0, 0, 255, 0, 0, 255],
    ...[0, 0, 255, 0, 0, 255],
  ]);
  const image = sharp(raw, { raw: { width: 2, height: 4, channels: 3 } }).jpeg({ quality: 100 });
  return orientation ? image.withMetadata({ orientation }).toBuffer() : image.toBuffer();
}

async function dominantAt(buffer: Buffer, left: number, top: number): Promise<'red' | 'blue'> {
  const { data } = await sharp(buffer)
    .extract({ left, top, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data[0] > data[2] ? 'red' : 'blue';
}

describe('processImage — EXIF orientation', () => {
  it('stores a photo tagged orientation 6 upright, with upright dimensions', async () => {
    const tagged = await makeSensorOrderJpeg(6);
    expect((await sharp(tagged).metadata()).orientation).toBe(6);

    const result = await processImage(tagged, { maxWidth: 100, maxHeight: 100, fit: 'inside' });

    // 2x4 in sensor order is 4x2 once turned upright
    expect({ width: result.width, height: result.height }).toEqual({ width: 4, height: 2 });
    const stored = await sharp(result.buffer).metadata();
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 4, height: 2 });
  });

  it('turns the pixels, not just the dimensions', async () => {
    // Orientation 6 = rotate 90° clockwise to display: the sensor-order top
    // (red) ends up on the right, the bottom (blue) on the left.
    const result = await processImage(await makeSensorOrderJpeg(6), {
      maxWidth: 100,
      maxHeight: 100,
      fit: 'inside',
      format: 'png',
    });

    expect(await dominantAt(result.buffer, 0, 0)).toBe('blue');
    expect(await dominantAt(result.buffer, 3, 0)).toBe('red');
  });

  it('centre-crops the upright image to a square', async () => {
    // Upright it is 4x2 (blue left, red right), so the 2x2 centre crop keeps
    // one column of each. Cropped from the sensor-order 2x4 it would be a
    // single colour.
    const result = await processImage(await makeSensorOrderJpeg(6), {
      maxWidth: 500,
      maxHeight: 500,
      format: 'png',
    });

    expect({ width: result.width, height: result.height }).toEqual({ width: 2, height: 2 });
    expect(await dominantAt(result.buffer, 0, 0)).toBe('blue');
    expect(await dominantAt(result.buffer, 1, 0)).toBe('red');
  });

  it('fits the bounding box against the upright shape', async () => {
    // Upright 4x2 inside a 2x2 box scales to 2x1. Against the sensor-order
    // 2x4 it would come out 1x2.
    const result = await processImage(await makeSensorOrderJpeg(6), {
      maxWidth: 2,
      maxHeight: 2,
      fit: 'inside',
    });

    expect({ width: result.width, height: result.height }).toEqual({ width: 2, height: 1 });
  });

  it('leaves an untagged image unchanged, so a caller that pre-rotates is not turned twice', async () => {
    const untagged = await makeSensorOrderJpeg();
    const result = await processImage(untagged, {
      maxWidth: 100,
      maxHeight: 100,
      fit: 'inside',
      format: 'png',
    });

    expect({ width: result.width, height: result.height }).toEqual({ width: 2, height: 4 });
    expect(await dominantAt(result.buffer, 0, 0)).toBe('red');
    expect(await dominantAt(result.buffer, 0, 3)).toBe('blue');
  });

  it('leaves an image tagged orientation 1 (already upright) unchanged', async () => {
    const result = await processImage(await makeSensorOrderJpeg(1), {
      maxWidth: 100,
      maxHeight: 100,
      fit: 'inside',
    });

    expect({ width: result.width, height: result.height }).toEqual({ width: 2, height: 4 });
  });
});
