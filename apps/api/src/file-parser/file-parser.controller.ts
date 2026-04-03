import { Controller, Post, UseGuards, UseInterceptors, UploadedFile, BadRequestException, Query, Body } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { GcodeParserService } from './gcode-parser.service';
import { StlEstimatorService } from './stl-estimator.service';
import { UrlScraperService } from './url-scraper.service';
import { CostingService } from '../costing/costing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('file-parser')
@UseGuards(JwtAuthGuard)
export class FileParserController {
  constructor(
    private gcodeParser: GcodeParserService,
    private stlEstimator: StlEstimatorService,
    private urlScraper: UrlScraperService,
    private costingService: CostingService,
  ) {}

  /**
   * Upload a G-code or STL file, get parsed metadata + instant cost estimate.
   * Query params: ?materialId=xxx&printerId=xxx&colorChanges=1&infill=20
   */
  @Post('analyze')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  async analyzeFile(
    @UploadedFile() file: any,
    @Query('materialId') materialId?: string,
    @Query('printerId') printerId?: string,
    @Query('colorChanges') colorChanges?: string,
    @Query('infill') infill?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    const name = (file.originalname || '').toLowerCase();
    const isGcode = name.endsWith('.gcode') || name.endsWith('.gco') || name.endsWith('.g');
    const isStl = name.endsWith('.stl');

    if (!isGcode && !isStl) {
      throw new BadRequestException('File must be .gcode or .stl');
    }

    let gramsUsed = 0;
    let printMinutes = 0;
    let fileAnalysis: any;

    if (isGcode) {
      const analysis = this.gcodeParser.parseHeader(file.buffer);
      gramsUsed = analysis.filamentUsedGrams || 0;
      printMinutes = analysis.estimatedTimeSeconds ? Math.round(analysis.estimatedTimeSeconds / 60) : 0;
      fileAnalysis = { type: 'gcode', ...analysis };
    } else {
      const infillPercent = infill ? parseInt(infill) : 20;
      const analysis = this.stlEstimator.analyze(file.buffer, 1.24, infillPercent);
      gramsUsed = analysis.estimatedGrams;
      printMinutes = analysis.estimatedMinutes;
      fileAnalysis = { type: 'stl', ...analysis };
    }

    // Cost estimate
    let costEstimate = null;
    if (materialId && gramsUsed > 0) {
      try {
        costEstimate = await this.costingService.estimateFromParams({
          gramsUsed,
          printMinutes,
          materialId,
          printerId,
          colorChanges: colorChanges ? parseInt(colorChanges) : 0,
        });
      } catch {
        // Material not found or other error — return analysis without cost
      }
    }

    return {
      filename: file.originalname,
      fileSize: file.size,
      analysis: fileAnalysis,
      costEstimate,
    };
  }

  @Post('parse-gcode')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  async parseGcode(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.gcodeParser.parseHeader(file.buffer);
  }

  @Post('analyze-stl')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async analyzeStl(
    @UploadedFile() file: any,
    @Query('density') density?: string,
    @Query('infill') infill?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.stlEstimator.analyze(
      file.buffer,
      density ? parseFloat(density) : 1.24,
      infill ? parseInt(infill) : 20,
    );
  }

  @Post('scrape-url')
  async scrapeUrl(@Body() body: { url: string }) {
    if (!body.url) throw new BadRequestException('URL is required');
    return this.urlScraper.scrapeModelUrl(body.url);
  }
}
