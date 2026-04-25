import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./routes/Layout";
import { Home } from "./routes/Home";
import { Chat } from "./routes/Chat";
import { Settings } from "./routes/Settings";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Home },
      { path: "chat", Component: Chat },
      { path: "settings", Component: Settings },
      { path: "*", element: <p style={{ padding: 24 }}>Not found.</p> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
