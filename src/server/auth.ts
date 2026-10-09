import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { users } from "./db";
import type { User } from "../shared/types";

// Identidad liviana (§11.1): el token firmado es `<userId>.<hmac>`. No hay contraseñas.
const sign = (userId: string) => createHmac("sha256", config.sessionSecret).update(userId).digest("base64url");

export const issueToken = (user: User) => `${user.id}.${sign(user.id)}`;

export function userFromToken(token: string | null | undefined): User | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const id = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return users.byId(id);
}

export function userFromRequest(req: Request): User | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return userFromToken(header.slice(7));
  return userFromToken(new URL(req.url).searchParams.get("token"));
}
