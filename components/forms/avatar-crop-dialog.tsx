'use client';

/**
 * Avatar Crop Dialog
 *
 * Modal dialog for cropping an image to a circular avatar.
 * Users can pan and zoom to select the visible area.
 */

import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { ZoomIn, ZoomOut } from 'lucide-react';

interface AvatarCropDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Image source URL (object URL from file selection) */
  imageSrc: string;
  /** Called when user confirms the crop */
  onConfirm: (croppedBlob: Blob) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const OUTPUT_SIZE = 500;

/**
 * Extract the cropped area from the image as a JPEG Blob
 */
async function getCroppedBlob(imageSrc: string, pixelCrop: Area): Promise<Blob> {
  const image = new Image();
  image.crossOrigin = 'anonymous';

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed to load image'));
    image.src = imageSrc;
  });

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to create image blob'));
        }
      },
      'image/jpeg',
      0.9
    );
  });
}

export function AvatarCropDialog({ open, imageSrc, onConfirm, onCancel }: AvatarCropDialogProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const onCropComplete = useCallback((_croppedArea: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels);
  }, []);

  const handleConfirm = async () => {
    if (!croppedAreaPixels) return;

    setIsProcessing(true);
    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels);
      onConfirm(blob);
    } catch {
      onCancel();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleZoomChange = (value: number[]) => {
    setZoom(value[0]);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Crop Avatar</DialogTitle>
          <DialogDescription>
            Drag to reposition and use the slider to zoom in or out.
          </DialogDescription>
        </DialogHeader>

        {/* Cropper area */}
        <div className="relative h-64 w-full overflow-hidden rounded-md bg-black">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>

        {/* Zoom control */}
        <div className="flex items-center gap-3 px-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
            className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition-colors"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <Slider
            value={[zoom]}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            onValueChange={handleZoomChange}
            aria-label="Zoom"
          />
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
            className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition-colors"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isProcessing}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleConfirm()} disabled={isProcessing}>
            {isProcessing ? 'Processing...' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
