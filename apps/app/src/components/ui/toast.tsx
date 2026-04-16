'use client';

import { useState, useCallback, createContext, useContext } from 'react';
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = ++nextId;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-slide-up ${
              t.type === 'success'
                ? 'bg-green-50 text-green-800 border border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800'
                : t.type === 'error'
                ? 'bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800'
                : 'bg-yellow-50 text-yellow-800 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800'
            }`}
          >
            {t.type === 'success' && <CheckCircle className="h-4 w-4 flex-shrink-0" />}
            {t.type === 'error' && <XCircle className="h-4 w-4 flex-shrink-0" />}
            {t.type === 'warning' && <AlertTriangle className="h-4 w-4 flex-shrink-0" />}
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              aria-label="Dismiss"
              className="flex-shrink-0 hover:opacity-70"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
