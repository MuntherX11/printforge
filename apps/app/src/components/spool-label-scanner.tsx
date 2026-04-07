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
  rawText?: string;
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
  const [rawOcrText, setRawOcrText] = useState<string>('');
  const [showRaw, setShowRaw] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  /**
   * Load image into a canvas, upscaled for processing. Returns both the
   * full-color ImageData (for QR decoding) and an OCR-ready binarized Blob.
   */
  async function prepareImage(file: File): Promise<{ colorImageData: ImageData; ocrBlob: Blob }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          // Target ~1500px on the longer side (sweet spot for tesseract + QR)
          const targetMax = 1500;
          const scale = Math.min(targetMax / Math.max(img.width, img.height), 3);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return reject(new Error('Canvas context unavailable'));

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);

          // Snapshot full-color data for QR decoding BEFORE binarization
          const colorImageData = ctx.getImageData(0, 0, w, h);

          // Now process for OCR: grayscale + Otsu binarization
          const ocrData = ctx.getImageData(0, 0, w, h);
          const data = ocrData.data;
          const totalPixels = w * h;

          const hist = new Uint32Array(256);
          for (let i = 0; i < data.length; i += 4) {
            const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            data[i] = data[i + 1] = data[i + 2] = gray;
            hist[gray]++;
          }

          // Otsu's method
          let sum = 0;
          for (let i = 0; i < 256; i++) sum += i * hist[i];
          let sumB = 0;
          let wB = 0;
          let maxVar = 0;
          let threshold = 127;
          for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            const wF = totalPixels - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const between = wB * wF * (mB - mF) * (mB - mF);
            if (between > maxVar) {
              maxVar = between;
              threshold = t;
            }
          }

          const finalThreshold = Math.min(255, threshold + 10);
          for (let i = 0; i < data.length; i += 4) {
            const v = data[i] >= finalThreshold ? 255 : 0;
            data[i] = data[i + 1] = data[i + 2] = v;
          }

          ctx.putImageData(ocrData, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) resolve({ colorImageData, ocrBlob: blob });
            else reject(new Error('Canvas toBlob failed'));
          }, 'image/png');
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      img.src = url;
    });
  }

  /**
   * Map a decoded QR URL or text payload to a known brand via domain match.
   */
  function brandFromQrPayload(payload: string): string | null {
    const domainMap: Record<string, string> = {
      'esun3d': 'eSUN',
      'esun': 'eSUN',
      'bambulab': 'Bambu',
      'bambu-lab': 'Bambu',
      'polymaker': 'Polymaker',
      'hatchbox3d': 'Hatchbox',
      'hatchbox': 'Hatchbox',
      'overture3d': 'Overture',
      'overture': 'Overture',
      'sunlu': 'Sunlu',
      'creality': 'Creality',
      'prusa3d': 'Prusament',
      'prusament': 'Prusament',
      'polyterra': 'PolyTerra',
      'polylite': 'PolyLite',
      'anycubic': 'Anycubic',
      'elegoo': 'Elegoo',
    };
    const lower = payload.toLowerCase();
    for (const [frag, brand] of Object.entries(domainMap)) {
      if (lower.includes(frag)) return brand;
    }
    return null;
  }

  async function processImage(file: File) {
    setScanning(true);
    setError('');
    setRawOcrText('');
    setShowRaw(false);
    setProgress('Preparing image...');
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));

    try {
      const { colorImageData, ocrBlob } = await prepareImage(file);

      // QR decode — label QRs typically encode a product URL we can map to a brand
      let qrBrand: string | null = null;
      let qrPayload = '';
      try {
        setProgress('Scanning QR code...');
        const jsQR = (await import('jsqr')).default;
        const qr = jsQR(colorImageData.data, colorImageData.width, colorImageData.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (qr?.data) {
          qrPayload = qr.data;
          console.log('QR decoded:', qrPayload);
          qrBrand = brandFromQrPayload(qrPayload);
          if (qrBrand) console.log('QR brand match:', qrBrand);
        }
      } catch (qrErr) {
        console.warn('QR decode failed (non-fatal):', qrErr);
      }

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
      const { data: { text } } = await worker.recognize(ocrBlob);
      await worker.terminate();

      console.log('OCR raw text:', text);
      setRawOcrText(text);
      const fields = parseLabel(text);

      // Brand resolution priority: parser > QR > OCR text domain fragments
      if (!fields.brand && qrBrand) {
        fields.brand = qrBrand;
      }
      if (!fields.brand) {
        const textBrand = brandFromQrPayload(text);
        if (textBrand) fields.brand = textBrand;
      }

      console.log('Parsed fields:', fields);

      if (!fields.materialType && !fields.brand && !fields.color && !fields.weight) {
        setError('Could not extract any fields from the label. Try a clearer, well-lit photo straight-on.');
        return;
      }
      onResult({ ...fields, rawText: qrPayload ? `${text}\n\n[QR: ${qrPayload}]` : text });
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

    // Levenshtein distance (hoisted so all field matchers can use it)
    const lev = (a: string, b: string): number => {
      if (a === b) return 0;
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      const prev: number[] = new Array(b.length + 1);
      for (let i = 0; i <= b.length; i++) prev[i] = i;
      for (let i = 1; i <= a.length; i++) {
        let curr = i;
        for (let j = 1; j <= b.length; j++) {
          const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
          const next = Math.min(curr + 1, prev[j] + 1, prev[j - 1] + cost);
          prev[j - 1] = curr;
          curr = next;
        }
        prev[b.length] = curr;
      }
      return prev[b.length];
    };

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

    // Fuzzy label finder: match the leading word(s) of a line against a target
    // label using Levenshtein. Returns everything after the matched label.
    // Handles mangled OCR labels like "olor"≈Color, "Doaereter"≈Diameter,
    // "Punt Temp"≈Print Temp, "Nate"≈Name.
    const findFuzzyLabelValue = (...targets: string[]): string | null => {
      for (const line of rawLines) {
        // Try to split label from value — prefer colon, else split by whitespace
        let labelPart: string;
        let valuePart: string;
        const colonIdx = line.search(/[:.]/);
        // Only treat as labeled if colon is early AND leading part has ≤2 words
        const colonIsLabel =
          colonIdx > 0 &&
          colonIdx <= 15 &&
          line.slice(0, colonIdx).trim().split(/\s+/).length <= 2;
        if (colonIsLabel) {
          labelPart = line.slice(0, colonIdx);
          valuePart = line.slice(colonIdx + 1).trim();
        } else {
          // Try 1-word and 2-word label prefixes
          const parts = line.split(/\s+/);
          if (parts.length < 2) continue;
          labelPart = parts[0];
          valuePart = parts.slice(1).join(' ');
          // Also try 2-word label (for "Print Temp")
          const twoWord = parts.slice(0, 2).join(' ');
          for (const target of targets) {
            if (target.includes(' ')) {
              const normTwo = twoWord.toLowerCase().replace(/[^a-z ]/g, '');
              const normTarget = target.toLowerCase();
              const maxDist = Math.max(1, Math.floor(normTarget.length * 0.5));
              if (lev(normTwo, normTarget) <= maxDist) {
                const v = parts.slice(2).join(' ');
                if (v) return v;
              }
            }
          }
        }
        const normLabel = labelPart.toLowerCase().replace(/[^a-z]/g, '');
        if (normLabel.length < 3) continue;
        for (const target of targets) {
          const normTarget = target.toLowerCase().replace(/[^a-z]/g, '');
          // Allow ~50% edit distance, min 1 (tolerates "Inlor"->"color" at 2 edits)
          const maxDist = Math.max(1, Math.floor(normTarget.length * 0.5));
          if (lev(normLabel, normTarget) <= maxDist && valuePart) {
            return valuePart;
          }
        }
      }
      return null;
    };

    // Brand detection: (1) labeled line, (2) substring, (3) Levenshtein word match
    const brands = ['eSUN', 'Bambu', 'Polymaker', 'Hatchbox', 'Overture', 'Sunlu', 'Creality', 'Prusament', 'PolyTerra', 'PolyLite', 'Anycubic', 'Elegoo'];

    const brandLineValue = findFuzzyLabelValue('Brand', 'Manufacturer', 'Made by');
    if (brandLineValue) {
      const firstWord = brandLineValue.split(/\s+/)[0];
      const exact = brands.find(b => b.toLowerCase() === firstWord.toLowerCase());
      if (exact) fields.brand = exact;
      else if (firstWord.length >= 3) fields.brand = firstWord;
    }

    if (!fields.brand) {
      for (const brand of brands) {
        if (lowerText.includes(brand.toLowerCase())) {
          fields.brand = brand;
          break;
        }
      }
    }

    if (!fields.brand) {
      // Use hoisted lev function for word-level fuzzy match
      const words = fullText.split(/[\s,;|/\\()[\]{}]+/).filter(w => w.length >= 3 && w.length <= 15);
      let bestBrand: string | null = null;
      let bestDist = Infinity;
      for (const word of words) {
        for (const brand of brands) {
          const maxAllowed = brand.length <= 5 ? 1 : 2;
          const d = lev(word, brand);
          if (d <= maxAllowed && d < bestDist) {
            bestDist = d;
            bestBrand = brand;
          }
        }
      }
      if (bestBrand) fields.brand = bestBrand;
    }

    // Material type — try fuzzy "Name:" line, then standalone match
    const nameValue = findFuzzyLabelValue('Name', 'Material', 'Type');
    if (nameValue) {
      const m = nameValue.match(/([A-Z][A-Z0-9+]{1,8})/i);
      if (m) fields.materialType = m[1].replace('+', '').toUpperCase();
    }
    if (!fields.materialType) {
      const typeMatch = fullText.match(/\b(PLA\+?|PETG|ABS|TPU|ASA|NYLON|PA|PC|PVA|HIPS|PP)\b/i);
      if (typeMatch) fields.materialType = typeMatch[1].replace('+', '').toUpperCase();
    }

    // Color — fuzzy label lookup (handles mangled "olor" etc)
    const colorValue = findFuzzyLabelValue('Color', 'Colour');
    if (colorValue) {
      // Strip trailing OCR garbage (non-letter chars, numbers, etc.)
      let cleaned = colorValue.replace(/[^A-Za-z\s]+.*$/, '').trim();
      // Drop trailing 1-2 letter words ("Me", "Ie", "Mm" etc — typical OCR garbage)
      const colorTokens = cleaned.split(/\s+/);
      while (colorTokens.length > 1 && colorTokens[colorTokens.length - 1].length <= 2) {
        colorTokens.pop();
      }
      cleaned = colorTokens.join(' ');
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

    // Diameter — fuzzy label + broadened regex (handles "175mm" without decimal)
    const normalizeDia = (raw: string): string | null => {
      // Match 1.75/2.85/3.00 with optional separator, or bare 175/285/300
      const m = raw.match(/(1[.,]?7?5|2[.,]?8?5|3[.,]?0?0)\s*mm?/i);
      if (!m) return null;
      const digits = m[1].replace(/[.,]/g, '');
      if (digits === '175') return '1.75';
      if (digits === '285') return '2.85';
      if (digits === '300') return '3.00';
      return m[1].replace(',', '.');
    };
    // Contextual parser: safe only inside a diameter-labeled line.
    // Handles OCR dropping the leading "1" from "1.75mm" → "75mm".
    const normalizeDiaContextual = (raw: string): string | null => {
      const m = raw.match(/(75|85|00)\s*mm\b/i);
      if (!m) return null;
      if (m[1] === '75') return '1.75';
      if (m[1] === '85') return '2.85';
      if (m[1] === '00') return '3.00';
      return null;
    };
    const diaValue = findFuzzyLabelValue('Diameter');
    if (diaValue) {
      const d = normalizeDia(diaValue) || normalizeDiaContextual(diaValue);
      if (d) fields.diameter = d;
    }
    if (!fields.diameter) {
      const d = normalizeDia(fullText);
      if (d) fields.diameter = d;
    }

    // Weight — fuzzy label + OCR digit-substitution normalization
    // Handles "TkgiN" where T should be 1, "lkg" where l is 1,
    // "Thg" where k was misread as h, etc.
    const ocrDigitNormalize = (s: string) =>
      s.replace(/[TtIilO]/g, (c) => (c === 'O' ? '0' : '1'));
    const parseWeightStr = (s: string): string | null => {
      // Standard pattern first
      let m = s.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
      let unit: 'kg' | 'g' | null = null;
      if (m) unit = m[2].toLowerCase() as 'kg' | 'g';
      if (!m) {
        // Retry with digit-like chars normalized + fuzzy unit (k misread as h/b)
        const normalized = ocrDigitNormalize(s).replace(/\b([hb])g\b/gi, 'kg');
        m = normalized.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
        if (m) unit = m[2].toLowerCase() as 'kg' | 'g';
      }
      if (!m) {
        // Even looser: digit directly followed by [khb]g (no word boundary, handles "1hg11N")
        const normalized = ocrDigitNormalize(s);
        const m2 = normalized.match(/(\d+(?:[.,]\d+)?)\s*([khb]g)/i);
        if (m2) {
          m = m2;
          unit = 'kg';
        }
      }
      if (!m || !unit) return null;
      const val = parseFloat(m[1].replace(',', '.'));
      if (!isFinite(val) || val <= 0) return null;
      const grams = unit === 'kg' ? val * 1000 : val;
      // Sanity cap — labels usually 250g to 5kg
      if (grams < 50 || grams > 10000) return null;
      return String(Math.round(grams));
    };
    const weightValue = findFuzzyLabelValue('Weight', 'Net Weight', 'NW');
    if (weightValue) {
      const w = parseWeightStr(weightValue);
      if (w) fields.weight = w;
    }
    if (!fields.weight) {
      const w = parseWeightStr(fullText);
      if (w) fields.weight = w;
    }

    // Print temp — fuzzy label lookup (handles "Punt Temp" etc)
    const tempValue = findFuzzyLabelValue('Print Temp', 'Print Temperature', 'Temperature', 'Temp');
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

        {rawOcrText && error && (
          <div className="text-xs">
            <button
              type="button"
              onClick={() => setShowRaw(s => !s)}
              className="text-brand-600 hover:underline"
            >
              {showRaw ? 'Hide' : 'Show'} raw OCR text
            </button>
            {showRaw && (
              <pre className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                {rawOcrText || '(empty)'}
              </pre>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}
