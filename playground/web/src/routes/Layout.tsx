import { NavLink, Outlet } from "react-router";

export function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">1tube</span>
          <span className="dim">playground</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/chat">Chat</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
