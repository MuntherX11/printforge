#!/usr/bin/env node
/**
 * Product rework end-to-end script (spec §7.2, WP11).
 *
 *   node apps/api/scripts/product-rework-e2e.mjs --api http://localhost:4000/api \
 *        --admin <email>:<pw> --viewer <email>:<pw> [--uploads-dir <path>] [--allow-remote]
 *
 * Runs steps 1–24 in order against a RUNNING API and stops at the first
 * failure. It WRITES: products, options, materials, spools, a printer, a
 * customer, orders, quotes, jobs and an invoice, all named E2E-<timestamp> so
 * it can run repeatedly, and it sets the cost settings to the §3.8 values
 * (overhead 15 %, electricity 0.025, purge 5 g, tax 0) for the run, restoring
 * the previous values at the end. Never point it at production: a non-local
 * --api needs --allow-remote (a staging copy only).
 *
 * --uploads-dir: the API's UPLOAD_DIR as seen from this machine (local stack),
 * for step 14's "image file gone from disk" check. Without it, step 14 checks
 * the photo URL instead and says so.
 *
 * Node 20+. No dependencies.
 */
import { AssertionError, Pacer, Session } from './e2e/client.mjs';
import { setup, restoreSettings } from './e2e/setup.mjs';
import { stepsCore } from './e2e/steps-core.mjs';
import { stepsProduction } from './e2e/steps-production.mjs';
import { stepsAccess } from './e2e/steps-access.mjs';
import { stepsOptions } from './e2e/steps-options.mjs';
import { stepsPerfAndConversion } from './e2e/steps-perf.mjs';

function parseArgs(argv) {
  const out = { api: null, admin: null, viewer: null, uploadsDir: null, allowRemote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--api') out.api = next();
    else if (a === '--admin') out.admin = creds(next(), a);
    else if (a === '--viewer') out.viewer = creds(next(), a);
    else if (a === '--uploads-dir') out.uploadsDir = next();
    else if (a === '--allow-remote') out.allowRemote = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node apps/api/scripts/product-rework-e2e.mjs --api <url>/api --admin <email>:<pw> --viewer <email>:<pw> [--uploads-dir <path>] [--allow-remote]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.api || !out.admin || !out.viewer) throw new Error('--api, --admin and --viewer are required (see --help)');
  return out;
}

function creds(v, flag) {
  const i = v.indexOf(':');
  if (i <= 0 || i === v.length - 1) throw new Error(`${flag} must be <email>:<password>`);
  return { email: v.slice(0, i), password: v.slice(i + 1) };
}

function isLocal(api) {
  const h = new URL(api).hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isLocal(args.api) && !args.allowRemote) {
    throw new Error(`${args.api} is not local. This script writes test data and changes settings; run it against a staging copy only, with --allow-remote.`);
  }
  const pacer = new Pacer();
  const ctx = {
    args,
    ts: `E2E-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    pacer,
    admin: new Session('admin', args.api, pacer),
    viewer: new Session('viewer', args.api, pacer),
    customer: new Session('customer', args.api, pacer),
    anon: new Session('anonymous', args.api, pacer),
    ids: {},
    timings: [],
    savedSettings: null,
  };
  console.log(`product-rework e2e against ${args.api} as ${ctx.ts}`);

  const steps = [...stepsCore, ...stepsProduction, ...stepsAccess, ...stepsOptions, ...stepsPerfAndConversion];
  let failed = null;
  const t0 = Date.now();
  try {
    await setup(ctx);
    for (const [n, title, fn] of steps) {
      const s0 = Date.now();
      try {
        await fn(ctx);
        console.log(`PASS ${String(n).padStart(2)}  ${title}  (${((Date.now() - s0) / 1000).toFixed(1)} s)`);
      } catch (e) {
        failed = { n, title, e };
        console.log(`FAIL ${String(n).padStart(2)}  ${title}`);
        console.log(`       ${e instanceof AssertionError ? e.message : e?.stack ?? e}`);
        break;
      }
    }
  } catch (e) {
    failed = failed ?? { n: 0, title: 'setup', e };
    console.log(`FAIL setup: ${e?.stack ?? e}`);
  } finally {
    try {
      await restoreSettings(ctx);
    } catch (e) {
      console.log(`WARNING: could not restore settings: ${e?.message ?? e}. Saved values: ${JSON.stringify(ctx.savedSettings)}`);
    }
  }

  if (ctx.timings.length) {
    console.log('\nperformance (median of 3 after one warm-up):');
    for (const t of ctx.timings) console.log(`  ${t.ok ? 'ok  ' : 'MISS'} ${t.name.padEnd(48)} ${t.ms.toFixed(0).padStart(6)} ms  (budget ${t.budget} ms)`);
  }
  console.log(`\ntest data prefix: ${ctx.ts}; ids: ${JSON.stringify(ctx.ids)}`);
  console.log(`429 retries: ${pacer.retries429}; total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (failed) {
    console.log(`\nRESULT: FAILED at step ${failed.n} (${failed.title})`);
    process.exit(1);
  }
  console.log(`\nRESULT: PASSED (${steps.length} steps)`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(2);
});
