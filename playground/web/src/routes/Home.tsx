import { Link } from "react-router";

export function Home() {
  return (
    <section className="card prose">
      <h1>BYOK chat playground</h1>
      <p>
        A tiny client-only chat UI that streams directly from your browser to
        Anthropic, OpenAI, or Google using <strong>your own</strong> API keys.
      </p>
      <p>
        Keys are kept in <code>localStorage</code> and only sent as
        <code>Authorization</code>{" "}
        headers on requests directly to the provider's own API — there is no
        server proxy here.
      </p>
      <ol>
        <li>
          Drop your key(s) into <Link to="/settings">Settings</Link>.
        </li>
        <li>
          Pick a provider + model and start chatting on{" "}
          <Link to="/chat">/chat</Link>.
        </li>
      </ol>
      <p className="dim">
        This page is the static frontend that sits alongside the 1tube edge
        functions in{" "}
        <code>playground/</code>. It does not require the gateway to be running.
      </p>
    </section>
  );
}
