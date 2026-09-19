import { BOX_ID, boxRow } from '../catalog-core/__fixtures__/box-product';
import { MoonrakerService } from '../moonraker-bridge/moonraker.service';
import { cancelQueuedJobsForItem, LINE_STARTED_MESSAGE } from './job-transitions';
import { addJobRow, addOrder, expectStatus, productionHarness } from './__fixtures__/production-harness';

/** §3.9 S11 job half (WP6 for WP7), §7.1 item 38. */
function setup() {
  const h = productionHarness([boxRow()]);
  const { order, items } = addOrder(h.db, [{ productId: BOX_ID, quantity: 12 }, { productId: BOX_ID, quantity: 5 }]);
  const [line, other] = items;
  const mk = (orderItemId: string, status: string, name: string, extra: Record<string, unknown> = {}) =>
    addJobRow(h.db, { orderId: order.id, orderItemId, productId: BOX_ID, componentId: 'box', status, name, printerId: 'pr-1', ...extra });
  return { h, order, line, other, mk };
}

const statusOf = (h: ReturnType<typeof productionHarness>, id: string) => h.db.t('productionJob').find((j: any) => j.id === id).status;

describe('cancelQueuedJobsForItem', () => {
  it('cancels only the QUEUED jobs of that line and returns them', async () => {
    const { h, line, other, mk } = setup();
    const a = mk(line.id, 'QUEUED', 'Box (×6) a');
    const b = mk(line.id, 'QUEUED', 'Box (×6) b');
    const done = mk(line.id, 'CANCELLED', 'old');
    const failed = mk(line.id, 'FAILED', 'failed');
    const elsewhere = mk(other.id, 'QUEUED', 'other line');
    const cancelled = await h.db.$transaction((tx: any) => cancelQueuedJobsForItem(tx, line.id));
    expect(cancelled.map((j: any) => j.id).sort()).toEqual([a.id, b.id].sort());
    expect(cancelled.every((j: any) => j.name.startsWith('Box'))).toBe(true);
    expect([statusOf(h, a.id), statusOf(h, b.id), statusOf(h, done.id), statusOf(h, failed.id), statusOf(h, elsewhere.id)])
      .toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED', 'FAILED', 'QUEUED']);
  });

  it('a placeholder job of the line is cancelled with the others', async () => {
    const { h, line, mk } = setup();
    const ph = mk(line.id, 'QUEUED', 'placeholder', { productId: null, componentId: null });
    expect((await h.db.$transaction((tx: any) => cancelQueuedJobsForItem(tx, line.id))).map((j: any) => j.id)).toEqual([ph.id]);
  });

  it.each(['IN_PROGRESS', 'PAUSED', 'COMPLETED'])('with one %s job → 409 and nothing changed', async (started) => {
    const { h, line, mk } = setup();
    const queued = mk(line.id, 'QUEUED', 'q');
    mk(line.id, started, 's');
    await expectStatus(h.db.$transaction((tx: any) => cancelQueuedJobsForItem(tx, line.id)), 409, LINE_STARTED_MESSAGE);
    expect(statusOf(h, queued.id)).toBe('QUEUED');
  });

  describe('race with a printer bridge\'s guarded QUEUED → IN_PROGRESS flip: exactly one wins', () => {
    const bridge = (h: ReturnType<typeof productionHarness>) => new MoonrakerService(h.db as any, { create: jest.fn() } as any, h.completion);
    const started = { hostname: 'x', printerState: 'printing', progress: 0, heaterBed: null, extruder: null, printStats: { filename: 'Box x12.gcode', total_duration: 0, print_duration: 0, filament_used: 0, state: 'printing', message: '' } };

    it('the flip lands between S11\'s read and its update → S11 matches nothing, sees the started job and returns 409', async () => {
      const { h, line, mk } = setup();
      const job = mk(line.id, 'QUEUED', 'Box ×12', { gcodeFilename: 'Box x12.gcode' });
      const tx: any = Object.create(h.db);
      tx.productionJob = { ...h.db.productionJob };
      tx.productionJob.updateMany = async (args: any) => {
        await bridge(h).handleJobStarted('pr-1', started as any); // barrier: the bridge commits first
        return h.db.productionJob.updateMany(args);
      };
      await expectStatus(cancelQueuedJobsForItem(tx, line.id), 409, LINE_STARTED_MESSAGE);
      expect(statusOf(h, job.id)).toBe('IN_PROGRESS');
    });

    it('S11 commits first → the bridge\'s flip matches nothing and the job stays cancelled', async () => {
      const { h, line, mk } = setup();
      const job = mk(line.id, 'QUEUED', 'Box ×12', { gcodeFilename: 'Box x12.gcode' });
      await h.db.$transaction((tx: any) => cancelQueuedJobsForItem(tx, line.id));
      await bridge(h).handleJobStarted('pr-1', started as any);
      expect(statusOf(h, job.id)).toBe('CANCELLED');
    });
  });
});
