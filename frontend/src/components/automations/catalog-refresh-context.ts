import { createContext } from "react";

/**
 * Counts explicit "Refresh list" requests in the automations catalog, so rows rendered
 * inside the list that own their own reads (the built-in rule) refresh along with it.
 */
export const CatalogRefreshContext = createContext(0);
