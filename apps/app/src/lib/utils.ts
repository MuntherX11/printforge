import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, currency = 'OMR'): string {
  return `${currency} ${amount.toFixed(3)}`;
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function statusColor(status: string): string {
  const colors: Record<string, string> = {
    // Jobs
    QUEUED: 'bg-gray-100 text-gray-800 dark:bg-gray-800/30 dark:text-gray-400',
    IN_PROGRESS: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    PAUSED: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    COMPLETED: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    FAILED: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    CANCELLED: 'bg-gray-100 text-gray-500 dark:bg-gray-800/30 dark:text-gray-500',
    // Orders
    PENDING: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    CONFIRMED: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    IN_PRODUCTION: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400',
    READY: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    SHIPPED: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
    DELIVERED: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    // Invoices
    DRAFT: 'bg-gray-100 text-gray-800 dark:bg-gray-800/30 dark:text-gray-400',
    ISSUED: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    PAID: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    OVERDUE: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    // Quotes
    SENT: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    ACCEPTED: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    REJECTED: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    EXPIRED: 'bg-gray-100 text-gray-500 dark:bg-gray-800/30 dark:text-gray-500',
    // Printers
    IDLE: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    PRINTING: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    ERROR: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    OFFLINE: 'bg-gray-100 text-gray-500 dark:bg-gray-800/30 dark:text-gray-500',
    MAINTENANCE: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    // Low stock
    LOW_STOCK: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  };
  return colors[status] || 'bg-gray-100 text-gray-800 dark:bg-gray-800/30 dark:text-gray-400';
}
