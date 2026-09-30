import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useMe } from "./api/auth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";

const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Dashboard = page(() => import("./pages/Dashboard"), "Dashboard");
const Jobs = page(() => import("./pages/Jobs"), "Jobs");
const JobPage = page(() => import("./pages/JobPage"), "JobPage");
const Bikes = page(() => import("./pages/Bikes"), "Bikes");
const BikePage = page(() => import("./pages/BikePage"), "BikePage");
const Clients = page(() => import("./pages/Clients"), "Clients");
const Parts = page(() => import("./pages/Parts"), "Parts");
const Invoices = page(() => import("./pages/Invoices"), "Invoices");
const InvoicePage = page(() => import("./pages/InvoicePage"), "InvoicePage");
const Reports = page(() => import("./pages/Reports"), "Reports");
const Settings = page(() => import("./pages/Settings"), "Settings");
const AuditLog = page(() => import("./pages/AuditLog"), "AuditLog");
const Account = page(() => import("./pages/Account"), "Account");
const TechHome = page(() => import("./pages/Tech"), "TechHome");
const TechJob = page(() => import("./pages/Tech"), "TechJob");

/** Each role lands on the screen it uses most. */
function Home() {
  const role = useMe().data?.role;
  if (role === "technician") return <Navigate to="/tech" replace />;
  if (role === "client") return <Navigate to="/bikes" replace />;
  return <Dashboard />;
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="wrap muted">Loading…</div>}>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="tech" element={<TechHome />} />
            <Route path="tech/:id" element={<TechJob />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:id" element={<JobPage />} />
            <Route path="bikes" element={<Bikes />} />
            <Route path="bikes/:id" element={<BikePage />} />
            <Route path="clients" element={<Clients />} />
            <Route path="parts" element={<Parts />} />
            <Route path="invoices" element={<Invoices />} />
            <Route path="reports" element={<Reports />} />
            <Route path="settings" element={<Settings />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="account" element={<Account />} />
          </Route>
          <Route element={<Layout print />}>
            <Route path="invoices/:id" element={<InvoicePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
