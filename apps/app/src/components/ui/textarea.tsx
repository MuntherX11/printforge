import { cn } from '@/lib/utils';
import { forwardRef } from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, ...props }, ref) => {
    return (
      <div className="space-y-1">
        {label && <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>}
        <textarea
          ref={ref}
          className={cn(
            'flex min-h-[80px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100',
            'placeholder:text-gray-400 dark:placeholder:text-gray-500',
            'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error && 'border-red-500',
            className,
          )}
          {...props}
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  },
);
Textarea.displayName = 'Textarea';
