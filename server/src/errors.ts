export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}
export const badRequest = (message: string, code = 'validation', fields?: Record<string, string>) => new AppError(400, code, message, fields);
export const notFound = (what = 'Recurso') => new AppError(404, 'not_found', `${what} no encontrado`);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const unauthorized = (message = 'Sesión requerida') => new AppError(401, 'unauthorized', message);
