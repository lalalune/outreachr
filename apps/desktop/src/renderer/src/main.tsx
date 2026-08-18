import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from './lib/router';
import { App } from './App';
import { WorkspaceProvider } from './state/WorkspaceContext';
import { getStoredTheme } from './lib/theme';
import './styles/global.css';

document.documentElement.dataset.theme = getStoredTheme();

const root = document.getElementById('root');

if (!root) {
  throw new Error('Outreachr could not find its application root.');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <HashRouter>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </HashRouter>
  </React.StrictMode>,
);
