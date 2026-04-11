'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

interface LocaleSettings {
  currency: string;
  locale: string;
  currencyDecimals: number;
  dateFormat: string;
}

const defaultLocale: LocaleSettings = {
  currency: 'OMR',
  locale: 'en-GB',
  currencyDecimals: 3,
  dateFormat: 'dd MMM yyyy',
};

const LocaleContext = createContext<LocaleSettings>(defaultLocale);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<LocaleSettings>(defaultLocale);

  useEffect(() => {
    fetch('/api/settings/locale')
      .then(r => r.json())
      .then(json => {
        const data = json.data || json;
        setSettings({
          currency: data.currency || defaultLocale.currency,
          locale: data.locale || defaultLocale.locale,
          currencyDecimals: data.currencyDecimals ?? defaultLocale.currencyDecimals,
          dateFormat: data.dateFormat || defaultLocale.dateFormat,
        });
      })
      .catch(() => {}); // silently fall back to defaults
  }, []);

  return (
    <LocaleContext.Provider value={settings}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}

export function useFormatCurrency() {
  const { currency, currencyDecimals } = useLocale();
  return (amount: number) => `${currency} ${amount.toFixed(currencyDecimals)}`;
}

export function useFormatDate() {
  const { locale } = useLocale();
  return (date: string | Date) =>
    new Date(date).toLocaleDateString(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
}
