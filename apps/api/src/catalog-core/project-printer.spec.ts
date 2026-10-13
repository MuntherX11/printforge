import { DOLL, HI, K1, orderPlatesHarness } from '../order-plates/__fixtures__/order-plates-harness';
import { expectStatus } from '../production/__fixtures__/production-harness';
import { parseInputUnits } from '../slice/sidecar-slice.client';
import { pastCapacity, pastFillUnits } from '../slice/fill-units';
import { useTempUploadDir } from '../slice/__fixtures__/slice-harness';
import { CatalogRequestContext } from './catalog-context';
import { suggestJobPlates } from './job-plate-suggestion';
import { isMultiColourProject, projectPrinterOf } from './project-printer';

/**
 * The printer lock of a multi-colour project (v2.19.0, the live gap): "New job"
 * with another printer planned such a part as single-unit plates. Its plates
 * now belong to the project's printer in every plan.
 */

useTempUploadDir();

const meta = (slots: number, printerModel: string | null = 'Creality Hi', printerId: string | null = null) =>
  ({ printerModel, printerId, slots: Array.from({ length: slots }, (_, i) => ({ colorIndex: i, profile: null, colorHex: null, materialId: null })) });
const PRINTERS = [{ id: K1, name: 'K1', model: 'Creality K1', isActive: true }, { id: HI, name: 'Hi', model: 'Creality Hi', isActive: true }];

describe('which parts are locked, and to which printer', () => {
  const part = (o: Record<string, unknown> = {}) => ({ sourceKind: 'THREEMF' as const, isMultiColor: false, materialId: 'm', materials: [], ...o });

  it('a project with two or more slots, or of a multi-colour part; never an STL or a one-slot project', () => {
    expect(isMultiColourProject(part(), meta(2))).toBe(true);
    expect(isMultiColourProject(part({ isMultiColor: true, materialId: null, materials: [{ colorIndex: 0 }, { colorIndex: 1 }] }) as any, meta(1))).toBe(true);
    expect(isMultiColourProject(part(), meta(1))).toBe(false);
    expect(isMultiColourProject(part(), null)).toBe(false);
    expect(isMultiColourProject(part({ sourceKind: 'STL' }) as any, meta(3))).toBe(false);
  });

  it('the printer the project names, else the one matched at upload; an inactive printer is no printer', () => {
    expect(projectPrinterOf(meta(2), PRINTERS)?.id).toBe(HI);
    expect(projectPrinterOf(meta(2, 'Bambu X1', K1), PRINTERS)?.id).toBe(K1);
    expect(projectPrinterOf(meta(2, 'Bambu X1'), PRINTERS)).toBeNull();
    expect(projectPrinterOf(meta(2), [PRINTERS[0], { ...PRINTERS[1], isActive: false }])).toBeNull();
  });
});

describe('every plan keeps a multi-colour project on its printer', () => {
  async function doll() {
    const x = orderPlatesHarness();
    await x.seedFiles();
    return x;
  }

  it('the part\'s plates are the project printer\'s; the one-slot project and the STL parts stay free', async () => {
    const x = await doll();
    const bom = await x.h.resolver.resolve(DOLL, { sizeOptionId: null, colourOptionId: null }, new CatalogRequestContext());
    const printerOf = (id: string) => bom.components.find((c) => c.componentId === id)!.layouts.map((l) => l.printerId ?? null);
    expect(printerOf('face')).toEqual([HI]);
    expect(bom.components.find((c) => c.componentId === 'face')!.layouts[0]).toMatchObject({ layoutId: null, printerName: 'Hi' });
    for (const free of ['dress', 'hat', 'shoe', 'badge']) expect(printerOf(free)).toEqual([null]);
    expect(printerOf('stand')).toEqual([null, null]);

    const face = bom.components.find((c) => c.componentId === 'face')!.layouts;
    expect(suggestJobPlates(3, face, undefined, { printer: { id: K1, name: 'K1' } })).toMatchObject({ plates: [], blocked: true, missingFor: { id: K1 } });
    expect(suggestJobPlates(3, face, undefined, { printer: { id: HI, name: 'Hi' } }).plates).toEqual([expect.objectContaining({ plateCount: 3 })]);
  });

  it('"New job" for another printer: the preview says so and the job is refused, instead of single-unit plates', async () => {
    const x = await doll();
    const preview: any = await x.h.jobs.preview({ productId: DOLL, quantity: 2, printerId: K1 });
    expect(preview.problems).toEqual(expect.arrayContaining([{ code: 'NO_PLATE_FOR_PRINTER', componentId: 'face', message: 'No plate sliced for K1 for "face"' }]));
    expect(preview.components.find((c: any) => c.componentId === 'face').plates).toEqual([]);
    expect(preview.ready).toBe(false);
    await expectStatus(x.h.jobs.create({ productId: DOLL, quantityToProduce: 2, printerId: K1 }), 400, 'No plate sliced for K1 for "face"');
    expect(x.db.t('productionJob')).toEqual([]);
  });

  it('on its own printer, or with none chosen, it plans as before — and the job is the Hi\'s', async () => {
    const x = await doll();
    const onHi: any = await x.h.jobs.preview({ productId: DOLL, quantity: 2, printerId: HI });
    expect(onHi.problems.filter((p: any) => p.code === 'NO_PLATE_FOR_PRINTER')).toEqual([]);
    expect(onHi.components.find((c: any) => c.componentId === 'face').plates).toEqual([expect.objectContaining({ unitsPerPlate: 1, plateCount: 2, printerId: HI })]);
    const free: any = await x.h.jobs.preview({ productId: DOLL, quantity: 2 });
    expect(free).toMatchObject({ planPrinterId: HI, planPrinterName: 'Hi' });
    const job: any = await x.h.jobs.create({ productId: DOLL, quantityToProduce: 1 });
    expect(job.printerId).toBe(HI);
  });

  it('the order\'s production plan gives the row its project\'s printer', async () => {
    const x = await doll();
    const o = x.order(2);
    const plan: any = await x.h.planning.previewPlan(o.id);
    const face = plan.rows.find((r: any) => r.componentId === 'face');
    expect(face).toMatchObject({ printerId: HI, printerName: 'Hi' });
    expect(face.layouts[0]).toMatchObject({ printerId: HI });
    expect(plan.rows.find((r: any) => r.componentId === 'dress').printerId).toBe(K1);
  });

  it('a project whose printer matches none of the farm\'s is not locked (there is nothing to lock it to)', async () => {
    const x = await doll();
    const source = x.db.t('attachment').find((a: any) => a.id === x.comp('face').sourceAttachmentId);
    source.parsedMetadata = { ...source.parsedMetadata, printerModel: 'Bambu X1', printerId: null };
    const bom = await x.h.resolver.resolve(DOLL, { sizeOptionId: null, colourOptionId: null }, new CatalogRequestContext());
    expect(bom.components.find((c) => c.componentId === 'face')!.layouts[0].printerId ?? null).toBeNull();
  });
});

describe('small helpers this release added to the slice module', () => {
  it('pastCapacity: what the newest run that hit the plate\'s capacity placed', () => {
    const runs = [{ unitsRequested: 12, unitsSliced: 12 }, { unitsRequested: 100, unitsSliced: 15 }, { unitsRequested: 100, unitsSliced: 9 }];
    expect(pastCapacity(runs)).toBe(15);
    expect(pastFillUnits(runs)).toBe(17);
    expect(pastCapacity([{ unitsRequested: 1, unitsSliced: 1 }, { unitsRequested: 5, unitsSliced: null }])).toBeNull();
  });

  it('parseInputUnits: whole numbers from 0, one per input, or null', () => {
    expect(parseInputUnits('[16,0,3]')).toEqual([16, 0, 3]);
    expect(parseInputUnits('[]')).toEqual([]);
    for (const bad of [null, undefined, '', '16', '{"a":1}', '[1.5]', '[-1]', '["2"]', '[1,', 'null']) expect(parseInputUnits(bad)).toBeNull();
  });
});
