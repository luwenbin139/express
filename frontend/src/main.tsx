import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import App from './App';
import './styles.css';

const EnglishStudio = lazy(() => import('./EnglishStudio'));

function Page() {
  return useLocation().pathname === '/english' ? <Suspense fallback={<p>正在加载英语工作台…</p>}><EnglishStudio /></Suspense> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Page />
    </BrowserRouter>
  </React.StrictMode>,
);
