// Explicit build-time rollout. Never fall back from approved mode to legacy access.
const model = import.meta.env.VITE_ACCESS_MODEL || 'legacy';
if (!['legacy', 'approved'].includes(model)) throw new Error('Unknown access model; refusing to start with fallback authorization.');
export const approvedAccessEnabled = model === 'approved';
