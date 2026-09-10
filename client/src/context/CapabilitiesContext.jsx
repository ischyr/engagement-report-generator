import { createContext, useContext, useMemo } from 'react';

import { useResource } from '../hooks/useResource.js';

/**
 * What this instance can do, fetched once.
 *
 * Two optional capabilities have to be known deep in the tree: whether a report can be rendered as
 * a PDF, and whether documents can be shared. The second is the reason this exists at all — a
 * finding has five shared fields and an enumeration step has seven, so a component asking the
 * server for itself would mean a dozen requests for one answer that is the same every time.
 *
 * Deliberately only the flags. Everything else in the settings document is an administrator's
 * business and is fetched by the settings page when somebody opens it; what is here is the part
 * every account is told, because every account can see the buttons it governs.
 */

const CapabilitiesContext = createContext({ collab: false, pdf: false, loading: true });

export function CapabilitiesProvider({ children }) {
  /* One request, behind the auth gate, and no polling: a capability does not change hourly. */
  const { data, loading } = useResource('/settings', { initial: null });

  const value = useMemo(
    () => ({
      collab: Boolean(data?.collab?.enabled),
      pdf: Boolean(data?.pdf?.enabled),
      loading,
    }),
    [data?.collab?.enabled, data?.pdf?.enabled, loading]
  );

  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities() {
  return useContext(CapabilitiesContext);
}

export default CapabilitiesProvider;
