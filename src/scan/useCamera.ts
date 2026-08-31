import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus = 'idle' | 'starting' | 'live' | 'unsupported' | 'denied' | 'error';

export interface CameraState {
  status: CameraStatus;
  message: string | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  start: () => void;
  stop: () => void;
  /** Grabs the current frame at the sensor's full resolution. */
  capture: () => HTMLCanvasElement | null;
}

/**
 * Rear-camera access for the scanner.
 *
 * getUserMedia is only available in a secure context, so this reports
 * `unsupported` over plain HTTP on a LAN address — the exact case of a phone
 * pointed at a dev server. The scanner offers photo import as the fallback,
 * which works everywhere.
 */
export function useCamera(): CameraState {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const stop = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus('idle');
  }, []);

  const start = useCallback(() => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      setMessage(
        window.isSecureContext
          ? 'This browser does not expose a camera.'
          : 'The camera needs a secure connection (https, or localhost). Import photos instead.',
      );
      return;
    }

    setStatus('starting');
    setMessage(null);

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // Ask for detail: a page of music has small print, and the warp
            // samples from this frame.
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        setStatus('live');
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('denied');
          setMessage('Camera access was blocked. Allow it in the browser’s site settings, or import photos instead.');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setStatus('error');
          setMessage('No camera was found on this device. Import photos instead.');
        } else {
          setStatus('error');
          setMessage(err instanceof Error ? err.message : 'The camera could not be started.');
        }
      }
    })();
  }, []);

  const capture = useCallback((): HTMLCanvasElement | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return canvas;
  }, []);

  useEffect(() => stop, [stop]);

  return { status, message, videoRef, start, stop, capture };
}
