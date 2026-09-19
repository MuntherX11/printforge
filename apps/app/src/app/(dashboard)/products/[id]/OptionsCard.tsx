'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ColourOptionDetail, ProductDetail, SizeOptionDetail } from '@/lib/types/api';
import type { ProductPageData } from './useProduct';
import { SizesTable } from './SizesTable';
import { ColoursTable } from './ColoursTable';
import { ColourSlotsPanel } from './ColourSlotsPanel';
import { ColourLinksDialog } from './ColourLinksDialog';
import { OptionDialog } from './OptionDialog';
import { ClassifyOptionsDialog } from './ClassifyOptionsDialog';
import { ColourOptionDialog } from './ColourOptionDialog';
import { OptionCostDialog, type CostTarget } from './OptionCostDialog';
import { useOptionActions } from './useOptionActions';
import { errorText } from './options-ui';
import { standardSizeLabel, type OptionKind } from './options-model';

interface Props {
  data: ProductPageData;
  product: ProductDetail;
  /** Sets the page's BOM scope to this size key and scrolls to the bill of materials. */
  onConfigureSize: (sizeKey: string) => void;
}

/**
 * Section C, `Sizes & colours` (spec §5.2 C). Sizes and colours are two
 * separate axes: a size owns sliced components and has its own automatic
 * price; a colour assigns one filament per colour slot and never changes the
 * price. Read-only roles see the tables without any write control, and this
 * card makes no request on load (it reads ProductDetail and the P16 payload).
 */
export function OptionsCard({ data, product, onConfigureSize }: Props) {
  const { toast } = useToast();
  const { canEdit, isAdmin, cost } = data;
  const reload = () => void data.reloadCost();
  const actions = useOptionActions(product, reload);

  const [optionDialog, setOptionDialog] = useState<{ kind: OptionKind; option: SizeOptionDetail | ColourOptionDetail | null } | null>(null);
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [filamentsFor, setFilamentsFor] = useState<ColourOptionDetail | null>(null);
  const [costTarget, setCostTarget] = useState<CostTarget | null>(null);
  const [savingStandard, setSavingStandard] = useState(false);

  const hasSizes = product.sizes.length > 0;
  const hasColours = product.colours.length > 0;
  const legacy = product.sizes.some(s => s.notSetUp);

  async function patchStandard(body: { baseOptionSellable?: boolean; standardColourSellable?: boolean }) {
    setSavingStandard(true);
    try {
      await api.patch<ProductDetail>(`/products/${product.id}`, body);
      await data.reloadCost();
    } catch (err) {
      toast('error', errorText(err, 'Save failed'));
    } finally {
      setSavingStandard(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>Sizes &amp; colours</CardTitle>
          {!hasSizes && !hasColours && (
            <p className="max-w-2xl text-sm text-gray-500 dark:text-gray-400">
              Sold as one product. Add sizes (each with its own sliced files) or colours (the same files printed in other filaments),
              or both — customers pick a size, then a colour.
            </p>
          )}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {legacy && <Button type="button" size="sm" variant="outline" onClick={() => setClassifyOpen(true)}>Classify options</Button>}
            <Button type="button" size="sm" variant="outline" onClick={() => setOptionDialog({ kind: 'SIZE', option: null })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />Add size
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOptionDialog({ kind: 'COLOUR', option: null })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />Add colour
            </Button>
          </div>
        )}
      </CardHeader>

      {(hasSizes || hasColours || product.colourSlots.length > 0) && (
        <CardContent className="space-y-6 px-0 pb-6">
          {legacy && (
            <p className="mx-6 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
              These options were created before sizes and colours were separate. If some are colours, classify them — then add colour
              slots and choose each colour&apos;s filaments.
            </p>
          )}
          {hasSizes && (
            <section aria-label="Sizes">
              <h4 className="px-6 pb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">Sizes</h4>
              <SizesTable
                product={product}
                cost={cost}
                canEdit={canEdit}
                isAdmin={isAdmin}
                busyId={actions.busyId}
                savingStandard={savingStandard}
                onConfigure={onConfigureSize}
                onCost={s => setCostTarget({ kind: 'SIZE', sizeOptionId: s?.id ?? null, label: s?.name ?? standardSizeLabel(product) })}
                onEdit={s => setOptionDialog({ kind: 'SIZE', option: s })}
                onMove={(s, dir) => void actions.move('SIZE', s, dir)}
                onSetActive={(s, on) => actions.setActive('SIZE', s, on)}
                onDelete={s => void actions.remove('SIZE', s)}
                onEditLinks={() => setLinksOpen(true)}
                onStandardSellable={sell => void patchStandard({ baseOptionSellable: sell })}
              />
            </section>
          )}
          {hasColours && (
            <section aria-label="Colours">
              <h4 className="px-6 pb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">Colours</h4>
              <ColoursTable
                product={product}
                cost={cost}
                canEdit={canEdit}
                isAdmin={isAdmin}
                busyId={actions.busyId}
                savingStandard={savingStandard}
                onFilaments={c => setFilamentsFor(c)}
                onCost={c => setCostTarget({ kind: 'COLOUR', colourOptionId: c.id, label: c.name })}
                onEdit={c => setOptionDialog({ kind: 'COLOUR', option: c })}
                onMove={(c, dir) => void actions.move('COLOUR', c, dir)}
                onSetActive={(c, on) => actions.setActive('COLOUR', c, on)}
                onDelete={c => void actions.remove('COLOUR', c)}
                onStandardSellable={sell => void patchStandard({ standardColourSellable: sell })}
              />
            </section>
          )}
          {(hasColours || product.colourSlots.length > 0) && (
            <ColourSlotsPanel product={product} canEdit={canEdit} onEditLinks={() => setLinksOpen(true)} onChanged={reload} />
          )}
        </CardContent>
      )}

      {canEdit && (
        <>
          <OptionDialog
            product={product}
            open={!!optionDialog}
            kind={optionDialog?.kind ?? 'SIZE'}
            option={optionDialog?.option ?? null}
            onClose={() => setOptionDialog(null)}
            onSaved={reload}
          />
          <ClassifyOptionsDialog product={product} open={classifyOpen} onClose={() => setClassifyOpen(false)} onSaved={reload} />
          <ColourLinksDialog product={product} open={linksOpen} onClose={() => setLinksOpen(false)} onSaved={reload} />
          <ColourOptionDialog
            product={product}
            colour={filamentsFor ? product.colours.find(c => c.id === filamentsFor.id) ?? filamentsFor : null}
            cost={cost}
            open={!!filamentsFor}
            loadMaterials={data.loadMaterials}
            onClose={() => setFilamentsFor(null)}
            onSaved={reload}
          />
          <OptionCostDialog productId={product.id} target={costTarget} cost={cost} onClose={() => setCostTarget(null)} />
          {actions.confirmNode}
        </>
      )}
    </Card>
  );
}
