import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs/promises';
import JSZip from 'jszip';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const ADDONS_DIR = path.join(UPLOAD_DIR, 'addons');

// A conservative slug: lowercase, starts alphanumeric, hyphens allowed.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

interface AddonManifest {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  version?: string;
  entry?: string;
}

@Injectable()
export class AddonsService {
  private readonly logger = new Logger(AddonsService.name);

  constructor(private prisma: PrismaService) {}

  /** Active addons, ordered for the sidebar. */
  listActive() {
    return this.prisma.addon.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, slug: true, name: true, icon: true, entry: true },
    });
  }

  /** All addons for the admin management screen. */
  listAll() {
    return this.prisma.addon.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async getBySlug(slug: string) {
    const addon = await this.prisma.addon.findUnique({ where: { slug } });
    if (!addon) throw new NotFoundException('Addon not found');
    return addon;
  }

  /**
   * Extract an uploaded addon zip to disk and upsert its registry row.
   * Guards against zip-slip, requires a valid addon.json manifest, and verifies
   * the declared entry file exists before committing.
   */
  async install(file: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(file.buffer);
    } catch {
      throw new BadRequestException('Uploaded file is not a valid zip archive');
    }

    // Normalize entry names: some zip tools (Windows Compress-Archive) use
    // backslash separators, which are not path separators on Linux.
    const norm = (name: string) => name.replace(/\\/g, '/');

    // Locate the manifest anywhere in the archive; its folder becomes the root
    // so a "zipped folder" (e.g. dist/addon.json) works as well as a flat zip.
    const manifestEntry = Object.values(zip.files).find(
      (f) => !f.dir && path.posix.basename(norm(f.name)) === 'addon.json',
    );
    if (!manifestEntry) {
      throw new BadRequestException('Archive is missing addon.json at its root');
    }
    const rootPrefix = path.posix.dirname(norm(manifestEntry.name)); // '.' when at top level

    let manifest: AddonManifest;
    try {
      manifest = JSON.parse(await manifestEntry.async('string'));
    } catch {
      throw new BadRequestException('addon.json is not valid JSON');
    }

    const slug = String(manifest.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'Manifest slug must be lowercase letters, numbers, and hyphens (2-41 chars)',
      );
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new BadRequestException('Manifest is missing a "name"');
    }
    const entry = (manifest.entry || 'index.html').replace(/^[./]+/, '');
    if (entry.includes('..') || path.isAbsolute(entry)) {
      throw new BadRequestException('Manifest entry path is invalid');
    }

    // Collect the files under the manifest root, stripping the prefix.
    const targetDir = path.join(ADDONS_DIR, slug);
    const entries: Array<{ rel: string; file: JSZip.JSZipObject }> = [];
    let entryFound = false;

    for (const f of Object.values(zip.files)) {
      if (f.dir) continue;
      let rel = norm(f.name);
      if (rootPrefix !== '.') {
        if (!rel.startsWith(rootPrefix + '/')) continue; // outside the addon root
        rel = rel.slice(rootPrefix.length + 1);
      }
      if (!rel) continue;

      // Zip-slip guard: the resolved path must stay inside targetDir.
      const resolved = path.resolve(targetDir, rel);
      const rootWithSep = targetDir.endsWith(path.sep) ? targetDir : targetDir + path.sep;
      if (resolved !== targetDir && !resolved.startsWith(rootWithSep)) {
        throw new BadRequestException(`Unsafe path in archive: ${f.name}`);
      }
      if (rel === entry) entryFound = true;
      entries.push({ rel, file: f });
    }

    if (!entryFound) {
      throw new BadRequestException(`Entry file "${entry}" not found in archive`);
    }

    // Commit: replace any existing install atomically-ish (wipe then write).
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    for (const { rel, file } of entries) {
      const dest = path.resolve(targetDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, await file.async('nodebuffer'));
    }

    const data = {
      name: manifest.name.slice(0, 120),
      description: manifest.description?.slice(0, 500) ?? null,
      icon: manifest.icon?.slice(0, 60) ?? null,
      version: (manifest.version || '0.0.0').slice(0, 40),
      entry,
      isActive: true,
    };
    const addon = await this.prisma.addon.upsert({
      where: { slug },
      create: { slug, ...data },
      update: data,
    });

    this.logger.log(`Installed addon "${slug}" v${addon.version} (${entries.length} files)`);
    return addon;
  }

  async update(id: string, patch: { isActive?: boolean; name?: string; sortOrder?: number }) {
    await this.getById(id);
    return this.prisma.addon.update({
      where: { id },
      data: {
        isActive: patch.isActive,
        name: patch.name?.slice(0, 120),
        sortOrder: patch.sortOrder,
      },
    });
  }

  async remove(id: string) {
    const addon = await this.getById(id);
    await fs.rm(path.join(ADDONS_DIR, addon.slug), { recursive: true, force: true });
    await this.prisma.addon.delete({ where: { id } });
    return { deleted: true };
  }

  private async getById(id: string) {
    const addon = await this.prisma.addon.findUnique({ where: { id } });
    if (!addon) throw new NotFoundException('Addon not found');
    return addon;
  }

  /**
   * Resolve a request for an addon asset to a safe absolute path on disk.
   * Returns null if the addon is inactive/missing or the path escapes its dir.
   */
  async resolveAsset(slug: string, assetPath: string): Promise<string | null> {
    if (!SLUG_RE.test(slug)) return null;
    const addon = await this.prisma.addon.findUnique({ where: { slug } });
    if (!addon || !addon.isActive) return null;

    const targetDir = path.join(ADDONS_DIR, slug);
    const clean = (assetPath || addon.entry).replace(/^\/+/, '') || addon.entry;
    const resolved = path.resolve(targetDir, clean);
    const rootWithSep = targetDir.endsWith(path.sep) ? targetDir : targetDir + path.sep;
    if (resolved !== targetDir && !resolved.startsWith(rootWithSep)) return null;

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    return resolved;
  }
}
