import { Injectable } from '@nestjs/common';

export interface GcodeAnalysis {
  slicer: string | null;
  estimatedTimeSeconds: number | null;
  filamentUsedMm: number | null;
  filamentUsedGrams: number | null;
  layerHeight: number | null;
  layerCount: number | null;
  nozzleTemp: number | null;
  bedTemp: number | null;
  filamentType: string | null;
}

@Injectable()
export class GcodeParserService {
  /**
   * Parse G-code buffer/string and extract metadata from slicer headers.
   * Reads only the first and last 100 lines (where slicers put their comments).
   */
  parse(input: Buffer | string): GcodeAnalysis {
    const text = typeof input === 'string' ? input : input.toString('utf-8');
    const lines = text.split('\n');

    // Most metadata is in first ~80 and last ~80 lines
    const headerLines = lines.slice(0, 100);
    const footerLines = lines.slice(-100);
    const searchLines = [...headerLines, ...footerLines];

    const result: GcodeAnalysis = {
      slicer: null,
      estimatedTimeSeconds: null,
      filamentUsedMm: null,
      filamentUsedGrams: null,
      layerHeight: null,
      layerCount: null,
      nozzleTemp: null,
      bedTemp: null,
      filamentType: null,
    };

    // Detect slicer
    result.slicer = this.detectSlicer(searchLines);

    // Parse based on detected slicer (or try all patterns)
    for (const line of searchLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(';')) continue;
      const comment = trimmed.substring(1).trim();

      // === TIME ===
      // PrusaSlicer/OrcaSlicer: ; estimated printing time (normal mode) = 1h 23m 45s
      const prusaTime = comment.match(/estimated printing time.*?=\s*(.+)/i);
      if (prusaTime && result.estimatedTimeSeconds === null) {
        result.estimatedTimeSeconds = this.parseTimeString(prusaTime[1]);
      }
      // Cura: ;TIME:5432
      const curaTime = comment.match(/^TIME:(\d+)/);
      if (curaTime) {
        result.estimatedTimeSeconds = parseInt(curaTime[1]);
      }
      // Creality Print: ; Estimated Print Time: 5432
      const crealityTime = comment.match(/Estimated Print Time:\s*(\d+)/i);
      if (crealityTime) {
        result.estimatedTimeSeconds = parseInt(crealityTime[1]);
      }
      // Generic: ;TIME_ELAPSED:5432.1
      const elapsedTime = comment.match(/^TIME_ELAPSED:([\d.]+)/);
      if (elapsedTime) {
        result.estimatedTimeSeconds = Math.round(parseFloat(elapsedTime[1]));
      }

      // === FILAMENT LENGTH ===
      // PrusaSlicer: ; filament used [mm] = 12345.67
      const prusaFilMm = comment.match(/filament used \[mm\]\s*=\s*([\d.]+)/i);
      if (prusaFilMm) {
        result.filamentUsedMm = parseFloat(prusaFilMm[1]);
      }
      // Cura: ;Filament used: 1.234m
      const curaFil = comment.match(/^Filament used:\s*([\d.]+)m/i);
      if (curaFil) {
        result.filamentUsedMm = parseFloat(curaFil[1]) * 1000;
      }
      // OrcaSlicer: ; total filament used [g] = 12.34
      const orcaFilG = comment.match(/total filament used \[g\]\s*=\s*([\d.]+)/i);
      if (orcaFilG) {
        result.filamentUsedGrams = parseFloat(orcaFilG[1]);
      }
      // PrusaSlicer: ; filament used [g] = 12.34
      const prusaFilG = comment.match(/filament used \[g\]\s*=\s*([\d.]+)/i);
      if (prusaFilG) {
        result.filamentUsedGrams = parseFloat(prusaFilG[1]);
      }
      // Creality Print: ; Filament Usage: 12345 mm
      const crealityFil = comment.match(/Filament Usage:\s*([\d.]+)\s*mm/i);
      if (crealityFil) {
        result.filamentUsedMm = parseFloat(crealityFil[1]);
      }
      // Creality Print: ; Filament Weight: 12.34 g
      const crealityFilG = comment.match(/Filament Weight:\s*([\d.]+)\s*g/i);
      if (crealityFilG) {
        result.filamentUsedGrams = parseFloat(crealityFilG[1]);
      }

      // === LAYER HEIGHT ===
      const layerH = comment.match(/layer_height\s*=\s*([\d.]+)/i)
        || comment.match(/^Layer height:\s*([\d.]+)/i);
      if (layerH && result.layerHeight === null) {
        result.layerHeight = parseFloat(layerH[1]);
      }

      // === LAYER COUNT ===
      // Cura: ;LAYER_COUNT:123
      const layerCount = comment.match(/^LAYER_COUNT:(\d+)/);
      if (layerCount) {
        result.layerCount = parseInt(layerCount[1]);
      }
      // PrusaSlicer: ; total layers count = 123
      const prusaLayers = comment.match(/total layers count\s*=\s*(\d+)/i);
      if (prusaLayers) {
        result.layerCount = parseInt(prusaLayers[1]);
      }

      // === TEMPS ===
      const nozzle = comment.match(/nozzle_temperature\s*=\s*(\d+)/i)
        || comment.match(/^Extruder \d+ temp:\s*(\d+)/i);
      if (nozzle && result.nozzleTemp === null) {
        result.nozzleTemp = parseInt(nozzle[1]);
      }
      const bed = comment.match(/bed_temperature\s*=\s*(\d+)/i)
        || comment.match(/^Build plate temp:\s*(\d+)/i);
      if (bed && result.bedTemp === null) {
        result.bedTemp = parseInt(bed[1]);
      }

      // === FILAMENT TYPE ===
      const filType = comment.match(/filament_type\s*=\s*(\w+)/i)
        || comment.match(/^Material:\s*(\w+)/i)
        || comment.match(/^MATERIAL:(\w+)/);
      if (filType && result.filamentType === null) {
        result.filamentType = filType[1].toUpperCase();
      }
    }

    // Convert mm to grams if we have mm but not grams (assume PLA 1.75mm, density 1.24)
    if (result.filamentUsedMm && !result.filamentUsedGrams) {
      const radiusCm = 0.175 / 2; // 1.75mm diameter
      const lengthCm = result.filamentUsedMm / 10;
      const volumeCm3 = Math.PI * radiusCm * radiusCm * lengthCm;
      result.filamentUsedGrams = Math.round(volumeCm3 * 1.24 * 100) / 100; // PLA default
    }

    return result;
  }

  /**
   * Parse only the header (first 8KB) for large files — avoids reading entire G-code into memory.
   */
  parseHeader(buffer: Buffer): GcodeAnalysis {
    const headerSize = Math.min(buffer.length, 8192);
    const headerText = buffer.subarray(0, headerSize).toString('utf-8');
    // Also grab footer
    const footerStart = Math.max(0, buffer.length - 8192);
    const footerText = buffer.subarray(footerStart).toString('utf-8');
    return this.parse(headerText + '\n' + footerText);
  }

  private detectSlicer(lines: string[]): string | null {
    for (const line of lines) {
      const l = line.trim();
      if (l.includes('PrusaSlicer')) return 'PrusaSlicer';
      if (l.includes('OrcaSlicer')) return 'OrcaSlicer';
      if (l.includes('BambuStudio')) return 'BambuStudio';
      if (l.includes('Cura_SteamEngine')) return 'Cura';
      if (l.includes('Creality Print')) return 'Creality Print';
      if (l.includes('SuperSlicer')) return 'SuperSlicer';
      if (l.includes('Simplify3D')) return 'Simplify3D';
      if (l.includes('ideaMaker')) return 'ideaMaker';
      if (l.includes('Slic3r')) return 'Slic3r';
    }
    return null;
  }

  private parseTimeString(timeStr: string): number {
    let seconds = 0;
    const days = timeStr.match(/(\d+)\s*d/);
    const hours = timeStr.match(/(\d+)\s*h/);
    const minutes = timeStr.match(/(\d+)\s*m(?!s)/);
    const secs = timeStr.match(/(\d+)\s*s/);

    if (days) seconds += parseInt(days[1]) * 86400;
    if (hours) seconds += parseInt(hours[1]) * 3600;
    if (minutes) seconds += parseInt(minutes[1]) * 60;
    if (secs) seconds += parseInt(secs[1]);

    return seconds || 0;
  }
}
