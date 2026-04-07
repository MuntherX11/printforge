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

  async function processImage(file: File) {
    setScanning(true);
    setError('');
    setProgress('Initializing OCR...');
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));

    try {
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
      setProgress('Recognizing text...');
      const { data: { text } } = await worker.recognize(file);
      await worker.terminate();

      const fields = parseLabel(text);
      if (!fields.materialType && !fields.brand && !fields.color) {
        setError('Could not extract any fields from the label. Try a clearer photo with good lighting.');
        return;
      }
      onResult(fields);
      onClose();
    } catch (err: any) {
      console.error('OCR error:', err);
      setError(`OCR failed: ${err.message || 'Unknown error'}. Check network connection and try again.`);
    } finally {
      setScanning(false);
      setProgress('');
    }
  }

  function parseLabel(text: string): ScannedFields {
    const fields: ScannedFields = {};
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const fullText = lines.join(' ');

    // Brand detection (common filament brands)
    const brands = ['eSUN', 'Bambu', 'Polymaker', 'Hatchbox', 'Overture', 'Sunlu', 'Creality', 'Prusament', 'PolyTerra', 'PolyLite'];
    for (const brand of brands) {
      if (fullText.toLowerCase().includes(brand.toLowerCase())) {
        fields.brand = brand;
        break;
      }
    }

    // Material type
    const typeMatch = fullText.match(/\b(PLA\+?|PETG|ABS|TPU|ASA|NYLON|PA|PC|PVA|HIPS|PP)\b/i);
    if (typeMatch) fields.materialType = typeMatch[1].replace('+', '').toUpperCase();

    // Color
    const colorMatch = fullText.match(/Color[:\s]*([A-Za-z\s]+?)(?:\n|$|Diameter|Weight|Print|UPC|EAN)/i);
    if (colorMatch) fields.color = colorMatch[1].trim();

    // Diameter
    const diaMatch = fullText.match(/(\d\.75|2\.85)\s*mm/i);
    if (diaMatch) fields.diameter = diaMatch[1];

    // Weight
    const weightMatch = fullText.match(/(?:Weight|N\.?W\.?)[:\s()]*(\d+(?:\.\d+)?)\s*(?:kg|g)/i);
    if (weightMatch) {
      const val = parseFloat(weightMatch[1]);
      fields.weight = val <= 10 ? String(val * 1000) : String(val); // convert kg to g
    }

    // Print temp
    const tempMatch = fullText.match(/(?:Print\s*Temp|Temperature)[:\s]*(\d{2,3})\s*[-–]\s*(\d{2,3})\s*[°ºo]?\s*C/i);
    if (tempMatch) fields.printTemp = `${tempMatch[1]}-${tempMatch[2]}`;

    // UPC barcode
    const upcMatch = fullText.match(/UPC[:\s]*(\d[\d\s]{10,13})/i);
    if (upcMatch) fields.upc = upcMatch[1].replace(/\s/g, '');

    // EAN barcode
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
