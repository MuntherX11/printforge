import { Injectable } from '@nestjs/common';
import JSZip from 'jszip';
import { GcodeParserService } from './gcode-parser.service';
import { ThreeMfAnalysis, ThreeMfPlateInfo } from '@printforge/types';

@Injectable()
export class ThreeMfParserService {
  constructor(private readonly gcodeParser: GcodeParserService) {}

  async parse(buffer: Buffer): Promise<ThreeMfAnalysis> {
    const zip = await JSZip.loadAsync(buffer);

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

    // Process each plate
    for (const [plateIndex, stats] of plateStats.entries()) {
      const plate: ThreeMfPlateInfo = {
        plateIndex,
        name: `Plate ${plateIndex}`,
        printSeconds: stats.printSeconds,
        weightGrams: stats.weightGrams,
        toolChanges: stats.toolChanges,
        tools: [],
      };

      // Parse embedded G-code for per-tool color/material info
      const gcodeFile = zip.file(`Metadata/plate_${plateIndex}.gcode`);
      if (gcodeFile) {
        const gcodeBuffer = await gcodeFile.async('nodebuffer');
        const gcodeAnalysis = this.gcodeParser.parseHeader(gcodeBuffer);

        // Use the first plate's slicer name as the project slicer
        if (!analysis.slicer && gcodeAnalysis.slicer) {
          analysis.slicer = gcodeAnalysis.slicer;
        }

        if (gcodeAnalysis.tools?.length) {
          plate.tools = gcodeAnalysis.tools.map((t) => ({
            index: t.index,
            filamentGrams: t.filamentGrams || 0,
            colorHex: t.colorHex,
            materialType: t.materialType,
          }));
        }

        // If slice_info had no weight but gcode has it, use gcode value
        if (!plate.weightGrams && gcodeAnalysis.filamentUsedGrams) {
          plate.weightGrams = gcodeAnalysis.filamentUsedGrams;
        }
      }

      // Extract plate thumbnail
      const pngFile = zip.file(`Metadata/plate_${plateIndex}.png`);
      if (pngFile) {
        const pngBuffer = await pngFile.async('nodebuffer');
        plate.thumbnailBase64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
      }

      analysis.plates.push(plate);
    }

    // Return plates sorted by index
    analysis.plates.sort((a: ThreeMfPlateInfo, b: ThreeMfPlateInfo) => a.plateIndex - b.plateIndex);

    return analysis;
  }
}
