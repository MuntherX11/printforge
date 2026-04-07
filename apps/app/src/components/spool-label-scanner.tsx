'use client';

import { useState, useRef, useEffect } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Camera, Upload, Loader2 } from 'lucide-react';

export interface ScannedFields {
  materialType?: string;
  color?: string;
  brand?: string;
  diameter?: string;
  weight?: string;
  printTemp?: string;
  upc?: string;
  ean?: string;
}

interface SpoolLabelScannerProps {
  open: boolean;
  onClose: () => void;
  onResult: (fields: ScannedFields) => void;
}

export function SpoolLabelScanner({ open, onClose, onResult }: SpoolLabelScannerProps) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  /**
   * Preprocess image: upscale, grayscale, contrast boost.
   * Massively improves OCR accuracy on phone photos of labels.
   */
  async function preprocessImage(file: File): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          // Target ~1500px on the longer side (sweet spot for tesseract)
          const targetMax = 1500;
          const scale = Math.min(targetMax / Math.max(img.width, img.height), 3);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('Canvas context unavailable'));

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);

          // Grayscale + contrast stretch
          const imgData = ctx.getImageData(0, 0, w, h);
          const data = imgData.data;

          // First pass: grayscale + collect histogram
          const hist = new Uint32Array(256);
          for (let i = 0; i < data.length; i += 4) {
            const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            data[i] = data[i + 1] = data[i + 2] = gray;
            hist[gray]++;
          }

          // Find 5th and 95th percentile for contrast stretch
          const totalPixels = w * h;
          const lowCut = totalPixels * 0.05;
          const highCut = totalPixels * 0.95;
          let cum = 0;
          let lowVal = 0;
          let highVal = 255;
          for (let i = 0; i < 256; i++) {
            cum += hist[i];
            if (cum >= lowCut && lowVal === 0) lowVal = i;
            if (cum >= highCut) { highVal = i; break; }
          }
          const range = Math.max(1, highVal - lowVal);

          // Second pass: contrast stretch
          for (let i = 0; i < data.length; i += 4) {
            let v = data[i];
            v = Math.max(0, Math.min(255, Math.round(((v - lowVal) / range) * 255)));
            data[i] = data[i + 1] = data[i + 2] = v;
          }

          ctx.putImageData(imgData, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Canvas toBlob failed'));
          }, 'image/png');
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = URL.createObjectURL(file);
    });
  }

  async function processImage(file: File) {
    setScanning(true);
    setError('');
    setProgress('Preparing image...');
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));

    try {
      const processed = await preprocessImage(file);

      setProgress('Initializing OCR...');
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng', 1, {
        workerPath: '/worker.min.js',
        corePath: '/tesseract-core-simd-lstm.wasm.js',
        langPath: '/tessdata',
        workerBlobURL: false,
        logger: (m: any) => {
          if (m.status) setProgress(m.status);
        },
      });

      // PSM 6 = uniform block of text (better for labels than default auto)
      await worker.setParameters({
        tessedit_pageseg_mode: '6' as any,
      });

      setProgress('Recognizing text...');
      const { data: { text } } = await worker.recognize(processed);
      await worker.terminate();

      console.log('OCR raw text:', text);
      const fields = parseLabel(text);
      console.log('Parsed fields:', fields);

      if (!fields.materialType && !fields.brand && !fields.color && !fields.weight) {
        setError('Could not extract any fields from the label. Try a clearer, well-lit photo straight-on.');
        return;
      }
      onResult(fields);
      onClose();
    } catch (err: any) {
      console.error('OCR error:', err);
      setError(`OCR failed: ${err.message || 'Unknown error'}.`);
    } finally {
      setScanning(false);
      setProgress('');
    }
  }

  function parseLabel(text: string): ScannedFields {
    const fields: ScannedFields = {};
    // Normalize common OCR substitutions
    const normalize = (s: string) => s
      .replace(/[|]/g, 'I')
      .replace(/[‚]/g, ',')
      .replace(/[°ºo*](?=\s*C\b)/g, '°');

    const rawLines = text.split('\n').map(l => normalize(l.trim())).filter(Boolean);
    const fullText = rawLines.join(' ');
    const lowerText = fullText.toLowerCase();

    // Helper: find the value of a labeled field on its own line.
    // Looks for "Label:" or "Label" anywhere, returns rest of line.
    const findLineValue = (labelPattern: RegExp): string | null => {
      for (const line of rawLines) {
        const m = line.match(labelPattern);
        if (m) {
          // Take everything after the matched label
          const value = line.slice(m[0].length).trim();
          if (value) return value;
        }
      }
      return null;
    };

    // Brand detection (with fuzzy fallback for OCR substitutions)
    const brands = ['eSUN', 'Bambu', 'Polymaker', 'Hatchbox', 'Overture', 'Sunlu', 'Creality', 'Prusament', 'PolyTerra', 'PolyLite', 'Anycubic', 'Elegoo'];
    for (const brand of brands) {
      const lower = brand.toLowerCase();
      if (lowerText.includes(lower)) {
        fields.brand = brand;
        break;
      }
      const fuzzy = lower
        .replace(/e/g, '[e@€]')
        .replace(/o/g, '[o0]')
        .replace(/s/g, '[s5]')
        .replace(/l/g, '[l1iI]');
      if (new RegExp(fuzzy, 'i').test(fullText)) {
        fields.brand = brand;
        break;
      }
    }

    // Material type — try "Name:" line first, then standalone
    const nameValue = findLineValue(/^Name\s*[:.]?\s*/i);
    if (nameValue) {
      const m = nameValue.match(/^([A-Z][A-Z0-9+]{1,8})/i);
      if (m) fields.materialType = m[1].replace('+', '').toUpperCase();
    }
    if (!fields.materialType) {
      const typeMatch = fullText.match(/\b(PLA\+?|PETG|ABS|TPU|ASA|NYLON|PA|PC|PVA|HIPS|PP)\b/i);
      if (typeMatch) fields.materialType = typeMatch[1].replace('+', '').toUpperCase();
    }

    // Color — try "Color:" line first (multi-word), then standalone color words
    const colorValue = findLineValue(/^Colou?r\s*[:.]?\s*/i);
    if (colorValue) {
      // Strip trailing OCR garbage (non-letter chars, numbers, etc.)
      const cleaned = colorValue.replace(/[^A-Za-z\s]+.*$/, '').trim();
      if (cleaned.length >= 2) {
        // Title case
        fields.color = cleaned.split(/\s+/)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
      }
    }
    if (!fields.color) {
      const colorWords = ['BLACK', 'WHITE', 'RED', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'PURPLE', 'PINK', 'GREY', 'GRAY', 'BROWN', 'SILVER', 'GOLD', 'TRANSPARENT', 'CLEAR', 'NATURAL', 'BEIGE'];
      for (const c of colorWords) {
        if (new RegExp(`\\b${c}\\b`, 'i').test(fullText)) {
          fields.color = c.charAt(0) + c.slice(1).toLowerCase();
          break;
        }
      }
    }

    // Diameter — try "Diameter:" line first, then anywhere
    const diaValue = findLineValue(/^Diameter\s*[:.]?\s*/i);
    if (diaValue) {
      const m = diaValue.match(/(1[.,]75|2[.,]85|3[.,]00)/);
      if (m) fields.diameter = m[1].replace(',', '.');
    }
    if (!fields.diameter) {
      const diaMatch = fullText.match(/(1[.,]75|2[.,]85|3[.,]00)\s*mm?/i);
      if (diaMatch) fields.diameter = diaMatch[1].replace(',', '.');
    }

    // Weight — try "Weight:" line first, then full-text patterns
    const parseWeightStr = (s: string): string | null => {
      const m = s.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
      if (!m) return null;
      const val = parseFloat(m[1].replace(',', '.'));
      const grams = m[2].toLowerCase() === 'kg' ? val * 1000 : val;
      return String(Math.round(grams));
    };
    const weightValue = findLineValue(/^(Weight|N\.?\s*W\.?|Net\s*Weight)\s*[:.]?\s*/i);
    if (weightValue) {
      const w = parseWeightStr(weightValue);
      if (w) fields.weight = w;
    }
    if (!fields.weight) {
      const w = parseWeightStr(fullText);
      if (w) fields.weight = w;
    }

    // Print temp — try "Print Temp:" line first, then anywhere
    const tempValue = findLineValue(/^(Print\s*Temp|Temperature|Temp)\s*[:.]?\s*/i);
    const parseTempStr = (s: string): string | null => {
      const m = s.match(/(\d{2,3})\s*[-–~]\s*(\d{2,3})/);
      return m ? `${m[1]}-${m[2]}` : null;
    };
    if (tempValue) {
      const t = parseTempStr(tempValue);
      if (t) fields.printTemp = t;
    }
    if (!fields.printTemp) {
      const tempMatch = fullText.match(/(\d{2,3})\s*[-–~]\s*(\d{2,3})\s*°?\s*C\b/);
      if (tempMatch) fields.printTemp = `${tempMatch[1]}-${tempMatch[2]}`;
    }

    // UPC / EAN barcodes
    const upcMatch = fullText.match(/UPC[:\s]*(\d[\d\s]{10,13})/i);
    if (upcMatch) fields.upc = upcMatch[1].replace(/\s/g, '');
    const eanMatch = fullText.match(/EAN[:\s]*(\d[\d\s]{10,15})/i);
    if (eanMatch) fields.ean = eanMatch[1].replace(/\s/g, '');

    return fields;
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processImage(file);
    e.target.value = '';
  }

  return (
    <Dialog open={open} onClose={onClose} title="Scan Spool Label">
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Take a photo of the spool label or upload an image. The system will extract material details automatically.
        </p>

        {!scanning && !preview && (
          <div className="flex gap-3">
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            <Button variant="outline" className="flex-1" onClick={() => cameraRef.current?.click()}>
              <Camera className="h-4 w-4 mr-2" /> Take Photo
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4 mr-2" /> Upload Image
            </Button>
          </div>
        )}

        {scanning && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
            <p className="text-sm text-gray-500 dark:text-gray-400">{progress || 'Scanning label...'}</p>
          </div>
        )}

        {preview && !scanning && (
          <div className="text-center">
            <img src={preview} alt="Scanned label" className="max-h-48 mx-auto rounded-md border dark:border-gray-700" />
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}
