import { Module } from '@nestjs/common';
import { GcodeParserService } from './gcode-parser.service';
import { StlEstimatorService } from './stl-estimator.service';
import { FileParserController } from './file-parser.controller';
import { WatchFolderService } from './watch-folder.service';
import { WatchFolderController } from './watch-folder.controller';
import { CostingModule } from '../costing/costing.module';

@Module({
  imports: [CostingModule],
  controllers: [FileParserController, WatchFolderController],
  providers: [GcodeParserService, StlEstimatorService, WatchFolderService],
  exports: [GcodeParserService, StlEstimatorService, WatchFolderService],
})
export class FileParserModule {}
