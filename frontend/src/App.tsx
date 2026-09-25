import { NavLink, Route, Routes } from 'react-router-dom';
import OverviewPage from './pages/OverviewPage';
import MetricsPage from './pages/MetricsPage';
import ProjectsPage from './pages/ProjectsPage';

const navItems = [
  { to: '/', label: 'Огляд', icon: '🛰️' },
  { to: '/metrics', label: 'Метрики', icon: '📊' },
  { to: '/projects', label: 'Проєкти', icon: '📁' },
];

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">🛡️</span>
          <div>
            <div className="brand-title">DevSecOps</div>
            <div className="brand-sub">Monitor</div>
          </div>
        </div>
        <nav className="nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div>Мікросервісна платформа</div>
          <div className="muted">v0.1.0 · DevSecOps</div>
        </div>
      </aside>

      <main className="content">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
        </Routes>
      </main>
    </div>
  );
}