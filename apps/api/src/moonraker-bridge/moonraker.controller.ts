import { Controller, Post, Param, Body, Get, UseGuards, BadRequestException, NotFoundException } from '@nestjs/common';
import { MoonrakerService } from './moonraker.service';
import { CrealityWsService } from './creality-ws.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('moonraker')
@UseGuards(JwtAuthGuard, StaffGuard)
export class MoonrakerController {
  constructor(
    private moonraker: MoonrakerService,
    private crealityWs: CrealityWsService,
    private prisma: PrismaService,
  ) {}

  /**
   * Get live status of a single printer via Moonraker.
   */
  @Get('status/:printerId')
  async getStatus(@Param('printerId') printerId: string) {
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) throw new NotFoundException('Printer not found');
    if (!printer.moonrakerUrl) throw new BadRequestException('Printer has no Moonraker URL configured');

    const snapshot = await this.moonraker.fetchStatus(printer.moonrakerUrl);
    return { printer: { id: printer.id, name: printer.name }, snapshot };
  }

  /**
   * Poll all printers now (manual trigger). ADMIN or OPERATOR, the roles that
   * run the printers; no screen calls it, and a read-only role has no reason to.
   */
  @Post('poll')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async pollAll() {
    const results = await this.moonraker.pollAllPrinters();
    return { polled: results.length, printers: results.map(r => ({
      printerId: r.printerId,
      state: r.snapshot.printerState,
      progress: r.snapshot.progress,
    }))};
  }

  /**
   * Send G-code to a printer.
   */
  @Post('gcode/:printerId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async sendGcode(
    @Param('printerId') printerId: string,
    @Body('gcode') gcode: string,
  ) {
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer?.moonrakerUrl) throw new BadRequestException('No Moonraker URL');
    if (!gcode) throw new BadRequestException('No gcode provided');

    const ok = await this.moonraker.sendGcode(printer.moonrakerUrl, gcode);
    return { success: ok };
  }

  /**
   * Control a print: pause, resume, or cancel.
   * Routes to the correct bridge based on connectionType. A physical action on
   * a live print, so ADMIN or OPERATOR like G-code above; VIEWER and ACCOUNTING
   * can watch printers but not stop them.
   */
  @Post('control/:printerId/:action')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async controlPrint(
    @Param('printerId') printerId: string,
    @Param('action') action: string,
  ) {
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new BadRequestException('Action must be pause, resume, or cancel');
    }

    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) throw new NotFoundException('Printer not found');

    if (printer.connectionType === 'CREALITY_WS') {
      const ok = await this.crealityWs.control(printerId, action as any);
      return { success: ok };
    }

    if (!printer.moonrakerUrl) throw new BadRequestException('No Moonraker URL');
    const ok = await this.moonraker.controlPrint(printer.moonrakerUrl, action as any);
    return { success: ok };
  }

  /**
   * Re-connect a Creality WebSocket printer immediately after its IP is updated.
   * The printer page calls it after saving the printer's details; ADMIN or
   * OPERATOR, like the other printer actions here.
   */
  @Post('reconnect/:printerId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async reconnectPrinter(@Param('printerId') printerId: string) {
    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) throw new NotFoundException('Printer not found');
    if (printer.connectionType !== 'CREALITY_WS') return { skipped: true };
    await this.crealityWs.reconnectPrinter(printerId);
    return { reconnecting: true };
  }
}
