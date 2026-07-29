import { NotFoundException, Logger } from '@nestjs/common';
import { Generator } from './generator.interface';
import { NameplateGenerator } from './nameplate.generator';
import { loadAddonGenerators } from './addon-loader';

/**
 * Registry of server-side generators.
 *
 * Two sources:
 *  1. Built-in generators compiled into the API (the nameplate reference).
 *  2. Generators supplied by uploaded addons — see docs/ADDON_GENERATORS.md.
 *     Addons are built and shipped separately; they opt in by declaring a
 *     `generator` block in addon.json. Nothing is bundled into PrintForge.
 *
 * Either way the generator only supplies validation + geometry; the secure
 * pipeline (opaque storage, authorized download, rate limits) stays here.
 */
const BUILT_IN: Record<string, Generator> = {};
let addonGenerators: Record<string, Generator> = {};

function register(gen: Generator) {
  BUILT_IN[gen.key] = gen;
}

register(new NameplateGenerator());

/**
 * Discover generators from installed addons. Called at module init and again
 * after an addon is installed/removed so new generators appear without a
 * restart. Built-ins always win a key collision.
 */
export async function refreshAddonGenerators(): Promise<number> {
  const logger = new Logger('GeneratorRegistry');
  try {
    const loaded = await loadAddonGenerators();
    const next: Record<string, Generator> = {};
    for (const gen of loaded) {
      if (BUILT_IN[gen.key]) {
        logger.warn(`Addon generator "${gen.key}" collides with a built-in; ignored`);
        continue;
      }
      next[gen.key] = gen;
    }
    addonGenerators = next;
    return Object.keys(next).length;
  } catch (err: any) {
    logger.warn(`Addon generator discovery failed: ${err?.message}`);
    return 0;
  }
}

export function getGenerator(key: string): Generator {
  const gen = BUILT_IN[key] ?? addonGenerators[key];
  if (!gen) throw new NotFoundException(`Unknown generator "${key}"`);
  return gen;
}

export function listGenerators() {
  return [...Object.values(BUILT_IN), ...Object.values(addonGenerators)].map((g) => ({
    key: g.key,
    name: g.name,
    description: g.description,
    source: BUILT_IN[g.key] ? ('built-in' as const) : ('addon' as const),
  }));
}
