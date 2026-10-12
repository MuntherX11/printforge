'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductPageLayout, UserPreferences } from '@printforge/types';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { DEFAULT_LAYOUT, readStoredLayout, writeStoredLayout } from './product-layout';

/**
 * The signed-in user's product page layout. The account (GET /auth/me) is the
 * source of truth; the browser's copy (`pf.productLayout`) only paints the
 * last choice before /auth/me has answered.
 *
 * A change applies at once and is saved with PATCH /auth/me/preferences. The
 * saves go out one after another, in the order chosen, so the account always
 * ends on the last choice. When the last save fails the layout goes back to
 * the value the server last confirmed (not to whatever was showing before the
 * click, which may itself never have been saved). A choice made before
 * /auth/me has answered is kept and saved once the user is loaded.
 */
export function useProductLayout(): { layout: ProductPageLayout; setLayout: (next: ProductPageLayout) => void } {
  const { user, setPreferences } = useAuth();
  const { toast } = useToast();
  const [stored, setStored] = useState<ProductPageLayout>(readStoredLayout);
  /** Number of the newest choice; an older save's outcome never changes what is shown. */
  const seq = useRef(0);
  /** The saves, chained: each starts when the one before it has settled. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** The layout the server last answered with (GET /auth/me, then every successful PATCH). */
  const confirmed = useRef<ProductPageLayout | null>(null);
  /** A choice made before the user was loaded, waiting to be saved. */
  const early = useRef<ProductPageLayout | null>(null);

  const loaded = user !== null;
  const account = user?.preferences?.productPageLayout ?? DEFAULT_LAYOUT;
  const layout = loaded ? account : stored;

  const show = useCallback((value: ProductPageLayout) => {
    setStored(value);
    writeStoredLayout(value);
    setPreferences({ productPageLayout: value });
  }, [setPreferences]);

  const save = useCallback((next: ProductPageLayout) => {
    const n = ++seq.current;
    show(next);
    queue.current = queue.current.then(async () => {
      try {
        const saved = await api.patch<UserPreferences>('/auth/me/preferences', { productPageLayout: next });
        confirmed.current = saved.productPageLayout ?? DEFAULT_LAYOUT;
        // A newer choice is showing and its own save is next in line: leave it alone.
        if (n === seq.current) setPreferences(saved);
      } catch {
        if (n !== seq.current) return;
        show(confirmed.current ?? DEFAULT_LAYOUT);
        toast('error', 'Couldn\'t save the layout choice');
      }
    });
  }, [show, setPreferences, toast]);

  // The account has answered (or changed on another device): it is the confirmed value.
  // A choice made while it was loading wins over it, and is saved now, once.
  useEffect(() => {
    if (!loaded) return;
    if (confirmed.current === null) confirmed.current = account;
    const waiting = early.current;
    early.current = null;
    if (waiting !== null && waiting !== account) {
      save(waiting);
      return;
    }
    writeStoredLayout(account);
    setStored(account);
  }, [loaded, account, save]);

  const setLayout = useCallback((next: ProductPageLayout) => {
    if (!loaded) {
      // Shown at once from the browser's copy; saved when /auth/me has answered.
      early.current = next;
      setStored(next);
      writeStoredLayout(next);
      return;
    }
    if (next === layout) return;
    save(next);
  }, [loaded, layout, save]);

  return { layout, setLayout };
}
