'use client';

import { useState, useRef, useEffect } from 'react';
import { Camera, CameraOff, Maximize2, X, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CameraViewerProps {
  printerId: string;
  printerName?: string;
  /** compact = small card with expand button; full = full-size feed */
  variant?: 'compact' | 'full';
  /**
   * Raw camera URL stored on the printer (e.g. "http://192.168.1.5:8000").
   * Used as iframe fallback for WebRTC-only cameras that can't be proxied
   * server-side but have no X-Frame-Options restrictions.
   */
  cameraUrl?: string;
}

/** Normalise a stored URL — prepend http:// when the scheme is missing. */
function normaliseUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `http://${url}`;
}

/**
 * Displays a live camera feed proxied through /api/printers/:id/camera/stream.
 *
 * Auto-detects stream type:
 *   1. Tries <img> first — handles MJPEG (multipart/x-mixed-replace).
 *   2. On error, falls back to <video autoPlay> — handles MP4/HLS.
 *   3. On error, falls back to <iframe> using the raw cameraUrl — handles
 *      WebRTC-only cameras (e.g. Creality Hi) that serve no MJPEG but allow
 *      browser-level embedding (no X-Frame-Options / CSP).
 *   4. If all fail, shows "Camera unavailable".
 */
type StreamMode = 'img' | 'video' | 'iframe' | 'error';

export function CameraViewer({ printerId, printerName, variant = 'full', cameraUrl }: CameraViewerProps) {
  const [mode, setMode] = useState<StreamMode>('img');
  const [loaded, setLoaded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fullscreenImgRef = useRef<HTMLImageElement>(null);

  const streamUrl = `/api/printers/${printerId}/camera/stream`;

  // Stop img stream on unmount
  useEffect(() => {
    return () => { if (imgRef.current) imgRef.current.src = ''; };
  }, []);

  // Stop fullscreen img stream when modal closes
  useEffect(() => {
    if (!fullscreen && fullscreenImgRef.current) {
      fullscreenImgRef.current.src = '';
    }
  }, [fullscreen]);

  /** Reset to img mode and try again */
  function reload() {
    setMode('img');
    setLoaded(false);
    if (imgRef.current) {
      imgRef.current.src = '';
      setTimeout(() => { if (imgRef.current) imgRef.current.src = streamUrl; }, 100);
    }
  }

  // ─── Shared stream element ────────────────────────────────────────────────

  function StreamElement({ className }: { className: string }) {
    if (mode === 'img') {
      return (
        <img
          ref={imgRef}
          src={streamUrl}
          alt={`${printerName ?? 'Printer'} camera`}
          className={className}
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(false); setMode('video'); }}
        />
      );
    }
    if (mode === 'video') {
      return (
        <video
          ref={videoRef}
          src={streamUrl}
          autoPlay
          muted
          playsInline
          controls
          className={className}
          onPlay={() => setLoaded(true)}
          onCanPlay={() => setLoaded(true)}
          onError={() => { setLoaded(false); setMode(cameraUrl ? 'iframe' : 'error'); }}
        />
      );
    }
    if (mode === 'iframe' && cameraUrl) {
      // WebRTC-only camera (e.g. Creality Hi): embed the web UI directly.
      // The WebRTC session runs browser ↔ printer with no server-side proxy needed.
      // Note: object-contain/cover don't apply to iframes — use w-full h-full only.
      return (
        <iframe
          src={normaliseUrl(cameraUrl)}
          className="w-full h-full block"
          allow="camera; microphone; autoplay"
          scrolling="no"
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(false); setMode('error'); }}
          style={{ border: 'none', background: '#000' }}
          title={`${printerName ?? 'Printer'} camera`}
        />
      );
    }
    return null;
  }

  // ─── Compact variant ──────────────────────────────────────────────────────

  if (variant === 'compact') {
    return (
      <>
        <div className="relative bg-black rounded-lg overflow-hidden aspect-video group">
          {mode !== 'error' ? (
            <>
              {!loaded && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-gray-500 pointer-events-none">
                  <Camera className="h-6 w-6 animate-pulse" />
                  {mode === 'video' && <p className="text-xs">Trying video stream…</p>}
                {mode === 'iframe' && <p className="text-xs">Loading camera…</p>}
                </div>
              )}
              <StreamElement className="w-full h-full object-contain" />
              <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                <button
                  onClick={() => { if (imgRef.current) imgRef.current.src = ''; setFullscreen(true); }}
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

        {/* Fullscreen modal — always uses img (MJPEG only in fullscreen) */}
        {fullscreen && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
            onClick={() => { if (imgRef.current) imgRef.current.src = streamUrl; setFullscreen(false); }}
          >
            <button
              className="absolute top-4 right-4 text-white bg-black/50 rounded-full p-2 hover:bg-black/70"
              onClick={() => { if (imgRef.current) imgRef.current.src = streamUrl; setFullscreen(false); }}
            >
              <X className="h-5 w-5" />
            </button>
            {printerName && (
              <p className="absolute top-4 left-4 text-white font-semibold text-sm">{printerName}</p>
            )}
            {mode === 'video' ? (
              <video
                src={streamUrl}
                autoPlay muted playsInline controls
                className="max-w-full max-h-full object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <img
                ref={fullscreenImgRef}
                src={streamUrl}
                alt={`${printerName ?? 'Printer'} camera`}
                className="max-w-full max-h-full object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )}
      </>
    );
  }

  // ─── Full variant ─────────────────────────────────────────────────────────

  return (
    <div className="relative bg-black rounded-xl overflow-hidden w-full aspect-video">
      {mode !== 'error' ? (
        <>
          {!loaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-600 pointer-events-none">
              <Camera className="h-8 w-8 animate-pulse" />
              <p className="text-sm">
                {mode === 'video' ? 'Trying video stream…' : mode === 'iframe' ? 'Loading camera…' : 'Connecting to camera…'}
              </p>
            </div>
          )}
          <StreamElement className="w-full h-full object-contain" />
          {loaded && mode === 'img' && (
            <>
              <span className="absolute top-2 left-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide pointer-events-none">
                Live
              </span>
              <div className="absolute bottom-2 right-2">
                <button
                  onClick={reload}
                  className="bg-black/50 text-white rounded p-1.5 hover:bg-black/70"
                  title="Reconnect stream"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
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
