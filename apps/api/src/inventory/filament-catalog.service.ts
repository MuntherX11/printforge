import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deltaE } from '../common/utils/colour';
import * as fs from 'fs';
import * as path from 'path';

const FILAMENT_BRANDS_KEY = 'filament_brands_enabled';

// The brands this workshop buys. Everything else in the catalogue starts off,
// so the dropdowns open on a short list rather than 150 names.
const DEFAULT_ENABLED_BRANDS = ['eSUN', 'Polymaker', 'Bambu Lab'];

/**
 * The bundled filamentcolors.xyz swatch list (CC BY 4.0).
 *
 * Reference data, not stock: picking a swatch fills in a Material's brand,
 * type, colour name and hex. It is seeded from a snapshot on disk rather than
 * fetched live so adding a filament keeps working when the upstream site is
 * slow or unreachable.
 */
@Injectable()
export class FilamentCatalogService implements OnModuleInit {
  private readonly logger = new Logger(FilamentCatalogService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // Seeding must never take the API down with it — a missing or malformed
    // snapshot costs the lookup feature, not the app.
    try {
      await this.seed();
    } catch (err) {
      this.logger.warn(`Filament catalogue not seeded: ${(err as Error).message}`);
    }
  }

  private snapshotPath() {
    // dist/inventory -> back to the package root, where data/ is shipped.
    const candidates = [
      path.join(__dirname, '..', '..', 'data', 'filament-catalog.json'),
      path.join(process.cwd(), 'data', 'filament-catalog.json'),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }

  async seed() {
    const file = this.snapshotPath();
    if (!file) {
      this.logger.warn('No filament-catalog.json found — swatch lookup unavailable');
      return { seeded: 0, skipped: true };
    }

    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const swatches: any[] = Array.isArray(raw?.swatches) ? raw.swatches : [];
    if (swatches.length === 0) return { seeded: 0, skipped: true };

    // Snapshot is immutable reference data, so re-seeding an unchanged file is
    // pointless work on every boot.
    const existing = await this.prisma.filamentCatalog.count();
    if (existing === swatches.length) return { seeded: existing, skipped: true };

    const rows = swatches
      .filter((s) => s?.id != null && s?.brand && s?.colour && s?.type && /^[0-9A-Fa-f]{6}$/.test(s.hex ?? ''))
      .map((s) => ({
        id: Number(s.id),
        brand: String(s.brand),
        colour: String(s.colour),
        type: String(s.type),
        family: s.family ? String(s.family) : null,
        hex: String(s.hex).toUpperCase(),
        hotEnd: Number.isFinite(s.hotEnd) ? Number(s.hotEnd) : null,
        bed: Number.isFinite(s.bed) ? Number(s.bed) : null,
      }));

    await this.prisma.$transaction([
      this.prisma.filamentCatalog.deleteMany({}),
      this.prisma.filamentCatalog.createMany({ data: rows }),
    ]);
    this.logger.log(`Seeded ${rows.length} filament swatches`);
    return { seeded: rows.length, skipped: false };
  }

  /**
   * Typeahead for the Add Filament form. Matches brand or colour, so both
   * "esun" and "fire engine" find the same swatch.
   */
  /**
   * Brands the workshop actually buys. The catalogue lists 150-odd, and a
   * dropdown of all of them is worse than useless when three are ever used —
   * so the list is opt-in, seeded with the three in use here.
   */
  private async enabledBrands(): Promise<string[]> {
    const raw = await this.prisma.systemSetting.findUnique({
      where: { key: FILAMENT_BRANDS_KEY },
    });
    if (!raw?.value) return [...DEFAULT_ENABLED_BRANDS];
    try {
      const parsed = JSON.parse(raw.value);
      // An explicitly empty list means "none", which is a real choice; only a
      // malformed value falls back to the defaults.
      return Array.isArray(parsed) ? parsed.map(String) : [...DEFAULT_ENABLED_BRANDS];
    } catch {
      return [...DEFAULT_ENABLED_BRANDS];
    }
  }

  /** Every brand in the catalogue, flagged with whether it is switched on. */
  async brandSettings() {
    const [rows, enabled] = await Promise.all([
      this.prisma.filamentCatalog.findMany({
        distinct: ['brand'], select: { brand: true }, orderBy: { brand: 'asc' },
      }),
      this.enabledBrands(),
    ]);
    const on = new Set(enabled.map((b) => b.toLowerCase()));
    const counts = await this.prisma.filamentCatalog.groupBy({
      by: ['brand'], _count: { _all: true },
    });
    const countBy = new Map(counts.map((c) => [c.brand, c._count._all]));

    return {
      brands: rows.map((r) => ({
        brand: r.brand,
        enabled: on.has(r.brand.toLowerCase()),
        swatches: countBy.get(r.brand) ?? 0,
      })),
      defaults: DEFAULT_ENABLED_BRANDS,
    };
  }

  async setEnabledBrands(brands: string[]) {
    const known = await this.prisma.filamentCatalog.findMany({
      distinct: ['brand'], select: { brand: true },
    });
    const byLower = new Map(known.map((k) => [k.brand.toLowerCase(), k.brand]));

    // Store the catalogue's own spelling, and drop anything unrecognised so a
    // stale name can't silently sit in the setting forever.
    const clean = Array.from(
      new Set(
        (brands ?? [])
          .map((b) => byLower.get(String(b).trim().toLowerCase()))
          .filter((b): b is string => !!b),
      ),
    ).sort((a, b) => a.localeCompare(b));

    await this.prisma.systemSetting.upsert({
      where: { key: FILAMENT_BRANDS_KEY },
      update: { value: JSON.stringify(clean) },
      create: { key: FILAMENT_BRANDS_KEY, value: JSON.stringify(clean) },
    });
    return { enabled: clean };
  }

  async search(query?: string, type?: string, limit = 25, brand?: string) {
    const q = (query ?? '').trim();
    // The New Material form pulls the whole catalogue once and narrows it locally,
    // so the ceiling has to clear the full swatch count.
    const take = Math.min(Math.max(Number(limit) || 25, 1), 5000);

    const where: any = {};
    if (q) {
      where.OR = [
        { brand: { contains: q, mode: 'insensitive' } },
        { colour: { contains: q, mode: 'insensitive' } },
      ];
    }
    // Exact brand, so picking "eSUN" cannot also pull in another brand whose
    // name happens to contain it.
    if (brand) where.brand = { equals: brand, mode: 'insensitive' };
    if (type) where.type = { contains: type, mode: 'insensitive' };
    // Disabled brands are invisible to the form, not merely deprioritised.
    // Kept as its own AND clause so it cannot collide with the brand filter
    // above — two conditions on one field would overwrite each other.
    where.AND = [{ brand: { in: await this.enabledBrands() } }];

    const results = await this.prisma.filamentCatalog.findMany({
      where,
      take,
      orderBy: [{ brand: 'asc' }, { colour: 'asc' }],
    });

    return {
      results,
      attribution: 'Swatch data from filamentcolors.xyz, CC BY 4.0',
    };
  }

  /**
   * Brands for the picker. Catalogue brands plus any already used in this
   * workshop, so a filament bought locally and typed in once keeps showing up
   * as a choice rather than having to be retyped every time.
   */
  async brands() {
    const [cat, mine] = await Promise.all([
      this.prisma.filamentCatalog.findMany({
        where: { brand: { in: await this.enabledBrands() } },
        distinct: ['brand'], select: { brand: true }, orderBy: { brand: 'asc' },
      }),
      this.prisma.material.findMany({
        where: { brand: { not: null } },
        distinct: ['brand'], select: { brand: true },
      }),
    ]);

    const seen = new Map<string, string>();
    for (const r of [...cat.map((c) => c.brand), ...mine.map((m) => m.brand!)]) {
      const key = r.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, r.trim());
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Suggest a catalogue hex for materials that don't have one yet.
   *
   * Only proposes; nothing is written. Brand and colour name must both match
   * for a suggestion to be offered, because guessing a colour from the name
   * alone is exactly the sloppiness the hex is meant to remove. `exact` marks
   * matches where the filament type agrees too.
   */
  async suggestHexForMaterials() {
    const materials = await this.prisma.material.findMany({
      where: { colorHex: null },
      select: { id: true, name: true, type: true, color: true, brand: true },
    });
    if (materials.length === 0) return { candidates: [], unmatched: [] };

    const catalogue = await this.prisma.filamentCatalog.findMany();
    const norm = (s?: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const candidates: any[] = [];
    const unmatched: any[] = [];

    for (const m of materials) {
      const mb = norm(m.brand);
      const mc = norm(m.color);
      if (!mb || !mc) { unmatched.push({ ...m, reason: 'no brand or colour recorded' }); continue; }

      const byBrand = catalogue.filter((c) => norm(c.brand) === mb);
      const sameColour = byBrand.filter((c) => norm(c.colour) === mc);
      if (sameColour.length === 0) { unmatched.push({ ...m, reason: 'no catalogue swatch for that brand and colour' }); continue; }

      // Prefer the swatch whose filament type also agrees.
      const typed = sameColour.find((c) => norm(c.type) === norm(m.type));
      const pick = typed ?? sameColour[0];
      candidates.push({
        materialId: m.id,
        material: [m.color, m.type, m.brand].filter(Boolean).join(' · '),
        hex: pick.hex,
        swatch: `${pick.brand} ${pick.colour} ${pick.type}`,
        exact: !!typed,
      });
    }

    return { candidates, unmatched };
  }

  /** Write suggested hexes. Explicit ids only — never a blanket apply. */
  async applyHex(updates: Array<{ materialId: string; hex: string }>) {
    const valid = (updates ?? []).filter(
      (u) => u?.materialId && /^#?[0-9A-Fa-f]{6}$/.test(u?.hex ?? ''),
    );
    if (valid.length === 0) return { updated: 0 };

    await this.prisma.$transaction(
      valid.map((u) =>
        this.prisma.material.update({
          where: { id: u.materialId },
          data: { colorHex: u.hex.replace('#', '').toUpperCase() },
        }),
      ),
    );
    return { updated: valid.length };
  }

  /** Nearest catalogue swatches to a hex — "what else looks like this?" */
  async nearest(hex: string, limit = 5) {
    const catalogue = await this.prisma.filamentCatalog.findMany();
    return catalogue
      .map((c) => ({ swatch: c, distance: deltaE(hex, c.hex) }))
      .filter((x) => x.distance !== null)
      .sort((a, b) => a.distance! - b.distance!)
      .slice(0, Math.min(Math.max(limit, 1), 25));
  }
}
