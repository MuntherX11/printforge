'use client';

import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Image as ImageIcon, Star, Trash2, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ApiProductImage } from '@/lib/types/api';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  productId: string;
  /** null while loading or when the list failed to load. */
  images: ApiProductImage[] | null;
  loadError: string | null;
  canEdit: boolean;
  /** Reload the photo list (G1) after any change. */
  onChanged: () => Promise<void> | void;
}

const MAX_BYTES = 10 * 1024 * 1024;
const PER_REQUEST = 10;
const ALLOWED = /\.(jpe?g|png|webp)$/i;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Client-side pre-check only; the server sniffs the bytes and has the final word. */
function precheck(f: File): string | null {
  if (!ALLOWED.test(f.name) || (f.type && !ALLOWED_TYPES.has(f.type))) return `"${f.name}" is not a JPG, PNG or WebP image`;
  if (f.size > MAX_BYTES) return `"${f.name}" is over 10 MB`;
  return null;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Section J (spec §5.2): customer-visible product photos only (never slicer plate renders). */
export function ProductPhotosCard({ productId, images, loadError, canEdit, onChanged }: Props) {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ApiProductImage | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const rejected = files.map(precheck).filter((m): m is string => m !== null);
    if (rejected.length) {
      rejected.forEach(m => toast('error', m));
      return;
    }
    setUploading(true);
    let added = 0;
    try {
      for (let i = 0; i < files.length; i += PER_REQUEST) {
        const form = new FormData();
        files.slice(i, i + PER_REQUEST).forEach(f => form.append('files', f));
        const created = await api.postForm<ApiProductImage[]>(`/products/${productId}/images`, form);
        added += Array.isArray(created) ? created.length : 0;
      }
      toast('success', added === 1 ? 'Photo added' : `${added} photos added`);
    } catch (err) {
      // The server's message is shown verbatim (e.g. a file that isn't really an image).
      toast('error', errorText(err, 'Upload failed'));
    } finally {
      setUploading(false);
      await onChanged();
    }
  }

  async function reorder(ids: string[]) {
    setBusy(true);
    try {
      await api.put(`/products/${productId}/images/order`, { imageIds: ids });
      await onChanged();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t reorder the photos'));
    } finally {
      setBusy(false);
    }
  }

  function move(list: ApiProductImage[], index: number, to: number) {
    const ids = list.map(i => i.id);
    const [id] = ids.splice(index, 1);
    ids.splice(to, 0, id);
    void reorder(ids);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.delete(`/products/${productId}/images/${deleting.id}`);
      setDeleting(null);
      await onChanged();
    } catch (err) {
      setDeleteError(errorText(err, 'Delete failed'));
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (loadError && !images) {
    body = (
      <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">
        Couldn&apos;t load photos — {loadError}.{' '}
        <button type="button" className="underline" onClick={() => void onChanged()}>Retry</button>
      </p>
    );
  } else if (!images) {
    body = <Loading text="Loading photos…" />;
  } else if (images.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-gray-500 dark:text-gray-400">
        <ImageIcon className="h-8 w-8" aria-hidden="true" />
        <p className="text-sm">No photos yet.</p>
      </div>
    );
  } else {
    body = (
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((img, i) => (
          <li key={img.id} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="relative aspect-square bg-gray-100 dark:bg-gray-800">
              {/* Logged-in photo route (G5): must be fetched by the browser with the session cookie. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.originalName} className="h-full w-full object-cover" loading="lazy" />
              {i === 0 && (
                <span className="absolute left-2 top-2 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-medium text-white">Cover</span>
              )}
            </div>
            <div className="space-y-2 p-2">
              <p className="truncate text-xs text-gray-600 dark:text-gray-300" title={img.originalName}>{img.originalName}</p>
              {canEdit && (
                <div className="flex flex-wrap items-center gap-1">
                  {i > 0 && (
                    <Button variant="outline" size="sm" className="px-2" disabled={busy}
                      aria-label={`Set ${img.originalName} as cover`} onClick={() => move(images, i, 0)}>
                      <Star className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Set as cover
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="px-2" disabled={busy || i === 0}
                    aria-label={`Move ${img.originalName} left`} onClick={() => move(images, i, i - 1)}>
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button variant="outline" size="sm" className="px-2" disabled={busy || i === images.length - 1}
                    aria-label={`Move ${img.originalName} right`} onClick={() => move(images, i, i + 1)}>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button variant="outline" size="sm" className="ml-auto px-2 text-red-600 dark:text-red-400" disabled={busy}
                    aria-label={`Delete ${img.originalName}`} onClick={() => { setDeleteError(null); setDeleting(img); }}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="dark:text-gray-100">Photos</CardTitle>
        {canEdit && (
          <>
            <input ref={fileInput} type="file" multiple accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              className="hidden" onChange={e => void handleFiles(e)} />
            <Button size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <Upload className="mr-2 h-4 w-4" aria-hidden="true" /> {uploading ? 'Uploading…' : 'Add photos'}
            </Button>
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {body}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Photos are shown to staff and to signed-in customers in the shop. JPG, PNG or WebP, up to 10 MB each.
          Slicer plate previews stay on their components and are never shown here.
        </p>
      </CardContent>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete photo?"
        message={deleting ? `Delete "${deleting.originalName}"? It is removed from the shop straight away.` : ''}
        confirmLabel="Delete"
        destructive
        busy={busy}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}
