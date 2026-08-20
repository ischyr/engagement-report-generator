import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // `booting` gates the whole app so protected routes never flash the login page.
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState({
    registrationOpen: true,
    needsBootstrap: false,
    approvalRequired: true,
  });

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setSessionLostHandler(clearSession);
  }, [clearSession]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.get('/auth/status'));
    } catch {
      /* the login screen falls back to showing the form */
    }
  }, []);

  // On boot, try to resume from the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await refreshSession();
      if (cancelled) return;
      if (session?.user) setUser(session.user);
      // Always, not only when signed out: `/auth/status` also carries the
      // instance's branding, which the sidebar needs on every page.
      await loadStatus();
      if (!cancelled) setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  /** Adopts a `{ user, accessToken }` payload as the live session. */
  const adopt = useCallback((data) => {
    setAccessToken(data.accessToken);
    setUser(data.user);
    return data.user;
  }, []);

  /**
   * Signing in can end in three places, so this returns a discriminated result
   * rather than a user: straight in, a code is needed, or enrolment was never
   * finished and has to be completed first.
   *
   * @returns {Promise<{status:'signed-in', user:object}
   *   | {status:'mfa', mfaToken:string}
   *   | {status:'enrol', enrolmentToken:string, enrolment:object}
   *   | {status:'awaiting-approval', username:string}>}
   */
  const login = useCallback(
    async (username, password) => {
      const data = await api.post('/auth/login', { username, password }, { skipAuthRetry: true });
      if (data.mfaRequired) return { status: 'mfa', mfaToken: data.mfaToken };
      /*
       * The password was right and there is still nothing to sign into. Not an error —
       * the API answers 200 for it — so it must not be thrown, or a normal state ends up
       * rendered as a failure the person cannot do anything about.
       */
      if (data.approvalRequired) {
        return { status: 'awaiting-approval', username: data.username ?? username };
      }
      if (data.enrolmentRequired) {
        return {
          status: 'enrol',
          enrolmentToken: data.enrolmentToken,
          enrolment: data.enrolment,
        };
      }
      return { status: 'signed-in', user: adopt(data) };
    },
    [adopt]
  );

  /**
   * Second step of sign-in: the six-digit code.
   *
   * Can also come back "waiting for approval": a challenge outlives the request that
   * minted it, and approval can be withdrawn inside that window.
   */
  const verifyMfa = useCallback(
    async (mfaToken, code) => {
      const data = await api.post('/auth/login/verify', { mfaToken, code }, { skipAuthRetry: true });
      if (data.approvalRequired) return { status: 'awaiting-approval', username: data.username };
      return { status: 'signed-in', user: adopt(data) };
    },
    [adopt]
  );

  /** Registration never returns a session — it returns an enrolment to complete. */
  const register = useCallback(async (payload) => {
    const data = await api.post('/auth/register', payload, { skipAuthRetry: true });
    return {
      enrolmentToken: data.enrolmentToken,
      enrolment: data.enrolment,
      approvalRequired: Boolean(data.approvalRequired),
      user: data.user,
    };
  }, []);

  /**
   * Confirms a code during registration (or a resumed registration).
   *
   * Two outcomes rather than one: a session, or a finished setup that still needs an
   * administrator. The caller has to be able to tell them apart, so this returns the
   * shape rather than a user.
   *
   * @returns {Promise<{status:'signed-in', user:object}
   *   | {status:'awaiting-approval', username:string}>}
   */
  const completeEnrolment = useCallback(
    async (enrolmentToken, code) => {
      const data = await api.post(
        '/auth/register/verify',
        { enrolmentToken, code },
        { skipAuthRetry: true }
      );
      if (data.approvalRequired) {
        return { status: 'awaiting-approval', username: data.username };
      }
      return { status: 'signed-in', user: adopt(data) };
    },
    [adopt]
  );

  /* --------------------------- 2FA from the profile -------------------------- */

  const startTwoFactorSetup = useCallback(async () => {
    const data = await api.post('/auth/me/2fa/setup');
    return data.enrolment;
  }, []);

  const enableTwoFactor = useCallback(async (code) => {
    const data = await api.post('/auth/me/2fa/enable', { code });
    setUser(data.user);
    return data.user;
  }, []);

  const disableTwoFactor = useCallback(async (password, code) => {
    const data = await api.post('/auth/me/2fa/disable', { password, code });
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      // The server clears presence from this call, so the user does not linger
      // in everyone else's "online now" list.
      await api.post('/auth/logout');
    } finally {
      clearSession();
      await loadStatus();
    }
  }, [clearSession, loadStatus]);

  const updateProfile = useCallback(async (payload) => {
    const data = await api.put('/auth/me', payload);
    setUser(data.user);
    return data.user;
  }, []);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const data = await api.put('/auth/me/password', { currentPassword, newPassword });
    setAccessToken(data.accessToken);
    setUser(data.user);
  }, []);

  /**
   * What this instance calls itself. Falls back to the product's own name, so a
   * fresh install and an unreachable API both render something sensible.
   */
  const branding = useMemo(
    () => ({
      appName: status.branding?.appName || 'Engy Report',
      tagline: status.branding?.tagline ?? 'Engagement Reporting',
      logo: status.branding?.logo || '',
    }),
    [status.branding]
  );

  /* The tab's title and icon follow the branding, for both signed-in and out. */
  useEffect(() => {
    document.title = branding.appName;
    if (!branding.logo) return;
    const link = document.querySelector("link[rel~='icon']");
    if (link) link.href = branding.logo;
  }, [branding.appName, branding.logo]);

  const value = useMemo(
    () => ({
      user,
      booting,
      status,
      branding,
      login,
      verifyMfa,
      register,
      completeEnrolment,
      logout,
      updateProfile,
      changePassword,
      startTwoFactorSetup,
      enableTwoFactor,
      disableTwoFactor,
      refreshStatus: loadStatus,
      /*
       * From the list, not the primary. An account can hold more than one role now, and the
       * whole point is that a consultant who is also a manager is both.
       */
      isAdmin: (user?.roles ?? []).includes('admin'),
      /** Signing a client's paperwork off. Admins hold every authority, as everywhere. */
      isManager:
        (user?.roles ?? []).includes('manager') || (user?.roles ?? []).includes('admin'),
      /*
       * A sales account is not a narrower view of the same app — it reaches the Sales
       * section and nothing else. The API enforces that; this is what the shell uses to
       * avoid rendering links and panels it would only get a 403 from.
       */
      isSales:
        (user?.roles ?? []).includes('sales') &&
        // Somebody who both sells and delivers is not confined to the Sales section.
        !(user?.roles ?? []).some((role) => ['admin', 'manager', 'user', 'readonly'].includes(role)),
      canWrite:
        Boolean(user) &&
        !(user.roles ?? []).includes('readonly') &&
        (user.roles ?? []).some((role) => ['admin', 'manager', 'user'].includes(role)),
    }),
    [
      user,
      booting,
      status,
      branding,
      login,
      verifyMfa,
      register,
      completeEnrolment,
      logout,
      updateProfile,
      changePassword,
      startTwoFactorSetup,
      enableTwoFactor,
      disableTwoFactor,
      loadStatus,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Just the branding, for the shell and the sign-in screen. */
export function useBranding() {
  return useContext(AuthContext)?.branding ?? {
    appName: 'Engy Report',
    tagline: 'Engagement Reporting',
    logo: '',
  };
}

export default AuthContext;
