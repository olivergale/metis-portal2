import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar.tsx';
import Manifold from './views/Manifold.tsx';
import Agents from './views/Agents.tsx';
import Logs from './views/Logs.tsx';
import Health from './views/Health.tsx';
import Chat from './views/Chat.tsx';

export default function App() {
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/manifold" replace />} />
          <Route path="/manifold" element={<Manifold />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/health" element={<Health />} />
          <Route path="/chat" element={<Chat />} />
        </Routes>
      </main>
    </div>
  );
}
