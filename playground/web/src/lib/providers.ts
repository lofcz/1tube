// Latest model catalogs as of 2026-04-25. Edit freely if a provider ships
// something new — the chat UI just reads from these arrays.

export type ProviderId = "anthropic" | "openai" | "google";

export interface ModelEntry {
  id: string;
  label: string;
  hint?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  keyPlaceholder: string;
  consoleUrl: string;
  models: ModelEntry[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    keyPlaceholder: "sk-ant-…",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    models: [
      {
        id: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        hint: "flagship · 2026-04-16",
      },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        hint: "balanced · 2026-02",
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        hint: "fast/cheap · 2025-10",
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-…",
    consoleUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", hint: "flagship · 2026-04-23" },
      { id: "gpt-5.5-pro", label: "GPT-5.5 Pro", hint: "deepest reasoning" },
      { id: "gpt-5.4", label: "GPT-5.4", hint: "frontier coding" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", hint: "cheap + fast" },
      { id: "gpt-5.4-nano", label: "GPT-5.4 nano", hint: "high-volume" },
    ],
  },
  {
    id: "google",
    label: "Google",
    keyPlaceholder: "AIza…",
    consoleUrl: "https://aistudio.google.com/app/apikey",
    models: [
      {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        hint: "flagship · 2026-02",
      },
      {
        id: "gemini-3-flash-preview",
        label: "Gemini 3 Flash",
        hint: "fast frontier",
      },
      {
        id: "gemini-3.1-flash-lite-preview",
        label: "Gemini 3.1 Flash-Lite",
        hint: "cheapest",
      },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "GA fallback" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "GA fast" },
      {
        id: "gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash-Lite",
        hint: "GA cheap",
      },
    ],
  },
];

export function getProvider(id: ProviderId): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}
