export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 500,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const forbidden = (msg = "Эрх хүрэхгүй байна") => new AppError(403, "forbidden", msg);
export const notFound = (msg = "Олдсонгүй") => new AppError(404, "not_found", msg);
/** Another actor already changed the state (double click, 2 admins at once). */
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);

/** D1/Drizzle wrap SQLite errors; walk the cause chain. */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if (String((cur as Error).message ?? cur).includes("UNIQUE constraint failed")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
