import { Injectable, BadRequestException } from '@nestjs/common';
import JSZip from 'jszip';
import { GcodeParserService } from './gcode-parser.service';
import { ThreeMfAnalysis, ThreeMfPlateInfo } from '@printforge/types';

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
    const plateStats = new Map<number, { printSeconds: number; weightGrams: number; toolChanges: number }>();

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
        });
      }
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
          tools: [],
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
}
