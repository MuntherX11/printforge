'use client';

import { useState, useRef, useEffect } from 'react';
import { Camera, CameraOff, Maximize2, X, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CameraViewerProps {
  printerId: string;
  printerName?: string;
  /** compact = small card with expand button; full = full-size feed */
  variant?: 'compact' | 'full';
}

/**
 * Displays a live MJPEG camera feed proxied through /api/printers/:id/camera/stream.
 * Uses a plain <img> tag — browsers handle MJPEG natively via multipart/x-mixed-replace.
 */
export function CameraViewer({ printerId, printerName, variant = 'full' }: CameraViewerProps) {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const streamUrl = `/api/printers/${printerId}/camera/stream`;

  // Reload the stream (reconnect)
  function reload() {
    setError(false);
    setLoaded(false);
    if (imgRef.current) {
      imgRef.current.src = '';
      // Small delay so the browser actually resets
      setTimeout(() => { if (imgRef.current) imgRef.current.src = streamUrl; }, 100);
    }
  }

  // Stop stream when component unmounts or leaves viewport
  useEffect(() => {
    return () => { if (imgRef.current) imgRef.current.src = ''; };
  }, []);

  if (variant === 'compact') {
    return (
      <>
        <div className="relative bg-black rounded-lg overflow-hidden aspect-video group">
          {!error ? (
            <>
              {!loaded && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                  <Camera className="h-6 w-6 animate-pulse" />
                </div>
              )}
              <img
                ref={imgRef}
                src={streamUrl}
                alt={`${printerName ?? 'Printer'} camera`}
                className="w-full h-full object-contain"
                onLoad={() => setLoaded(true)}
                onError={() => setError(true)}
              />
              <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                <button
                  onClick={() => setFullscreen(true)}
                  className="bg-black/60 text-white rounded p-1 hover:bg-black/80"
                  title="Fullscreen"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500">
              <CameraOff className="h-6 w-6" />
              <p className="text-xs">Camera offline</p>
              <button onClick={reload} className="text-xs text-brand-500 hover:underline">Retry</button>
            </div>
          )}
        </div>

        {/* Fullscreen modal */}
        {fullscreen && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
            onClick={() => setFullscreen(false)}
          >
            <button
              className="absolute top-4 right-4 text-white bg-black/50 rounded-full p-2 hover:bg-black/70"
              onClick={() => setFullscreen(false)}
            >
              <X className="h-5 w-5" />
            </button>
            {printerName && (
              <p className="absolute top-4 left-4 text-white font-semibold text-sm">{printerName}</p>
            )}
            <img
              src={streamUrl}
              alt={`${printerName ?? 'Printer'} camera`}
              className="max-w-full max-h-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  }

  // Full variant
  return (
    <div className="relative bg-black rounded-xl overflow-hidden w-full aspect-video">
      {!error ? (
        <>
          {!loaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-600">
              <Camera className="h-8 w-8 animate-pulse" />
              <p className="text-sm">Connecting to camera…</p>
            </div>
          )}
          <img
            ref={imgRef}
            src={streamUrl}
            alt={`${printerName ?? 'Printer'} camera feed`}
            className="w-full h-full object-contain"
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
          />
          {loaded && (
            <div className="absolute bottom-2 right-2">
              <button
                onClick={reload}
                className="bg-black/50 text-white rounded p-1.5 hover:bg-black/70"
                title="Reconnect stream"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {loaded && (
            <span className="absolute top-2 left-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide">
              Live
            </span>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500">
          <CameraOff className="h-10 w-10" />
          <p className="text-sm">Camera unavailable</p>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="h-4 w-4 mr-1" /> Reconnect
          </Button>
        </div>
      )}
    </div>
  );
}
