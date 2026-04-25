import { ApiKeyInput } from "../components/ApiKeyInput";
import { PROVIDERS } from "../lib/providers";
import { useApiKey } from "../lib/storage";

export function Settings() {
  return (
    <section className="card">
      <h1>API keys</h1>
      <p className="dim">
        Stored in your browser's <code>localStorage</code>. They never leave
        this tab except as auth headers on requests to each provider's API.
      </p>
      <div className="provider-list">
        {PROVIDERS.map((p) => (
          <ProviderRow key={p.id} provider={p} />
        ))}
      </div>
    </section>
  );
}

function ProviderRow({ provider }: { provider: (typeof PROVIDERS)[number] }) {
  const [value, setValue] = useApiKey(provider.id);
  return (
    <div className="provider-row">
      <div className="provider-row-head">
        <label htmlFor={`key-${provider.id}`}>{provider.label}</label>
        <a href={provider.consoleUrl} target="_blank" rel="noreferrer" className="dim">
          get a key →
        </a>
      </div>
      <ApiKeyInput
        id={`key-${provider.id}`}
        value={value}
        onChange={setValue}
        placeholder={provider.keyPlaceholder}
      />
    </div>
  );
}
