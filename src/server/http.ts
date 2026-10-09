import type { BunRequest } from "bun";
import { userFromRequest } from "./auth";
import type { User } from "../shared/types";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });
export const fail = (status: number, error: string) => Response.json({ error }, { status });

export type Ctx = { req: BunRequest<string>; user: User; params: Record<string, string> };

/** Handler autenticado: 401 sin token válido, HttpError → { error }, el resto → 500. */
export const authed =
  (fn: (ctx: Ctx) => Promise<unknown> | unknown) =>
  async (req: BunRequest<string>): Promise<Response> => {
    const user = userFromRequest(req);
    if (!user) return fail(401, "Sesión requerida");
    try {
      const out = await fn({ req, user, params: (req.params ?? {}) as Record<string, string> });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error(e);
      return fail(500, e instanceof Error ? e.message : "Error interno");
    }
  };

export const bodyOf = async <T>(req: Request): Promise<Partial<T>> => ((await req.json().catch(() => ({}))) as Partial<T>) ?? {};
