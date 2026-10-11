import { HI, K1, M, P, sliceHarness, statusOf, stl, useTempUploadDir } from './__fixtures__/slice-harness';
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
    await expect(service.create(P, 'c1', body())).rejects.toThrow('NO_FILAMENT_PROFILE: "PLA Black" has no filament profile');
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
});

describe('list and cancel', () => {
  it('lists the last 20 runs newest first with the printer name; cancel drops a QUEUED run and refuses the rest', async () => {
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
    expect(await statusOf(service.cancel('nope'))).toBe(404);
  });
});
