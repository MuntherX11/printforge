import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { MaterialMergeService } from './material-merge.service';

@Controller('materials')
@UseGuards(JwtAuthGuard)
export class MaterialMergeController {
  constructor(private readonly merges: MaterialMergeService) {}

  /**
   * Merge this filament into another of the same type, then delete it. ADMIN
   * only. Without `confirm: true` a dry run: the counts of everything that
   * would move, and warnings. Writes its own audit row (with the counts).
   */
  @Post(':id/merge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  merge(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: { id?: string } | undefined) {
    return this.merges.merge(id, body, user?.id ?? null);
  }
}
