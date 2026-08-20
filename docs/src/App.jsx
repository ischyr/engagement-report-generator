import { Navigate, Route, Routes } from 'react-router-dom';

import Layout from './components/Layout.jsx';
import DocPage from './components/DocPage.jsx';
import NotFound from './components/NotFound.jsx';
import { HOME } from './lib/pages.js';

/**
 * Every page is the same page with different Markdown in it, so there is one route.
 *
 * `/` redirects rather than rendering the introduction at two addresses: two URLs for one page is
 * two things to keep in a sitemap, and the one people paste is whichever they happened to land on.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to={`/${HOME}`} replace />} />
        <Route path=":slug" element={<DocPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
