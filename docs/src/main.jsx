import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import './index.css';

/*
 * The router's basename is the build's own base URL.
 *
 * The default build assumes it is being dropped at the root of a domain of its own. Built with
 * `--base=/docs/` the same source serves from under /docs beside the presentation site, and
 * every `<Link to="/installation">` in here resolves to /docs/installation without a single
 * component knowing where it ended up.
 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
