import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Send, Square, Trash2 } from "lucide-react";
import { getProvider, type ProviderId, PROVIDERS } from "../lib/providers";
import { getApiKey, useSelected } from "../lib/storage";
import { type ChatMessage, streamChat } from "../lib/stream";

interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function Chat() {
  const [selected, setSelected] = useSelected();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const providerInfo = getProvider(selected.provider);
  const apiKey = useMemo(() => getApiKey(selected.provider), [
    selected.provider,
    streaming,
  ]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onProviderChange = (provider: ProviderId) => {
    const next = getProvider(provider);
    setSelected({ provider, model: next.models[0]!.id });
  };

  const send = async () => {
    if (!input.trim() || streaming) return;
    if (!apiKey) {
      setError(`No API key for ${providerInfo.label}. Add one in Settings.`);
      return;
    }
    setError(null);

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: "user",
      text: input,
    };
    const assistantTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
    };
    const nextTurns = [...turns, userTurn, assistantTurn];
    setTurns(nextTurns);
    setInput("");
    setStreaming(true);

    const messages: ChatMessage[] = nextTurns
      .filter((t) => t !== assistantTurn)
      .map((t) => ({ role: t.role, content: t.text }));

    try {
      const { textStream, cancel } = streamChat({
        provider: selected.provider,
        model: selected.model,
        apiKey,
        messages,
      });
      cancelRef.current = cancel;

      for await (const chunk of textStream) {
        setTurns((prev) =>
          prev.map((
            t,
          ) => (t.id === assistantTurn.id ? { ...t, text: t.text + chunk } : t))
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === assistantTurn.id
            ? { ...t, text: t.text || `[error] ${msg}` }
            : t
        )
      );
    } finally {
      cancelRef.current = null;
      setStreaming(false);
    }
  };

  const stop = () => cancelRef.current?.();
  const clear = () => {
    if (streaming) stop();
    setTurns([]);
    setError(null);
  };

  return (
    <section className="card chat">
      <div className="chat-controls">
        <label>
          <span className="dim">Provider</span>
          <select
            value={selected.provider}
            onChange={(e) => onProviderChange(e.target.value as ProviderId)}
            disabled={streaming}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="dim">Model</span>
          <select
            value={selected.model}
            onChange={(e) =>
              setSelected({ ...selected, model: e.target.value })}
            disabled={streaming}
          >
            {providerInfo.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.hint ? ` — ${m.hint}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost"
          onClick={clear}
          title="Clear conversation"
        >
          <Trash2 size={16} /> clear
        </button>
      </div>

      {!apiKey && (
        <div className="banner warn">
          No API key for <strong>{providerInfo.label}</strong>.{" "}
          <Link to="/settings">Add one in Settings →</Link>
        </div>
      )}
      {error && <div className="banner err">{error}</div>}

      <div className="messages" ref={scrollerRef}>
        {turns.length === 0
          ? (
            <div className="placeholder dim">
              Ask anything. Streams token-by-token straight from{" "}
              {providerInfo.label}'s API.
            </div>
          )
          : (
            turns.map((t) => (
              <div key={t.id} className={`turn turn-${t.role}`}>
                <div className="turn-role dim">{t.role}</div>
                <div className="turn-text">
                  {t.text || (streaming ? "…" : "")}
                </div>
              </div>
            ))
          )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={apiKey
            ? "Type a message…  (Enter to send, Shift+Enter for newline)"
            : "Add an API key in Settings to start"}
          rows={3}
          disabled={!apiKey && !streaming}
        />
        {streaming
          ? (
            <button type="button" className="primary stop" onClick={stop}>
              <Square size={16} /> stop
            </button>
          )
          : (
            <button
              type="submit"
              className="primary"
              disabled={!input.trim() || !apiKey}
            >
              <Send size={16} /> send
            </button>
          )}
      </form>
    </section>
  );
}
