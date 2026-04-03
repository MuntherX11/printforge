import { Injectable } from '@nestjs/common';

export interface ToolInfo {
  index: number;
  filamentMm?: number;
  filamentGrams?: number;
  colorHex?: string;
  materialType?: string;
}

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
  // Multi-color / tool change fields
  totalFilamentChanges: number | null;
  toolCount: number | null;
  tools: ToolInfo[];
  filamentColors: string[];
}

@Injectable()
export class GcodeParserService {
  /**
   * Parse G-code buffer/string and extract metadata from slicer headers.
   */
  parse(input: Buffer | string): GcodeAnalysis {
    const text = typeof input === 'string' ? input : input.toString('utf-8');
    const lines = text.split('\n');
    const searchLines = lines;

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
      totalFilamentChanges: null,
      toolCount: null,
      tools: [],
      filamentColors: [],
    };

    result.slicer = this.detectSlicer(searchLines);

    // Track tool change commands found in actual gcode (not comments)
    const toolChangeCounts = new Map<number, number>();

    // Per-tool filament data from slicer comments
    let perToolMm: number[] = [];
    let perToolGrams: number[] = [];
    let perToolCm3: number[] = [];
    let filamentColors: string[] = [];
    let filamentTypes: string[] = [];

    for (const line of searchLines) {
      const trimmed = line.trim();

      // Count actual tool change commands (T0, T1, etc.) in non-comment lines
      if (!trimmed.startsWith(';')) {
        const toolMatch = trimmed.match(/^T(\d+)\b/);
        if (toolMatch) {
          const toolIdx = parseInt(toolMatch[1]);
          toolChangeCounts.set(toolIdx, (toolChangeCounts.get(toolIdx) || 0) + 1);
        }
        continue; // Skip non-comment lines for metadata parsing
      }

      const comment = trimmed.substring(1).trim();

      // === TIME ===
      const prusaTime = comment.match(/estimated printing time.*?=\s*(.+)/i);
      if (prusaTime && result.estimatedTimeSeconds === null) {
        result.estimatedTimeSeconds = this.parseTimeString(prusaTime[1]);
      }
      const curaTime = comment.match(/^TIME:(\d+)/);
      if (curaTime) {
        result.estimatedTimeSeconds = parseInt(curaTime[1]);
      }
      const crealityTime = comment.match(/Estimated Print Time:\s*(\d+)/i);
      if (crealityTime) {
        result.estimatedTimeSeconds = parseInt(crealityTime[1]);
      }
      const elapsedTime = comment.match(/^TIME_ELAPSED:([\d.]+)/);
      if (elapsedTime) {
        result.estimatedTimeSeconds = Math.round(parseFloat(elapsedTime[1]));
      }

      // === FILAMENT LENGTH (total) ===
      // For multi-tool: ; filament used [mm] = 16575.17, 5245.24, 16837.20, 12162.73
      const filMmMulti = comment.match(/^filament used \[mm\]\s*=\s*(.+)/i);
      if (filMmMulti) {
        const values = filMmMulti[1].split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        if (values.length > 0) {
          perToolMm = values;
          result.filamentUsedMm = values.reduce((a, b) => a + b, 0);
        }
      }

      // Cura single tool: ;Filament used: 1.234m
      const curaFil = comment.match(/^Filament used:\s*([\d.]+)m/i);
      if (curaFil) {
        result.filamentUsedMm = parseFloat(curaFil[1]) * 1000;
      }

      // Per-tool grams: ; filament used [g] = 49.83, 15.77, 50.62, 36.57
      const filGMulti = comment.match(/^filament used \[g\]\s*=\s*(.+)/i);
      if (filGMulti && !comment.match(/^total filament used/i)) {
        const values = filGMulti[1].split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        if (values.length > 0) {
          perToolGrams = values;
        }
      }

      // Total filament grams: ; total filament used [g] = 152.80
      const totalFilG = comment.match(/^total filament used \[g\]\s*=\s*([\d.]+)/i);
      if (totalFilG) {
        result.filamentUsedGrams = parseFloat(totalFilG[1]);
      }

      // Per-tool cm3: ; filament used [cm3] = 39.87, 12.62, 40.50, 29.25
      const filCm3Multi = comment.match(/^filament used \[cm3\]\s*=\s*(.+)/i);
      if (filCm3Multi) {
        const values = filCm3Multi[1].split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        if (values.length > 0) {
          perToolCm3 = values;
        }
      }

      // Total filament change count: ; total filament change = 384
      const totalChanges = comment.match(/^total filament change\s*=\s*(\d+)/i);
      if (totalChanges) {
        result.totalFilamentChanges = parseInt(totalChanges[1]);
      }

      // Filament colors: ; filament_colour = #000000;#FF0000;#FFFF80;#FFBDC4
      const filColors = comment.match(/^filament_colour\s*=\s*(.+)/i);
      if (filColors) {
        filamentColors = filColors[1].split(';').map(c => c.trim()).filter(c => c.startsWith('#'));
      }

      // Filament types: ; filament_type = PLA;PLA;PLA;PLA
      const filTypes = comment.match(/^filament_type\s*=\s*(.+)/i);
      if (filTypes) {
        filamentTypes = filTypes[1].split(';').map(t => t.trim()).filter(Boolean);
        if (result.filamentType === null && filamentTypes.length > 0) {
          result.filamentType = filamentTypes[0].toUpperCase();
        }
      }

      // Creality/other single-tool filament
      const crealityFil = comment.match(/Filament Usage:\s*([\d.]+)\s*mm/i);
      if (crealityFil) {
        result.filamentUsedMm = parseFloat(crealityFil[1]);
      }
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
      const layerCount = comment.match(/^LAYER_COUNT:(\d+)/);
      if (layerCount) {
        result.layerCount = parseInt(layerCount[1]);
      }
      const prusaLayers = comment.match(/total layers count\s*=\s*(\d+)/i);
      if (prusaLayers) {
        result.layerCount = parseInt(prusaLayers[1]);
      }
      const headerLayers = comment.match(/total layer number:\s*(\d+)/i);
      if (headerLayers) {
        result.layerCount = parseInt(headerLayers[1]);
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

      // === FILAMENT TYPE (fallback for single tool) ===
      if (result.filamentType === null) {
        const filType = comment.match(/filament_type\s*=\s*(\w+)/i)
          || comment.match(/^Material:\s*(\w+)/i)
          || comment.match(/^MATERIAL:(\w+)/);
        if (filType) {
          result.filamentType = filType[1].toUpperCase();
        }
      }
    }

    // Convert mm to grams if we have mm but not grams (assume PLA 1.75mm, density 1.24)
    if (result.filamentUsedMm && !result.filamentUsedGrams) {
      const radiusCm = 0.175 / 2;
      const lengthCm = result.filamentUsedMm / 10;
      const volumeCm3 = Math.PI * radiusCm * radiusCm * lengthCm;
      result.filamentUsedGrams = Math.round(volumeCm3 * 1.24 * 100) / 100;
    }

    // Build per-tool info
    const toolCount = Math.max(perToolMm.length, perToolGrams.length, perToolCm3.length, filamentColors.length);
    if (toolCount > 0) {
      result.toolCount = toolCount;
      for (let i = 0; i < toolCount; i++) {
        const tool: ToolInfo = { index: i };
        if (perToolMm[i] !== undefined) tool.filamentMm = perToolMm[i];
        if (perToolGrams[i] !== undefined) tool.filamentGrams = perToolGrams[i];
        if (filamentColors[i]) tool.colorHex = filamentColors[i];
        if (filamentTypes[i]) tool.materialType = filamentTypes[i].toUpperCase();

        // Convert mm to grams per-tool if needed
        if (tool.filamentMm && !tool.filamentGrams) {
          const radiusCm = 0.175 / 2;
          const lengthCm = tool.filamentMm / 10;
          const volumeCm3 = Math.PI * radiusCm * radiusCm * lengthCm;
          tool.filamentGrams = Math.round(volumeCm3 * 1.24 * 100) / 100;
        }

        result.tools.push(tool);
      }
    }

    // Filament colors array
    result.filamentColors = filamentColors;

    // Fallback: if no slicer-reported total filament change, sum tool change commands
    if (result.totalFilamentChanges === null && toolChangeCounts.size > 1) {
      let total = 0;
      for (const count of toolChangeCounts.values()) {
        total += count;
      }
      // Subtract 1 per tool because the first T command selects the initial tool (not a "change")
      result.totalFilamentChanges = Math.max(0, total - 1);
    }

    // If tool changes found but toolCount not set, derive from tool change commands
    if (!result.toolCount && toolChangeCounts.size > 1) {
      result.toolCount = toolChangeCounts.size;
    }

    return result;
  }

  /**
   * Parse only header+footer chunks for large files.
   */
  parseHeader(buffer: Buffer): GcodeAnalysis {
    const chunkSize = 65536;
    if (buffer.length <= chunkSize * 2) {
      return this.parse(buffer.toString('utf-8'));
    }
    const headerText = buffer.subarray(0, chunkSize).toString('utf-8');
    const footerText = buffer.subarray(buffer.length - chunkSize).toString('utf-8');
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
