'use client';

import { useMemo, useState } from 'react';
import { FileCode, Plus, Upload } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import type { ProductDetail } from '@/lib/types/api';
import type { ProductPageData } from './useProduct';
import { BOM_SECTION_ID } from './useBomScope';
import { ComponentRow } from './ComponentRow';
import { AddComponentDialog } from './AddComponentDialog';
import { EditComponentDialog } from './EditComponentDialog';
import { PlateLayoutsDialog } from './PlateLayoutsDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { ColourLinksDialog, type ColourLinksFocus } from './ColourLinksDialog';
import { ThreeMfImportWizard } from './ThreeMfImportWizard';
import { useSlicerImport } from './useSlicerImport';
import { errorText } from './options-ui';
import { reorder } from './options-model';
import { componentsInScope, materialIndex, perProductTotals, scopeLabel, scopeOptions, scopeSizeOptionId } from './bom-model';

interface Props {
  data: ProductPageData;
  product: ProductDetail;
  /** Controlled by the page (useBomScope): 'standard' or a size id. */
  scope: string;
  onScopeChange: (scope: string) => void;
}

type BomDialog =
  | { kind: 'add' }
  | { kind: 'edit'; componentId: string }
  | { kind: 'layouts'; componentId: string }
  | { kind: 'remove'; componentId: string }
  | { kind: 'links'; focus: ColourLinksFocus };

function ImportButtons({ busy, onThreeMf, onGcode }: { busy: string | null; onThreeMf: (f: File) => void; onGcode: (f: File[]) => void }) {
  const cls = 'inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-md border border-gray-300 px-3 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800';
  return (
    <>
      <label className={cls}>
        <input type="file" accept=".3mf" className="hidden" disabled={busy !== null}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onThreeMf(f); }} />
        <FileCode className="h-4 w-4" aria-hidden="true" /> {busy === 'analyse' ? 'Reading…' : 'Import 3MF'}
      </label>
      <label className={cls}>
        <input type="file" accept=".gcode,.gco,.g" multiple className="hidden" disabled={busy !== null}
          onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; onGcode(f); }} />
        <Upload className="h-4 w-4" aria-hidden="true" /> {busy === 'upload' ? 'Uploading…' : 'Upload G-code'}
      </label>
    </>
  );
}

/** Section D (spec §5.2 D): the printed components of one size. */
export function ComponentsCard({ data, product, scope, onScopeChange }: Props) {
  const { toast } = useToast();
  const { canEdit } = data;
  const [dialog, setDialog] = useState<BomDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const reload = data.reloadCost;
  const sizeOptionId = scopeSizeOptionId(scope);
  const label = scopeLabel(product, scope);
  const components = componentsInScope(product, scope);
  const materials = useMemo(() => materialIndex(product), [product]);
  const totals = perProductTotals(components);
  const importer = useSlicerImport(product.id, sizeOptionId, () => void reload());
  const find = (id: string) => components.find(c => c.id === id) ?? null;
  const target = dialog && 'componentId' in dialog ? find(dialog.componentId) : null;

  async function move(id: string, dir: -1 | 1) {
    const next = reorder(components, id, dir);
    if (!next) return;
    setBusy(true);
    try {
      await api.put(`/products/${product.id}/components/order`, { sizeOptionId, componentIds: next.map(c => c.id) });
      await reload();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t reorder the components'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!target) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await api.delete(`/products/${product.id}/components/${target.id}`);
      toast('success', `Removed "${target.description}"`);
      setDialog(null);
      await reload();
    } catch (err) {
      setRemoveError(errorText(err, 'Couldn\'t remove the component'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id={BOM_SECTION_ID} className="scroll-mt-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Bill of materials — printed components</CardTitle>
              {product.sizes.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label htmlFor="bom-scope" className="text-sm text-gray-600 dark:text-gray-400">Showing:</label>
                  <select id="bom-scope" value={scope} onChange={e => onScopeChange(e.target.value)}
                    className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                    {scopeOptions(product).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <span className="text-xs text-gray-500 dark:text-gray-400">Each size has its own components and stock</span>
                </div>
              )}
            </div>
            {canEdit && components.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <ImportButtons busy={importer.busy} onThreeMf={f => void importer.startThreeMf(f)} onGcode={f => void importer.uploadGcode(f)} />
                <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'add' })}><Plus className="mr-1 h-4 w-4" /> Add manually</Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {components.length === 0 ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                No components yet. Import a sliced 3MF or G-code to create them with weights, times and files.
                {sizeOptionId && ` Until then, ${label} uses the standard bill of materials.`}
              </p>
              {canEdit && (
                <div className="flex flex-wrap justify-center gap-2">
                  <ImportButtons busy={importer.busy} onThreeMf={f => void importer.startThreeMf(f)} onGcode={f => void importer.uploadGcode(f)} />
                  <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'add' })}>Add manually</Button>
                </div>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {canEdit && <TableHead><span className="sr-only">Order</span></TableHead>}
                  <TableHead>Component</TableHead>
                  <TableHead>Filament</TableHead>
                  <TableHead>Per unit</TableHead>
                  <TableHead className="text-right">Units per product</TableHead>
                  <TableHead>Per product</TableHead>
                  <TableHead>Plate layouts</TableHead>
                  <TableHead>Printed stock</TableHead>
                  <TableHead>File</TableHead>
                  {canEdit && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {components.map((c, i) => (
                  <ComponentRow
                    key={c.id}
                    product={product}
                    component={c}
                    materials={materials}
                    canEdit={canEdit}
                    isFirst={i === 0}
                    isLast={i === components.length - 1}
                    busy={busy}
                    onMove={dir => void move(c.id, dir)}
                    onEdit={() => setDialog({ kind: 'edit', componentId: c.id })}
                    onRemove={() => { setRemoveError(null); setDialog({ kind: 'remove', componentId: c.id }); }}
                    onLayouts={() => setDialog({ kind: 'layouts', componentId: c.id })}
                    onEditLinks={focus => setDialog({ kind: 'links', focus })}
                    onReload={() => void reload()}
                  />
                ))}
                <TableRow>
                  <td colSpan={canEdit ? 5 : 4} className="px-4 py-3 text-right text-sm font-medium text-gray-700 dark:text-gray-300">Per product total</td>
                  <TableCell className="whitespace-nowrap font-medium tabular-nums">{formatGrams(totals.grams)} · {formatMinutes(totals.minutes)}</TableCell>
                  <td colSpan={canEdit ? 4 : 3} />
                </TableRow>
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <>
          <AddComponentDialog product={product} open={dialog?.kind === 'add'} sizeOptionId={sizeOptionId} scopeLabel={label}
            loadMaterials={data.loadMaterials} onClose={() => setDialog(null)} onSaved={() => void reload()} />
          <EditComponentDialog product={product} component={dialog?.kind === 'edit' ? target : null} open={dialog?.kind === 'edit'}
            loadMaterials={data.loadMaterials} onClose={() => setDialog(null)} onSaved={() => void reload()} />
          <ConfirmDialog
            open={dialog?.kind === 'remove' && target !== null}
            title="Remove component"
            message={`Remove "${target?.description ?? ''}" from ${label}? A component used by orders or jobs can't be removed.`}
            confirmLabel="Remove"
            destructive
            busy={busy}
            error={removeError}
            onConfirm={() => void remove()}
            onClose={() => setDialog(null)}
          />
          <ColourLinksDialog product={product} open={dialog?.kind === 'links'} focus={dialog?.kind === 'links' ? dialog.focus : null}
            onClose={() => setDialog(null)} onSaved={() => void reload()} />
          <ThreeMfImportWizard productId={product.id} state={importer.wizard} sizeOptionId={sizeOptionId} targetLabel={label}
            targetComponents={components} onClose={importer.closeWizard} onImported={() => void reload()} />
        </>
      )}
      <PlateLayoutsDialog product={product} component={dialog?.kind === 'layouts' ? target : null} open={dialog?.kind === 'layouts'}
        canEdit={canEdit} onClose={() => setDialog(null)} onChanged={() => void reload()} />
    </div>
  );
}
