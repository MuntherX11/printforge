import { HI, K1, M, P, sliceHarness, statusOf, stl, useTempUploadDir } from './__fixtures__/slice-harness';
import { writeUploadFile } from '../products/slicer-files';
import { PROJECT_FILL_UNITS } from './slice.service';

/** Slicer plan WP5: queueing a slice run — every missing profile is a 400 naming it, identical pending is 409, projects lock the printer. */

useTempUploadDir();

const body = (o: Record<string, unknown> = {}) => ({ materials: { '0': M.black }, units: 12, ...o });

describe('create: validation', () => {
  it('a part without a source model → 400 NO_SOURCE', async () => {
    const { service } = sliceHarness();
    await expect(service.create(P, 'c1', body())).rejects.toThrow('NO_SOURCE');
  });

  it('400 per missing profile kind: machine, default process (STL only), filament', async () => {
    const { service, profiles, seedSource } = sliceHarness();
    await seedSource('c1', 'STL');
    profiles.machines.delete(K1);
    await expect(service.create(P, 'c1', body())).rejects.toThrow('NO_MACHINE_PROFILE: K1 has no machine profile');
    profiles.machines.set(K1, { name: 'm' });
    profiles.processes.delete(K1);
    await expect(service.create(P, 'c1', body())).rejects.toThrow('NO_PROCESS_PROFILE: K1 has no default process profile');
    profiles.processes.set(K1, { name: 'p' });
    profiles.filaments.delete(M.black);
    await expect(service.create(P, 'c1', body())).rejects.toThrow('NO_FILAMENT_PROFILE: "PLA Black" has no slicer preset, and there is no main preset for PLA. Set one in Settings › Slicer');
    profiles.filaments.set(M.black, { name: 'f' });
    await expect(service.create(P, 'c1', body({ materials: { '0': 'm-gone' } }))).rejects.toThrow('SLOT_UNMAPPED: Slot 1 names a filament that no longer exists');
    expect(await statusOf(service.create(P, 'c1', body({ materials: { '0': 'm-gone' } })))).toBe(400);
  });

  it('a project with no printer match → 400 NO_MACHINE_PROFILE naming the model; a slot the owner left empty → SLOT_UNMAPPED', async () => {
    const { service, seedSource } = sliceHarness();
    await seedSource('c1', 'THREEMF', stl(), { printerModel: 'Bambu X1C', printerId: null, slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: null }] });
    await expect(service.create(P, 'c1', body({ materials: {} }))).rejects.toThrow('NO_MACHINE_PROFILE: The project is set up for "Bambu X1C"');
    await seedSource('c2', 'THREEMF', stl(), {
      printerModel: 'Creality Hi', printerId: HI,
      slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }, { colorIndex: 1, profile: null, colorHex: null, materialId: null }],
    });
    await expect(service.create(P, 'c2', body({ materials: { '0': M.black } }))).rejects.toThrow('SLOT_UNMAPPED: Slot 2 has no filament');
  });

  it('body allowlist: units 1..500 integer, slot keys "0".."3", units or fill required, no extra keys', async () => {
    const { service, seedSource } = sliceHarness();
    await seedSource('c1', 'STL');
    expect(await statusOf(service.create(P, 'c1', body({ units: 0 })))).toBe(400);
    expect(await statusOf(service.create(P, 'c1', body({ units: 501 })))).toBe(400);
    expect(await statusOf(service.create(P, 'c1', body({ units: 2.5 })))).toBe(400);
    expect(await statusOf(service.create(P, 'c1', body({ materials: { '4': M.black } })))).toBe(400);
    expect(await statusOf(service.create(P, 'c1', { materials: { '0': M.black } }))).toBe(400);
    expect(await statusOf(service.create(P, 'c1', body({ evil: 1 })))).toBe(400);
    expect(await statusOf(service.create(P, 'c-none', body()))).toBe(404);
    expect(await statusOf(service.create('p-other', 'c1', body()))).toBe(404);
  });
});

describe('assertSliceable: the same checks for a model that is not a part yet', () => {
  const none = { printerModel: null, printerId: null, slots: [] };
  const stlOn = (o: Record<string, unknown> = {}) => ({ kind: 'STL' as const, meta: none, printerId: K1 as string | null, defaultPrinterId: null as string | null, materials: { '0': M.black } as Record<string, string>, ...o });

  it('passes with every profile in place and writes nothing', async () => {
    const x = sliceHarness();
    await expect(x.service.assertSliceable(stlOn())).resolves.toBeUndefined();
    expect(x.db.t('sliceRun')).toHaveLength(0);
  });

  it('400 with the message create gives: printer, machine, default process (STL only), slot, filament preset', async () => {
    const x = sliceHarness();
    const name = x.db.t('printer').find((p: any) => p.id === K1).name;
    await expect(x.service.assertSliceable(stlOn({ printerId: null }))).rejects.toThrow('NO_MACHINE_PROFILE: Choose a printer — the product has no pricing printer');
    await expect(x.service.assertSliceable(stlOn({ printerId: null, defaultPrinterId: HI }))).resolves.toBeUndefined();
    await expect(x.service.assertSliceable(stlOn({ printerId: 'pr-gone' }))).rejects.toThrow('NO_MACHINE_PROFILE: That printer is not active');
    await expect(x.service.assertSliceable(stlOn({ materials: {} }))).rejects.toThrow('SLOT_UNMAPPED: Slot 1 has no filament');
    await expect(x.service.assertSliceable(stlOn({ materials: { '0': 'm-gone' } }))).rejects.toThrow('SLOT_UNMAPPED: Slot 1 names a filament that no longer exists');
    x.profiles.filaments.delete(M.black);
    await expect(x.service.assertSliceable(stlOn())).rejects.toThrow('NO_FILAMENT_PROFILE: "PLA Black" has no slicer preset, and there is no main preset for PLA. Set one in Settings › Slicer');
    x.profiles.filaments.set(M.black, { name: 'Generic PLA' });
    x.profiles.processes.delete(K1);
    await expect(x.service.assertSliceable(stlOn())).rejects.toThrow(`NO_PROCESS_PROFILE: ${name} has no default process profile — set one in Settings › Slicer`);
    // A project carries its own process, and is locked to its printer whatever is asked for.
    const project = { kind: 'THREEMF' as const, meta: { printerModel: 'Creality K1', printerId: K1, slots: [{ colorIndex: 0 }, { colorIndex: 1 }] as any }, printerId: HI, defaultPrinterId: null, materials: { '0': M.black, '1': M.red } as Record<string, string> };
    await expect(x.service.assertSliceable(project)).resolves.toBeUndefined();
    await expect(x.service.assertSliceable({ ...project, materials: { '0': M.black } })).rejects.toThrow('SLOT_UNMAPPED: Slot 2 has no filament');
    x.profiles.machines.delete(K1);
    await expect(x.service.assertSliceable(project)).rejects.toThrow(`NO_MACHINE_PROFILE: ${name} has no machine profile — import one in Settings › Slicer`);
    await expect(x.service.assertSliceable(project)).rejects.toMatchObject({ status: 400 });
  });
});

describe('create: the run', () => {
  it('queues a QUEUED run with the filament snapshot and the printer; 409 when the same slice is pending', async () => {
    const { service, seedSource, run } = sliceHarness();
    await seedSource('c1', 'STL');
    const dto = await service.create(P, 'c1', body());
    expect(dto).toMatchObject({
      componentId: 'c1', printerId: K1, printerName: 'K1', unitsRequested: 12, unitsSliced: null, status: 'QUEUED', error: null, resultLayoutId: null,
      filamentMap: { '0': { materialId: M.black, name: 'PLA Black', type: 'PLA' } },
    });
    expect(run(dto.id)).toMatchObject({ status: 'QUEUED', unitsRequested: 12 });
    await expect(service.create(P, 'c1', body())).rejects.toThrow('IDENTICAL_PENDING');
    expect(await statusOf(service.create(P, 'c1', body()))).toBe(409);
    // Another filament, another count or another printer is a different slice.
    await expect(service.create(P, 'c1', body({ materials: { '0': M.red } }))).resolves.toMatchObject({ status: 'QUEUED' });
    await expect(service.create(P, 'c1', body({ units: 13 }))).resolves.toMatchObject({ unitsRequested: 13 });
    await expect(service.create(P, 'c1', body({ printerId: HI }))).resolves.toMatchObject({ printerId: HI, printerName: 'Hi' });
    // Once the first is done, the same slice can be asked for again.
    run(dto.id).status = 'DONE';
    await expect(service.create(P, 'c1', body())).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('an STL part slices on the printer asked for, else the product pricing printer; a project is locked to its own', async () => {
    const { service, seedSource, h } = sliceHarness();
    await seedSource('c1', 'STL');
    await expect(service.create(P, 'c1', body({ printerId: HI }))).resolves.toMatchObject({ printerId: HI });
    await expect(service.create(P, 'c1', body())).resolves.toMatchObject({ printerId: K1 });
    h.db.t('product')[0].defaultPrinterId = null;
    await expect(service.create(P, 'c1', body({ units: 3 }))).rejects.toThrow('NO_MACHINE_PROFILE: Choose a printer');
    await seedSource('c2', 'THREEMF', stl(), {
      printerModel: 'Creality Hi', printerId: HI,
      slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }, { colorIndex: 1, profile: null, colorHex: null, materialId: M.silver }],
    });
    const dto = await service.create(P, 'c2', body({ printerId: K1, materials: {} }));
    expect(dto).toMatchObject({ printerId: HI, filamentMap: { '0': { materialId: M.black }, '1': { materialId: M.silver } } });
    // The owner's own choice for a slot wins over the project's match.
    await expect(service.create(P, 'c2', body({ materials: { '1': M.red } }))).resolves.toMatchObject({ filamentMap: { '0': { materialId: M.black }, '1': { materialId: M.red } } });
  });

  it('the validation run falls back to the part\'s own filament', async () => {
    const { service, seedSource } = sliceHarness();
    await seedSource('c1', 'STL');
    const dto = await service.create(P, 'c1', { materials: {}, units: 1 }, true);
    expect(dto).toMatchObject({ unitsRequested: 1, filamentMap: { '0': { materialId: M.black } } });
  });

  it('fill: the bounding-box estimate for an STL (20 mm part on a 220 mm bed → 77), a fixed 100 for a project', async () => {
    const { service, seedSource } = sliceHarness();
    await seedSource('c1', 'STL', stl(20, 20, 5));
    await expect(service.create(P, 'c1', { materials: { '0': M.black }, fill: true })).resolves.toMatchObject({ unitsRequested: 77 });
    await seedSource('c2', 'THREEMF', stl(), { printerModel: 'Creality Hi', printerId: HI, slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }] });
    await expect(service.create(P, 'c2', { materials: {}, fill: true })).resolves.toMatchObject({ unitsRequested: PROJECT_FILL_UNITS });
  });

  it('fill for a project: once a run on that printer placed fewer units than asked for, ask for those + 2', async () => {
    const { service, seedSource, db } = sliceHarness();
    const map = { '0': { materialId: M.black, name: 'PLA Black', type: 'PLA' } };
    const past = (o: Record<string, unknown>) => db.insert('sliceRun', { componentId: 'c2', printerId: HI, filamentMap: map, status: 'DONE', createdAt: new Date(Date.now() + 1000), ...o });
    // A run of the previous source says nothing about this one.
    db.insert('sliceRun', { componentId: 'c2', printerId: HI, filamentMap: map, status: 'DONE', unitsRequested: 100, unitsSliced: 6, createdAt: new Date(Date.now() - 60_000) });
    await seedSource('c2', 'THREEMF', stl(), { printerModel: 'Creality Hi', printerId: HI, slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }] });
    const fill = () => service.create(P, 'c2', { materials: {}, fill: true });
    past({ unitsRequested: 1, unitsSliced: 3 }); // the validation run: bodies, not units
    past({ unitsRequested: 12, unitsSliced: 12 }); // everything fitted: no capacity known
    past({ unitsRequested: 100, unitsSliced: 9, printerId: K1 }); // another printer's bed
    past({ unitsRequested: 100, unitsSliced: 8, status: 'FAILED' });
    past({ unitsRequested: 100, unitsSliced: 7, componentId: 'c1' });
    const first = await fill();
    expect(first.unitsRequested).toBe(PROJECT_FILL_UNITS);
    // That run comes back with 15 on the plate.
    Object.assign(db.t('sliceRun').find((r: any) => r.id === first.id), { status: 'DONE', unitsSliced: 15 });
    const second = await fill();
    expect(second.unitsRequested).toBe(17);
    Object.assign(db.t('sliceRun').find((r: any) => r.id === second.id), { status: 'DONE', unitsSliced: 15 });
    await expect(fill()).resolves.toMatchObject({ unitsRequested: 17 });
  });
});

describe('fill for a project: the estimate from the sliced x1 file of the part', () => {
  const project = { printerModel: 'Creality Hi', printerId: HI, slots: [{ colorIndex: 0, profile: null, colorHex: null, materialId: M.black }] };
  // One unit of two bodies: x 100..162, y 110..150 → 62 x 40 mm.
  const DEFINES = [
    'EXCLUDE_OBJECT_DEFINE NAME=whistle_body.stl_id_0_copy_0 CENTER=121.5,130 POLYGON=[[100,110],[143,110],[143,150],[100,150]]',
    'EXCLUDE_OBJECT_DEFINE NAME=whistle_cap.stl_id_1_copy_0 CENTER=155,125.25 POLYGON=[[148,118.5],[162,118.5],[162,132],[148,132]]',
  ].join('\n');
  const x1 = (area: string | null = '0x0,260x0,260x260,0x260', head = DEFINES) =>
    Buffer.from(`; generated by OrcaSlicer 2.3.0\n${head}\nG28\nG1 X100 Y110 E0.4\n; CONFIG_BLOCK_START\n${area ? `; printable_area = ${area}\n` : ''}; CONFIG_BLOCK_END\n`);

  async function setup(file: Buffer | null) {
    const x = sliceHarness();
    await x.seedSource('c2', 'THREEMF', stl(), project);
    const c = x.db.t('productComponent').find((r: any) => r.id === 'c2');
    c.attachmentId = null;
    if (file) {
      const stored = await writeUploadFile(file, 'gcode');
      c.attachmentId = x.db.insert('attachment', {
        entityType: 'product', entityId: P, filename: stored.filename, originalName: 'x1.gcode', mimeType: 'text/x-gcode', sizeBytes: stored.sizeBytes, storagePath: stored.storagePath,
      }).id;
    }
    const fill = () => x.service.create(P, 'c2', { materials: {}, fill: true });
    return { ...x, fill, c };
  }

  it('no earlier fill: the footprint on the bed the file names (15 in a grid on 260 mm, +20 % = 18), not 100', async () => {
    const { fill } = await setup(x1());
    await expect(fill()).resolves.toMatchObject({ unitsRequested: 18 });
  });

  it('a file that does not name its bed uses the bed of the machine profile (220 mm: 3 x 4 = 12, +20 % = 15)', async () => {
    const { fill } = await setup(x1(null));
    await expect(fill()).resolves.toMatchObject({ unitsRequested: 15 });
  });

  it('a small unit is capped at 100', async () => {
    const { fill } = await setup(x1('0x0,260x0,260x260,0x260', 'EXCLUDE_OBJECT_DEFINE NAME=pin.stl_1 CENTER=5,5 POLYGON=[[0,0],[10,0],[10,10],[0,10]]'));
    await expect(fill()).resolves.toMatchObject({ unitsRequested: PROJECT_FILL_UNITS });
  });

  it('no x1 file, a file with no object polygons, a file gone from disk → 100', async () => {
    await expect((await setup(null)).fill()).resolves.toMatchObject({ unitsRequested: PROJECT_FILL_UNITS });
    await expect((await setup(x1('0x0,260x0,260x260,0x260', 'G92 E0'))).fill()).resolves.toMatchObject({ unitsRequested: PROJECT_FILL_UNITS });
    const gone = await setup(x1());
    const att = gone.db.t('attachment').find((a: any) => a.id === gone.c.attachmentId);
    att.storagePath = 'gcode/not-there.gcode';
    await expect(gone.fill()).resolves.toMatchObject({ unitsRequested: PROJECT_FILL_UNITS });
  });

  it('a previous fill that hit capacity wins over the estimate', async () => {
    const { fill, db } = await setup(x1());
    const first = await fill();
    expect(first.unitsRequested).toBe(18);
    Object.assign(db.t('sliceRun').find((r: any) => r.id === first.id), { status: 'DONE', unitsSliced: 15 });
    await expect(fill()).resolves.toMatchObject({ unitsRequested: 17 });
  });
});

describe('list and cancel', () => {
  it('lists the last 20 runs newest first with the printer name; DELETE drops a QUEUED run (cancel) and a FAILED run (dismiss), and refuses RUNNING and DONE', async () => {
    const { service, seedSource, db } = sliceHarness();
    await seedSource('c1', 'STL');
    for (let i = 0; i < 23; i++) {
      db.insert('sliceRun', { componentId: 'c1', printerId: K1, unitsRequested: i + 1, filamentMap: { '0': { materialId: M.black, name: 'PLA Black', type: 'PLA' } }, status: i % 2 ? 'DONE' : 'QUEUED', createdAt: new Date(1_700_000_000_000 + i * 1000) });
    }
    const list = await service.list(P, 'c1');
    expect(list).toHaveLength(20);
    expect(list[0]).toMatchObject({ unitsRequested: 23, printerName: 'K1' });
    expect(list[19].unitsRequested).toBe(4);
    expect(await statusOf(service.list(P, 'c-none'))).toBe(404);

    const queued = list.find((r) => r.status === 'QUEUED')!;
    await expect(service.cancel(queued.id)).resolves.toEqual({ deleted: true });
    expect(db.t('sliceRun').some((r: any) => r.id === queued.id)).toBe(false);
    const done = list.find((r) => r.status === 'DONE')!;
    expect(await statusOf(service.cancel(done.id))).toBe(409);
    expect(db.t('sliceRun').some((r: any) => r.id === done.id)).toBe(true);

    const row = (status: string, o: Record<string, unknown> = {}) => db.insert('sliceRun', { componentId: 'c1', printerId: K1, unitsRequested: 3, filamentMap: {}, status, ...o });
    const failed = row('FAILED', { error: 'The slicer failed while slicing this model', errorDetail: 'orca-slicer exited with code 156\nlog' });
    expect((await service.list(P, 'c1')).find((r) => r.id === failed.id)).toMatchObject({ error: 'The slicer failed while slicing this model', errorDetail: 'orca-slicer exited with code 156\nlog' });
    await expect(service.cancel(failed.id)).resolves.toEqual({ deleted: true });
    expect(db.t('sliceRun').some((r: any) => r.id === failed.id)).toBe(false);
    const running = row('RUNNING', { startedAt: new Date() });
    expect(await statusOf(service.cancel(running.id))).toBe(409);
    expect(db.t('sliceRun').some((r: any) => r.id === running.id)).toBe(true);
    expect(list[0].errorDetail).toBeNull();
    expect(await statusOf(service.cancel('nope'))).toBe(404);
  });
});
