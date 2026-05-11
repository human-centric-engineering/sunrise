'use client';

/**
 * MicLevelMeter — animated bar visualizer driven by a live `MediaStream`.
 *
 * Attaches a Web Audio `AnalyserNode` to the stream and renders N vertical
 * bars whose heights track the time-domain audio level in real time. Gives
 * the user immediate visual confirmation that their mic is being heard.
 *
 * Why bars over a true waveform: scrolling waveforms need a canvas + ring
 * buffer and are visually noisy at the size we render here. Frequency-band
 * bars convey "the mic is alive" with a 60-line component.
 *
 * Cleanup contract: closing the `AudioContext` and disconnecting the source
 * runs on unmount AND whenever the stream identity changes — without the
 * latter, a re-record reuses the prior analyser against a dead stream.
 */

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

export interface MicLevelMeterProps {
  /** Live mic stream from `useVoiceRecording`. When null, renders idle bars. */
  stream: MediaStream | null;
  /** Number of bars to render. Default 7. */
  bars?: number;
  /** Optional class names for the container. */
  className?: string;
}

const DEFAULT_BARS = 7;

export function MicLevelMeter({ stream, bars = DEFAULT_BARS, className }: MicLevelMeterProps) {
  // One ref per bar so we can mutate `transform: scaleY(...)` from rAF
  // without re-rendering React each frame.
  const barRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (!stream) return;
    // Some happy-dom / SSR contexts lack AudioContext entirely.
    const Ctx =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctx) return;

    let cancelled = false;
    let rafId = 0;
    const ctx = new Ctx();
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      // Stream has no audio tracks (shouldn't happen with getUserMedia({audio:true}),
      // but cheap insurance against runtime surprises).
      void ctx.close();
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);

    const freqData = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      if (cancelled) return;
      analyser.getByteFrequencyData(freqData);

      // Map the (binCount) frequency bins down to N bars by averaging the
      // bins that fall inside each bar's slice. The low end is where speech
      // energy lives, so we cap at ~3/4 of the spectrum to avoid wasting
      // bars on near-silent high frequencies.
      const usable = Math.floor(freqData.length * 0.75);
      const sliceSize = Math.max(1, Math.floor(usable / bars));

      for (let i = 0; i < bars; i++) {
        const start = i * sliceSize;
        const end = Math.min(start + sliceSize, usable);
        let sum = 0;
        for (let j = start; j < end; j++) sum += freqData[j];
        const avg = sum / (end - start || 1);
        // Normalize 0..255 → 0..1, then floor so bars never fully collapse
        // (a flat row looks broken; tiny minimum reads as "idle but live").
        const level = Math.max(0.08, avg / 255);
        const el = barRefs.current[i];
        if (el) el.style.transform = `scaleY(${level.toFixed(3)})`;
      }

      rafId = window.requestAnimationFrame(tick);
    }

    rafId = window.requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      try {
        source?.disconnect();
        analyser.disconnect();
      } catch {
        // Already disconnected — ignore.
      }
      void ctx.close().catch(() => {
        // Closing a context that's already closed throws in some browsers.
      });
    };
  }, [stream, bars]);

  return (
    <div
      className={cn('flex h-5 items-center gap-[3px]', className)}
      aria-hidden="true"
      data-testid="mic-level-meter"
    >
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="bg-primary inline-block h-full w-[3px] origin-center rounded-full"
          style={{ transform: 'scaleY(0.15)' }}
        />
      ))}
    </div>
  );
}
