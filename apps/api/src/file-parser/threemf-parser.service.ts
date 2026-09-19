import { Injectable, BadRequestException } from '@nestjs/common';
import JSZip from 'jszip';
import { GcodeParserService } from './gcode-parser.service';
import { ThreeMfAnalysis, ThreeMfPlateInfo, ThreeMfToolInfo } from '@printforge/types';

@Injectable()
export class ThreeMfParserService {
  constructor(private readonly gcodeParser: GcodeParserService) {}

  async parse(buffer: Buffer): Promise<ThreeMfAnalysis> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      throw new BadRequestException('Invalid or corrupt .3mf file — could not unzip');
    }

    const analysis: ThreeMfAnalysis = {
      slicer: null,
      totalPlates: 0,
      plates: [],
    };

    // Parse slice_info.config for per-plate stats
    const sliceInfoFile = zip.file('Metadata/slice_info.config');
    if (!sliceInfoFile) {
      return analysis;
    }

    const xmlData = await sliceInfoFile.async('string');

    const plateRegex = /<plate>([\s\S]*?)<\/plate>/g;
    let match: RegExpExecArray | null;
    const plateStats = new Map<number, { printSeconds: number; weightGrams: number; toolChanges: number; filaments: ThreeMfToolInfo[] }>();

    while ((match = plateRegex.exec(xmlData)) !== null) {
      const plateContent = match[1];

      const indexMatch = plateContent.match(/<metadata key="index" value="(\d+)"/);
      const predictionMatch = plateContent.match(/<metadata key="prediction" value="(\d+)"/);
      const weightMatch = plateContent.match(/<metadata key="weight" value="([\d.]+)"/);
      const toolChangesMatch = plateContent.match(/<metadata key="total_toolchanges" value="(\d+)"/);

      if (indexMatch) {
        const index = parseInt(indexMatch[1], 10);
        plateStats.set(index, {
          printSeconds: predictionMatch ? parseInt(predictionMatch[1], 10) : 0,
          weightGrams: weightMatch ? parseFloat(weightMatch[1]) : 0,
          toolChanges: toolChangesMatch ? parseInt(toolChangesMatch[1], 10) : 0,
          filaments: this.sliceInfoFilaments(plateContent),
        });
      }
    }

    // Fallback: if slice_info.config exists but has no sliced plates (unsliced design file),
    // detect plates from Metadata/plate_N.png thumbnails so the wizard can still show them.
    if (plateStats.size === 0) {
      zip.forEach((relativePath) => {
        const m = relativePath.match(/^Metadata\/plate_(\d+)\.png$/i);
        if (m) {
          const idx = parseInt(m[1], 10);
          if (!plateStats.has(idx)) {
            plateStats.set(idx, { printSeconds: 0, weightGrams: 0, toolChanges: 0, filaments: [] });
          }
        }
      });
    }

    analysis.totalPlates = plateStats.size;

    // Process all plates in parallel
    const THUMBNAIL_SIZE_LIMIT = 512 * 1024; // 512 KB
    const plateResults = await Promise.all(
      Array.from(plateStats.entries()).map(async ([plateIndex, stats]) => {
        const plate: ThreeMfPlateInfo = {
          plateIndex,
          name: `Plate ${plateIndex}`,
          printSeconds: stats.printSeconds,
          weightGrams: stats.weightGrams,
          toolChanges: stats.toolChanges,
          // Projects downloaded sliced often carry no embedded G-code; their
          // slice_info still lists each used filament (id is 1-based).
          tools: stats.filaments,
          // Unsliced or unlabelled plates: unknown count, not zero (spec §4.3 M7).
          objectCount: null,
          objectModels: [],
          ignoredLabels: [],
        };

        // Parse embedded G-code and extract thumbnail in parallel per plate
        const [gcodeFile, pngFile] = await Promise.all([
          Promise.resolve(zip.file(`Metadata/plate_${plateIndex}.gcode`)),
          Promise.resolve(zip.file(`Metadata/plate_${plateIndex}.png`)),
        ]);

        if (gcodeFile) {
          const gcodeBuffer = await gcodeFile.async('nodebuffer');
          const gcodeAnalysis = this.gcodeParser.parseHeader(gcodeBuffer);

          if (gcodeAnalysis.tools?.length) {
            plate.tools = gcodeAnalysis.tools.map((t) => ({
              index: t.index,
              filamentGrams: t.filamentGrams || 0,
              colorHex: t.colorHex,
              materialType: t.materialType,
            }));
          }

          // parseHeader counts object labels over the whole embedded G-code.
          plate.objectCount = gcodeAnalysis.objectCount;
          plate.objectModels = gcodeAnalysis.objectModels;
          plate.ignoredLabels = gcodeAnalysis.ignoredLabels;

          if (!plate.weightGrams && gcodeAnalysis.filamentUsedGrams) {
            plate.weightGrams = gcodeAnalysis.filamentUsedGrams;
          }

          // Capture slicer name from any plate's G-code
          if (gcodeAnalysis.slicer) analysis.slicer = analysis.slicer ?? gcodeAnalysis.slicer;
        }

        if (pngFile) {
          const pngBuffer = await pngFile.async('nodebuffer');
          if (pngBuffer.length <= THUMBNAIL_SIZE_LIMIT) {
            plate.thumbnailBase64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
          }
          // Silently skip oversized thumbnails — card will show fallback icon
        }

        return plate;
      }),
    );

    analysis.plates = plateResults.sort((a: ThreeMfPlateInfo, b: ThreeMfPlateInfo) => a.plateIndex - b.plateIndex);

    return analysis;
  }

  /** `<filament id="2" type="PLA" color="#FFFFFF" used_g="307.52"/>` entries of one slice_info plate. */
  private sliceInfoFilaments(plateXml: string): ThreeMfToolInfo[] {
    const out: ThreeMfToolInfo[] = [];
    const re = /<filament\s([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(plateXml)) !== null) {
      const attrs = m[1];
      const attr = (k: string) => attrs.match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`))?.[1];
      const id = parseInt(attr('id') ?? '', 10);
      const grams = parseFloat(attr('used_g') ?? '');
      if (!Number.isInteger(id) || id < 1 || !(grams > 0)) continue;
      out.push({ index: id - 1, filamentGrams: grams, colorHex: attr('color') || undefined, materialType: attr('type')?.toUpperCase() || undefined });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /**
   * The sliced G-code embedded for one plate (`Metadata/plate_N.gcode`), or null
   * when the plate isn't sliced. Imports store it as the component's or the
   * layout's print file (spec §3.12 "Component files").
   */
  async extractPlateGcode(buffer: Buffer, plateIndex: number): Promise<Buffer | null> {
    if (!Number.isInteger(plateIndex) || plateIndex < 0) return null;
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      throw new BadRequestException('Invalid or corrupt .3mf file — could not unzip');
    }
    const f = zip.file(`Metadata/plate_${plateIndex}.gcode`);
    return f ? f.async('nodebuffer') : null;
  }
}
