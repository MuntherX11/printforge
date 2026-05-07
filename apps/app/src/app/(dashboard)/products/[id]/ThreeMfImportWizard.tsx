'use client';

import { useState, useEffect } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ThreeMfAnalysis } from '@printforge/types';
import PlatePreviewCard from './PlatePreviewCard';

interface ThreeMfImportWizardProps {
  open: boolean;
  onClose: () => void;
  analysis: ThreeMfAnalysis | null;
  file: File | null;
  productId: string;
  onSuccess: () => void;
}

export function ThreeMfImportWizard({
  open,
  onClose,
  analysis,
  file,
  productId,
  onSuccess,
}: ThreeMfImportWizardProps) {
  const [selectedPlates, setSelectedPlates] = useState<number[]>([]);
  const [plateNames, setPlateNames] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const { toast } = useToast();

  // Select all plates by default when a new analysis arrives; clear state on close
  useEffect(() => {
    if (open && analysis) {
      setSelectedPlates(analysis.plates.map((p) => p.plateIndex));
      const initialNames: Record<string, string> = {};
      analysis.plates.forEach((p) => {
        initialNames[String(p.plateIndex)] = p.name;
      });
      setPlateNames(initialNames);
    } else if (!open) {
      setSelectedPlates([]);
      setPlateNames({});
    }
  }, [open, analysis]);

  function handleToggle(plateIndex: number) {
    setSelectedPlates((prev) =>
      prev.includes(plateIndex) ? prev.filter((i) => i !== plateIndex) : [...prev, plateIndex],
    );
  }

  function handleNameChange(plateIndex: number, name: string) {
    setPlateNames((prev) => ({ ...prev, [String(plateIndex)]: name }));
  }

  async function handleImport() {
    if (!file || selectedPlates.length === 0) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('selectedPlates', JSON.stringify(selectedPlates));
      formData.append('plateNames', JSON.stringify(plateNames));

      const res = await fetch(`/api/products/${productId}/onboard-3mf`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Import failed (${res.status})`);
      }

      toast('success', `Imported ${selectedPlates.length} plate${selectedPlates.length !== 1 ? 's' : ''} successfully`);
      onSuccess();
    } catch (err: any) {
      toast('error', err.message || 'Failed to import 3MF');
    } finally {
      setImporting(false);
    }
  }

  if (!analysis) return null;

  return (
    <Dialog open={open} onClose={onClose} title="Import 3MF Project">
      <div className="py-2">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Found <strong>{analysis.totalPlates}</strong> plate{analysis.totalPlates !== 1 ? 's' : ''} &middot; Slicer: <strong>{analysis.slicer || 'Unknown'}</strong>
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[55vh] overflow-y-auto pr-1">
          {analysis.plates.map((plate) => (
            <PlatePreviewCard
              key={plate.plateIndex}
              plate={plate}
              selected={selectedPlates.includes(plate.plateIndex)}
              name={plateNames[String(plate.plateIndex)] || plate.name}
              onToggle={handleToggle}
              onNameChange={handleNameChange}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between border-t pt-4 mt-2">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {selectedPlates.length} of {analysis.totalPlates} selected
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={importing || selectedPlates.length === 0}>
            {importing ? 'Importing...' : `Import ${selectedPlates.length} plate${selectedPlates.length !== 1 ? 's' : ''}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
