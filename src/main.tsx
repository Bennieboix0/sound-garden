import './polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerServiceWorker } from './pwa/serviceWorker';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Sound Garden: #root element is missing from index.html');

// Registered by hand so an update never reloads the page mid-performance.
registerServiceWorker();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
