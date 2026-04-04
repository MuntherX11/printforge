import { cn } from '@/lib/utils';
import { forwardRef } from 'react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: Array<{ value: string; label: string }>;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, options, ...props }, ref) => {
    return (
      <div className="space-y-1">
        {label && <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>}
        <select
          ref={ref}
          className={cn(
            'flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100',
            'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent',
            error && 'border-red-500',
            className,
          )}
          {...props}
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Select.displayName = 'Select';
