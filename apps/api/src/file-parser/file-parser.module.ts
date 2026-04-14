import { Module } from '@nestjs/common';
import { GcodeParserService } from './gcode-parser.service';
import { StlEstimatorService } from './stl-estimator.service';
import { UrlScraperService } from './url-scraper.service';
import { FileParserController } from './file-parser.controller';
import { WatchFolderService } from './watch-folder.service';
import { WatchFolderController } from './watch-folder.controller';
import { ThreeMfParserService } from './threemf-parser.service';
import { CostingModule } from '../costing/costing.module';

@Module({
  imports: [CostingModule],
  controllers: [FileParserController, WatchFolderController],
  providers: [GcodeParserService, StlEstimatorService, UrlScraperService, WatchFolderService, ThreeMfParserService],
  exports: [GcodeParserService, StlEstimatorService, UrlScraperService, WatchFolderService, ThreeMfParserService],
})
export class FileParserModule {}
