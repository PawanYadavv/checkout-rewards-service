



import type { ErrorRequestHandler, RequestHandler } from "express";

// Throw this anywhere in a route. The error handler below turns it into JSON:
// { "error": { "code": "CART_NOT_FOUND", "message": "...", "details": {...} } }
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// Runs when no route matched the URL.
export const notFoundHandler: RequestHandler = (req) => {
  throw new AppError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`);
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  // express.json() throws this when the request body is not valid JSON.
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    return;
  }
  // Anything else is a bug or an outage: log it, but do not leak internals to the client.
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
};

