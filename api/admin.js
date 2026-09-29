// Vercel function for /api/admin. It reuses the Netlify handler in netlify/edge-functions/admin.js,
// so both hosts run exactly the same code.
import handler from "../netlify/edge-functions/admin.js";

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const OPTIONS = handler;
