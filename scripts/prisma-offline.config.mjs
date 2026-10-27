// Kept for offline CLI inspection only. The preflight uses fixed engine RPC empty -> datamodel.
export default {
  schema: new URL('../prisma/schema.prisma', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  ),
};
