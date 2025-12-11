export const API_BASE = import.meta.env.VITE_API_URL || "/api";

export const apiUrl = (path = "") => {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${clean}`;
};
