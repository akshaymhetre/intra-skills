import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import { AuthProvider, RequireAuth } from "./auth";
import { Shell, type RouteHandle } from "./components/Shell";
import { ToastProvider } from "./components/Toast";
import { SignIn } from "./pages/SignIn";
import { Home } from "./pages/Home";
import { Catalog } from "./pages/Catalog";
import { SkillPage } from "./pages/skill/SkillPage";
import { TeamPage, Teams } from "./pages/Teams";
import { Activity } from "./pages/Activity";
import { Settings } from "./pages/Settings";
import { Members } from "./pages/Members";
import { NotFound } from "./pages/NotFound";
import { StackPage, StacksIndex } from "./pages/Stacks";
import { stackLabel } from "@intra-skills/shared/stacks";
import { CollectionPage } from "./pages/Collection";
import { Proposals } from "./pages/Proposals";
import { GetStarted } from "./pages/GetStarted";
import { Setup } from "./pages/Setup";
import { Device } from "./pages/Device";
import { Review } from "./pages/admin/Review";
import { Repositories } from "./pages/admin/Repositories";
import { RegistrySettings } from "./pages/admin/Registry";

const h = (crumbs: RouteHandle["crumbs"]): RouteHandle => ({ crumbs });

const router = createBrowserRouter([
  {
    element: (
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    ),
    children: [
      { path: "/signin", element: <SignIn /> },
      { path: "/setup", element: <Setup /> },
      {
        path: "/device",
        element: (
          <RequireAuth>
            <Device />
          </RequireAuth>
        ),
      },
      {
        element: (
          <RequireAuth>
            <Shell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Home />, handle: h(() => [{ label: "Home" }]) },
          { path: "skills", element: <Catalog />, handle: h(() => [{ label: "Skills" }]) },
          {
            path: "skills/:name",
            element: <SkillPage />,
            handle: h((p) => [{ label: "Skills", to: "/skills" }, { label: <span className="font-mono">{p.name}</span> }]),
          },
          { path: "teams", element: <Teams />, handle: h(() => [{ label: "Teams" }]) },
          { path: "teams/:slug", element: <TeamPage />, handle: h((p) => [{ label: "Teams", to: "/teams" }, { label: p.slug }]) },
          { path: "stacks", element: <StacksIndex />, handle: h(() => [{ label: "Stacks" }]) },
          { path: "stacks/:stack", element: <StackPage />, handle: h((p) => [{ label: "Stacks", to: "/stacks" }, { label: stackLabel(p.stack ?? "") }]) },
          {
            path: "collections/:team/:slug",
            element: <CollectionPage />,
            handle: h((p) => [{ label: "Teams", to: "/teams" }, { label: p.team, to: `/teams/${p.team}` }, { label: p.slug }]),
          },
          { path: "proposals", element: <Proposals />, handle: h(() => [{ label: "Proposals" }]) },
          { path: "get-started", element: <GetStarted />, handle: h(() => [{ label: "Get started" }]) },
          { path: "activity", element: <Activity />, handle: h(() => [{ label: "Activity" }]) },
          { path: "admin/review", element: <Review />, handle: h(() => [{ label: "Review" }]) },
          { path: "admin/repositories", element: <Repositories />, handle: h(() => [{ label: "Repositories" }]) },
          { path: "admin/registry", element: <RegistrySettings />, handle: h(() => [{ label: "Registry" }]) },
          { path: "settings", element: <Settings />, handle: h(() => [{ label: "Settings" }]) },
          { path: "admin/members", element: <Members />, handle: h(() => [{ label: "Members" }]) },
          { path: "*", element: <NotFound />, handle: h(() => [{ label: "Not found" }]) },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
