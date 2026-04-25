import { useCallback, useEffect, useState } from "react";
import type { ProviderId } from "./providers";

// Keys are stored locally only. They never leave the browser except as
// Authorization headers on requests directly to the provider's own API.
const KEY_PREFIX = "1tube.playground.apiKey.";
const MODEL_KEY = "1tube.playground.selected";

export function getApiKey(provider: ProviderId): string {
  try {
    return localStorage.getItem(KEY_PREFIX + provider) ?? "";
  } catch {
    return "";
  }
}

export function setApiKey(provider: ProviderId, value: string): void {
  try {
    if (value) localStorage.setItem(KEY_PREFIX + provider, value);
    else localStorage.removeItem(KEY_PREFIX + provider);
  } catch {
    // ignore — private mode etc.
  }
}

export interface SelectedModel {
  provider: ProviderId;
  model: string;
}

const DEFAULT_SELECTED: SelectedModel = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

export function getSelected(): SelectedModel {
  try {
    const raw = localStorage.getItem(MODEL_KEY);
    if (!raw) return DEFAULT_SELECTED;
    const parsed = JSON.parse(raw) as Partial<SelectedModel>;
    if (!parsed.provider || !parsed.model) return DEFAULT_SELECTED;
    return { provider: parsed.provider as ProviderId, model: parsed.model };
  } catch {
    return DEFAULT_SELECTED;
  }
}

export function setSelected(value: SelectedModel): void {
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// Lightweight reactive hook so components can react to changes from another tab
// or another component without a full state manager.
export function useApiKey(provider: ProviderId): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => getApiKey(provider));

  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === KEY_PREFIX + provider) setValue(ev.newValue ?? "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [provider]);

  const update = useCallback(
    (v: string) => {
      setApiKey(provider, v);
      setValue(v);
    },
    [provider],
  );

  return [value, update];
}

export function useSelected(): [SelectedModel, (v: SelectedModel) => void] {
  const [value, setValue] = useState<SelectedModel>(() => getSelected());
  const update = useCallback((v: SelectedModel) => {
    setSelected(v);
    setValue(v);
  }, []);
  return [value, update];
}
