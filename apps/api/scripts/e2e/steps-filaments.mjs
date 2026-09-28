/**
 * Steps 25–27: the Filaments release safety fixes (safety spec §1–§3).
 * 25 spool data is staff-only; 26 spool delete keeps job history; 27 the
 * duplicate brand + type + colour guard. Every row it makes is named <ts> and
 * the filaments carry the per-run brand <ts>, so a second run against the same
 * database passes too.
 */
import { check, eq } from './client.mjs';

const STAFF_ONLY = 'Staff access only';

async function step25(ctx) {
  const { admin, viewer, customer, anon, ids, ts } = ctx;
  const shelf = await admin.ok('POST', '/locations', { name: `${ts} shelf` });
  const pfid = (await admin.ok('GET', `/spools/${ids.redSpool}`)).printforgeId;
  check(pfid, 'the red spool has a PF-ID');
  try {
    await anon.get(`/spools/by-pfid/${pfid}`, { expect: 401 });
    await anon.get('/spools', { expect: 401 });

    const qr = await customer.get(`/spools/by-pfid/${pfid}`, { expect: 403 });
    eq(qr.body?.error, STAFF_ONLY, 'customer on the QR spool endpoint');
    check(!('printforgeId' in (qr.body ?? {})) && !('data' in (qr.body ?? {})), 'the 403 body carries no spool fields');
    for (const path of [
      '/spools', `/spools/${ids.redSpool}`, `/materials/${ids.red}`,
      '/locations', `/locations/${shelf.id}`, `/locations/${shelf.id}/assignable-spools`,
    ]) {
      const r = await customer.get(path, { expect: 403 });
      eq(r.body?.error, STAFF_ONLY, `customer GET ${path}`);
    }
    const list = await customer.get('/materials?limit=500', { expect: 200 });
    check(Array.isArray(list.data) && list.data.length > 0, 'the customer quick quote still lists filaments');

    const seen = await viewer.get(`/spools/by-pfid/${pfid}`, { expect: 200 });
    eq(seen.data?.printforgeId, pfid, 'viewer on the QR spool endpoint');

    // QR exports: ADMIN and OPERATOR as before, VIEWER still refused.
    const png = await admin.get(`/spools/${ids.redSpool}/qr.png`, { raw: true, expect: 200 });
    eq(png.headers.get('content-type'), 'image/png', 'qr.png content-type');
    const pdf = await admin.req('POST', '/spools/qr-labels', { json: { spoolIds: [ids.redSpool] }, raw: true, expect: [200, 201] });
    eq(pdf.headers.get('content-type'), 'application/pdf', 'qr-labels content-type');
    const zip = await admin.req('POST', '/spools/qr-images', { json: { spoolIds: [ids.redSpool] }, raw: true, expect: [200, 201] });
    eq(zip.headers.get('content-type'), 'application/zip', 'qr-images content-type');
    await viewer.get(`/spools/${ids.redSpool}/qr.png`, { raw: true, expect: 403 });
    await viewer.req('POST', '/spools/qr-labels', { json: { spoolIds: [ids.redSpool] }, raw: true, expect: 403 });
  } finally {
    await admin.del(`/locations/${shelf.id}`, { expect: 200 });
  }
}

async function step26(ctx) {
  const { admin, ids, ts } = ctx;
  const newSpool = () => admin.ok('POST', '/spools', { materialId: ids.black, initialWeight: 1000, currentWeight: 1000 });
  const testJob = (spoolId, expect) =>
    admin.req('POST', '/jobs', { json: { name: `${ts} spool history`, purpose: 'TEST', materials: [{ spoolId, gramsUsed: 5 }] }, expect });

  const spool = await newSpool();
  const label = spool.printforgeId;
  const job = (await testJob(spool.id, [200, 201])).data;

  const onJob = await admin.del(`/spools/${spool.id}`, { expect: 409 });
  eq(onJob.body?.code, 'SPOOL_ON_ACTIVE_JOB', 'delete a spool on a queued job');
  eq(onJob.body?.error, `${label} is on 1 active job and can't be deleted. When that job is finished or cancelled, deactivate the spool instead.`, 'active-job text');

  await admin.ok('PATCH', `/jobs/${job.id}`, { status: 'CANCELLED' });
  const history = await admin.del(`/spools/${spool.id}`, { expect: 409 });
  eq(history.body?.code, 'SPOOL_HAS_HISTORY', 'delete a spool used by a cancelled job');
  eq(history.body?.error, `${label} was used by 1 job and can't be deleted. Deactivate it instead — its job history is kept.`, 'history text');
  const kept = await admin.ok('GET', `/jobs/${job.id}`);
  check((kept.materials ?? []).some((m) => m.spoolId === spool.id && m.gramsUsed === 5), 'the job still has its 5 g line on that spool');

  await admin.ok('PATCH', `/spools/${spool.id}`, { isActive: false });
  const retired = await admin.del(`/spools/${spool.id}`, { expect: 409 });
  eq(retired.body?.code, 'SPOOL_HAS_HISTORY', 'delete a retired spool with history');
  check(/already inactive/.test(retired.body?.error ?? ''), `retired text: ${retired.body?.error}`);
  const refused = await testJob(spool.id, 400);
  check(/is inactive and can't be used/.test(refused.body?.error ?? ''), `test print on a retired spool: ${refused.body?.error}`);
  await admin.get(`/spools/${spool.id}`, { expect: 200 });

  const fresh = await newSpool();
  eq(await admin.ok('DELETE', `/spools/${fresh.id}`), { deleted: true }, 'a spool without history is deleted');
  await admin.get(`/spools/${fresh.id}`, { expect: 404 });
}

async function step27(ctx) {
  const { admin, ids, ts } = ctx;
  const dup = await admin.post('/materials', { name: `${ts} PLA red again`, type: 'PLA', color: ' red ', brand: ts.toLowerCase(), costPerGram: 0.01 }, { expect: 409 });
  eq([dup.body?.success, dup.body?.statusCode, dup.body?.code], [false, 409, 'MATERIAL_DUPLICATE'], 'duplicate create envelope');
  eq(dup.body?.existing?.id, ids.red, 'the 409 names the existing PLA Red');
  check(/ already exists as ".*" — add a spool to it instead$/.test(dup.body?.error ?? ''), `create text: ${dup.body?.error}`);

  const fer = (await admin.post('/materials', { name: `${ts} PLA Fire Engine Red`, type: 'PLA', color: 'Fire Engine Red', brand: ts, costPerGram: 0.012 }, { expect: 201 })).data;
  const moved = await admin.patch(`/materials/${fer.id}`, { color: 'RED' }, { expect: 409 });
  eq(moved.body?.code, 'MATERIAL_DUPLICATE', 'PATCH onto an existing identity');
  check(!/add a spool/.test(moved.body?.error ?? ''), `update text: ${moved.body?.error}`);
  eq((await admin.ok('GET', `/materials/${fer.id}`)).color, 'Fire Engine Red', 'colour unchanged after the 409');

  await admin.patch(`/materials/${ids.red}`, { type: 'PLA', brand: ts, color: 'Red', reorderPoint: 400 }, { expect: 200 });
  await admin.del(`/materials/${fer.id}`, { expect: 200 });
}

export const stepsFilaments = [
  [25, 'spool data is staff-only: anon 401, customer 403, viewer 200, QR exports unchanged', step25],
  [26, 'spool delete keeps history: 409 on an active job, 409 with history, retired spool refused, fresh spool deleted', step26],
  [27, 'duplicate filament guard: 409 MATERIAL_DUPLICATE, exact names distinct, price save on an unchanged identity', step27],
];
