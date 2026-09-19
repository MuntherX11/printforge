/**
 * WP11 price-impact report — local entry point (spec §6 WP11).
 *
 * The implementation lives in src/release/ so it is compiled into the API image
 * (dist/release/price-impact-report.main.js) and can run inside the api
 * container on the server. Locally, from apps/api:
 *
 *   DATABASE_URL=postgresql://…/printforge_restore npx ts-node scripts/price-impact-report.ts [--threshold 10] > price-impact.csv
 *
 * Read-only. See src/release/price-impact-report.main.ts for the guarantees.
 */
import { main } from '../src/release/price-impact-report.main';

main().catch((e) => {
  process.stderr.write(`price-impact report failed: ${e?.stack ?? e}\n`);
  process.exit(1);
});
