import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import './index.css';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { NavigationProvider } from './context/NavigationContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { UnsavedProvider } from './context/UnsavedContext.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/*
      `v7_startTransition` makes the router mark its own state updates as transitions, which is the
      same thing `NavigationProvider` does at the call sites it is used from — and it reaches the
      ones it is not. Every `<Link>` in the app, and every `navigate()` written before this
      existed, now leaves the outgoing page on screen while the incoming chunk loads instead of
      emptying the content area to a spinner. The provider is still what knows a navigation is
      *pending*, which is what draws the bar; the flag is what stops the blank everywhere else.
    */}
    <BrowserRouter future={{ v7_startTransition: true }}>
      {/*
        Inside the router because it calls `useNavigate`, and above everything else because the
        shell and the pages both navigate — one transition between them, so one thing knows
        whether a navigation is in flight.
      */}
      <NavigationProvider>
        <ToastProvider>
          <AuthProvider>
            <UnsavedProvider>
              <App />
            </UnsavedProvider>
          </AuthProvider>
        </ToastProvider>
      </NavigationProvider>
    </BrowserRouter>
  </StrictMode>
);
