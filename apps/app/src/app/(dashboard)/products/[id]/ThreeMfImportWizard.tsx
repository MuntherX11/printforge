'use client';

import { useState, useEffect } from 'react';
import { Dialog } from '@/components/ui/dialog';
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

  // When analysis arrives, select all plates by default
  useEffect(() => {
    if (open && analysis) {
      setSelectedPlates(analysis.plates.map((p) => p.plateIndex));
      const initialNames: Record<string, string> = {};
      analysis.plates.forEach((p) => {
        initialNames[String(p.plateIndex)] = p.name;
      });
      setPlateNames(initialNames);
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
          <button
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
            onClick={onClose}
            disabled={importing}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 disabled:opacity-50 transition-colors"
            onClick={handleImport}
            disabled={importing || selectedPlates.length === 0}
          >
            {importing ? 'Importing...' : `Import ${selectedPlates.length} plate${selectedPlates.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
