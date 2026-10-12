'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode, Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useFilamentStock } from '@/components/filaments/useFilamentStock';
import { api } from '@/lib/api';
import { formatGrams, formatMinutes } from '@/lib/product-format';
import type { ProductDetail } from '@/lib/types/api';
import type { ProductPageData } from './useProduct';
import { BOM_SECTION_ID } from './useBomScope';
import { PartRow } from './PartRow';
import { SectionHead } from './section-ui';
import { AddFromModelDialog } from './AddFromModelDialog';
import { EditComponentDialog } from './EditComponentDialog';
import { PlateLayoutsDialog } from './PlateLayoutsDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { ColourLinksDialog, type ColourLinksFocus } from './ColourLinksDialog';
import { ThreeMfImportWizard } from './ThreeMfImportWizard';
import { GcodeImportDialog } from './GcodeImportDialog';
import { SlotFilamentDialog } from './SlotFilamentDialog';
import { SlicePlateDialog } from './SlicePlateDialog';
import { useSlicerImport } from './useSlicerImport';
import type { PartSlices } from './usePartSlices';
import { sourceOf } from './slice-ui';
import { errorText } from './options-ui';
import { reorder } from './options-model';
import { componentsInScope, materialIndex, perProductTotals, scopeLabel, scopeOptions, scopeSizeOptionId } from './bom-model';

interface Props {
  data: ProductPageData;
  product: ProductDetail;
  /** Controlled by the page (useBomScope): 'standard' or a size id. */
  scope: string;
  onScopeChange: (scope: string) => void;
  /**
   * 'full' offers Import 3MF, Upload G-code and Add from model; 'overview'
   * (the tabs layout's first tab) only the Add from model link.
   */
  variant: 'full' | 'overview';
  /** Heading drawn by the tabs layout, with the add buttons beside it. Without one the buttons go under the list. */
  title?: string;
  /** Printer id → name (the page loads it once a part needs it); null until loaded. */
  printers: ReadonlyMap<string, string> | null;
  /** "Show costs per plate", page state shared by every part. */
  showCosts: boolean;
  onShowCosts: (show: boolean) => void;
  /** Slicing state per part (the page's `slice-run` subscription), for the chip on a closed row. */
  slices: PartSlices;
}

type BomDialog =
  | { kind: 'fromModel'; file: File }
  | { kind: 'edit'; componentId: string }
  | { kind: 'layouts'; componentId: string }
  | { kind: 'remove'; componentId: string }
  | { kind: 'links'; focus: ColourLinksFocus }
  | { kind: 'filament'; componentId: string; colorIndex: number }
  | { kind: 'slice'; componentId: string };

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

/** "Add from model" (ADMIN): pick an STL or a 3MF project; the dialog opens once a file is chosen. */
function AddFromModelButton({ variant, disabled, onFile }: { variant: 'outline' | 'ghost'; disabled: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept=".stl,.3mf" className="hidden" tabIndex={-1} aria-hidden="true" disabled={disabled}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      <Button variant={variant} size="sm" disabled={disabled} title="Pick an STL or 3MF; PrintForge slices one unit"
        className={variant === 'ghost' ? 'text-brand-600 dark:text-brand-400' : undefined} onClick={() => input.current?.click()}>
        {variant === 'outline' && <Plus className="mr-1 h-4 w-4" aria-hidden="true" />} Add from model
      </Button>
    </>
  );
}

/**
 * Parts and plates (was the bill of materials, spec §5.2 D): the printed
 * parts of one size, one row each, opened in place. Every row starts closed
 * and nothing about which are open is remembered.
 */
export function PartsBody({ data, product, scope, onScopeChange, variant, title, printers, showCosts, onShowCosts, slices }: Props) {
  const { toast } = useToast();
  const { canEdit, isAdmin } = data;
  const [dialog, setDialog] = useState<BomDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const reload = data.reloadCost;
  const sizeOptionId = scopeSizeOptionId(scope);
  const label = scopeLabel(product, scope);
  const components = componentsInScope(product, scope);
  const materials = useMemo(() => materialIndex(product), [product]);
  const totals = perProductTotals(components);
  const importer = useSlicerImport(product.id, sizeOptionId, () => void reload());
  // Editors only (VIEWER never fetches it); refetched after every product reload.
  const stock = useFilamentStock(canEdit && (components.length > 0 || dialog?.kind === 'fromModel'), product);
  const stockById = useMemo(() => new Map((stock.rows ?? []).map(r => [r.id, r] as const)), [stock.rows]);
  const find = (id: string) => components.find(c => c.id === id) ?? null;
  const target = dialog && 'componentId' in dialog ? find(dialog.componentId) : null;
  // Bumped when a slice run is queued, so the part's runs list refetches.
  const [runsVersion, setRunsVersion] = useState(0);
  const { loadPrinters } = data;

  // The latest run of every part shown that has a source model: one request per part, asked once.
  const { watch } = slices;
  const sourcedKey = components.filter(c => sourceOf(c) !== null).map(c => c.id).join(',');
  useEffect(() => { if (sourcedKey) watch(sourcedKey.split(',')); }, [sourcedKey, watch]);

  const toggle = (id: string) => setOpenIds(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  async function move(id: string, dir: -1 | 1) {
    const next = reorder(components, id, dir);
    if (!next) return;
    setBusy(true);
    try {
      await api.put(`/products/${product.id}/components/order`, { sizeOptionId, componentIds: next.map(c => c.id) });
      await reload();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t reorder the parts'));
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
      setRemoveError(errorText(err, 'Couldn\'t remove the part'));
    } finally {
      setBusy(false);
    }
  }

  const fromModel = (v: 'outline' | 'ghost') => isAdmin
    ? <AddFromModelButton variant={v} disabled={dialog !== null} onFile={file => setDialog({ kind: 'fromModel', file })} />
    : null;
  const imports = <ImportButtons busy={importer.busy} onThreeMf={f => void importer.startThreeMf(f)} onGcode={f => void importer.uploadGcode(f)} />;
  // With parts: the tabs layout's Overview only links to Add from model; everywhere else all three.
  const addButtons = !canEdit || components.length === 0 ? null : variant === 'overview'
    ? fromModel('ghost')
    : <>{fromModel('outline')}{imports}</>;

  return (
    <div id={BOM_SECTION_ID} className="scroll-mt-4 space-y-3">
      <SectionHead title={title}>{title ? addButtons : null}</SectionHead>
      {product.sizes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="bom-scope" className="text-sm text-gray-600 dark:text-gray-400">Showing</label>
          <select id="bom-scope" value={scope} onChange={e => onScopeChange(e.target.value)}
            className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            {scopeOptions(product).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className="text-xs text-gray-500 dark:text-gray-400">Each size has its own parts and stock</span>
        </div>
      )}

      {components.length === 0 ? (
        <div className="space-y-3 rounded-md border border-dashed border-gray-300 px-4 py-6 text-center dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            No parts yet. Import a sliced 3MF or G-code, or add a part from its model (STL or 3MF project).
            {sizeOptionId && ` Until then, ${label} uses the standard parts.`}
          </p>
          {canEdit && <div className="flex flex-wrap justify-center gap-2">{imports}{fromModel('ghost')}</div>}
        </div>
      ) : (
        <>
          <ul className="rounded-md border border-gray-200 dark:border-gray-700" aria-label={`Parts of ${label}`}>
            {components.map((c, i) => (
              <PartRow
                key={c.id}
                product={product}
                component={c}
                materials={materials}
                canEdit={canEdit}
                isAdmin={isAdmin}
                isFirst={i === 0}
                isLast={i === components.length - 1}
                busy={busy}
                open={openIds.has(c.id)}
                onToggle={() => toggle(c.id)}
                printers={printers}
                runsKey={runsVersion}
                sliceState={slices.stateOf(c.id)}
                showCosts={showCosts}
                onShowCosts={onShowCosts}
                onMove={dir => void move(c.id, dir)}
                onEdit={() => setDialog({ kind: 'edit', componentId: c.id })}
                onRemove={() => { setRemoveError(null); setDialog({ kind: 'remove', componentId: c.id }); }}
                onLayouts={() => setDialog({ kind: 'layouts', componentId: c.id })}
                onEditLinks={focus => setDialog({ kind: 'links', focus })}
                onReload={() => void reload()}
                onRunRemoved={() => slices.refresh(c.id)}
                stock={canEdit ? stockById : null}
                onPickFilament={colorIndex => { stock.refresh(); setDialog({ kind: 'filament', componentId: c.id, colorIndex }); }}
                onSlice={() => { stock.refresh(); setDialog({ kind: 'slice', componentId: c.id }); }}
              />
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {!title && addButtons ? <div className="flex flex-wrap gap-2">{addButtons}</div> : <span />}
            {(components.length > 1 || components.some(c => c.quantity !== 1)) && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Per product <span className="font-mono tabular-nums text-gray-900 dark:text-gray-100">{formatGrams(totals.grams)} · {formatMinutes(totals.minutes)}</span>
              </p>
            )}
          </div>
        </>
      )}

      {canEdit && (
        <>
          {isAdmin && (
            <AddFromModelDialog productId={product.id} file={dialog?.kind === 'fromModel' ? dialog.file : null}
              sizeOptionId={sizeOptionId} scopeLabel={label} materials={materials} stock={stock} loadPrinters={loadPrinters}
              onClose={() => setDialog(null)}
              onAdded={out => {
                // Open the new part: its first slice and its runs are what the owner looks for next.
                setOpenIds(prev => new Set(prev).add(out.componentId));
                slices.refresh(out.componentId);
                setRunsVersion(v => v + 1);
                void reload();
              }} />
          )}
          <EditComponentDialog product={product} component={dialog?.kind === 'edit' ? target : null} open={dialog?.kind === 'edit'}
            loadMaterials={data.loadMaterials} onClose={() => setDialog(null)} onSaved={() => void reload()} />
          <ConfirmDialog
            open={dialog?.kind === 'remove' && target !== null}
            title="Remove part"
            message={`Remove "${target?.description ?? ''}" from ${label}? A part used by orders or jobs can't be removed.`}
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
          <GcodeImportDialog productId={product.id} state={importer.gcodeConfirm} sizeOptionId={sizeOptionId} targetLabel={label}
            onClose={importer.closeGcodeConfirm} onImported={() => void reload()} />
          <SlotFilamentDialog product={product} component={dialog?.kind === 'filament' ? target : null}
            colorIndex={dialog?.kind === 'filament' ? dialog.colorIndex : 0} open={dialog?.kind === 'filament'}
            scopeLabel={label} stock={stock} onClose={() => setDialog(null)} onSaved={() => void reload()} />
          <SlicePlateDialog product={product} component={dialog?.kind === 'slice' ? target : null} open={dialog?.kind === 'slice'}
            materials={materials} stock={stock} loadPrinters={loadPrinters}
            onClose={() => setDialog(null)} onQueued={run => { slices.refresh(run.componentId); setRunsVersion(v => v + 1); }} />
        </>
      )}
      <PlateLayoutsDialog product={product} component={dialog?.kind === 'layouts' ? target : null} open={dialog?.kind === 'layouts'}
        canEdit={canEdit} onClose={() => setDialog(null)} onChanged={() => void reload()} />
    </div>
  );
}
