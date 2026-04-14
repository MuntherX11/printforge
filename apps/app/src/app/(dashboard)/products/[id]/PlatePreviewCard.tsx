'use client';

import { Printer } from 'lucide-react';
import { ThreeMfPlateInfo } from '@printforge/types';

interface PlatePreviewCardProps {
  plate: ThreeMfPlateInfo;
  selected: boolean;
  name: string;
  onToggle: (plateIndex: number) => void;
  onNameChange: (plateIndex: number, name: string) => void;
}

function formatTime(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function PlatePreviewCard({
  plate,
  selected,
  name,
  onToggle,
  onNameChange,
}: PlatePreviewCardProps) {
  return (
    <div
      className={`border rounded-lg p-3 transition-all duration-150 ${
        selected
          ? 'border-brand-500 ring-1 ring-brand-500 opacity-100 dark:border-brand-400'
          : 'border-gray-200 dark:border-gray-700 opacity-50 hover:opacity-70'
      }`}
    >
      {/* Header: checkbox + editable name */}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(plate.plateIndex)}
          className="h-4 w-4 rounded border-gray-300 text-brand-600 cursor-pointer"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(plate.plateIndex, e.target.value)}
          className="flex-1 min-w-0 border-b border-transparent hover:border-gray-300 dark:hover:border-gray-500 focus:border-brand-500 dark:focus:border-brand-400 bg-transparent text-sm font-medium px-0.5 py-0.5 outline-none transition-colors dark:text-gray-100"
        />
      </div>

      {/* Thumbnail */}
      <div
        className="aspect-video w-full bg-gray-100 dark:bg-gray-800 rounded flex items-center justify-center mb-2 overflow-hidden cursor-pointer"
        onClick={() => onToggle(plate.plateIndex)}
      >
        {plate.thumbnailBase64 ? (
          <img
            src={plate.thumbnailBase64}
            alt={name}
            className="w-full h-full object-contain"
          />
        ) : (
          <Printer className="h-8 w-8 text-gray-400 dark:text-gray-500" />
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">{formatTime(plate.printSeconds)}</span>
          <span>&middot;</span>
          <span>{Math.round(plate.weightGrams)}g</span>
        </div>
        {plate.toolChanges > 0 && (
          <span className="bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded text-xs font-medium">
            {plate.toolChanges} changes
          </span>
        )}
      </div>

      {/* Filament colour palette */}
      {plate.tools.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {plate.tools.map((tool) => (
            <div
              key={tool.index}
              className="h-4 w-4 rounded-full border border-gray-200 dark:border-gray-600 shadow-sm shrink-0"
              style={{ backgroundColor: tool.colorHex || '#888888' }}
              title={`T${tool.index}: ${tool.materialType || 'Unknown'} — ${Math.round(tool.filamentGrams)}g`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
