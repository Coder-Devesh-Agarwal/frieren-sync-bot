import { TOTP } from "otpauth";
import { createSession, validateSession, removeSession } from "./db";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOTP_SECRET = process.env.TOTP_SECRET;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !TOTP_SECRET) {
  console.error("Missing required env vars: ADMIN_EMAIL, ADMIN_PASSWORD, TOTP_SECRET");
  process.exit(1);
}

const totp = new TOTP({
  secret: TOTP_SECRET,
  digits: 6,
  period: 30,
});

export function verifyLogin(email: string, password: string, totpCode: string): string | null {
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return null;
  }

  const delta = totp.validate({ token: totpCode, window: 1 });
  if (delta === null) {
    return null;
  }

  const token = generateToken();
  createSession(token);
  return token;
}

export function verifySession(request: Request): boolean {
  const token = getSessionToken(request);
  if (!token) return false;
  return validateSession(token);
}

export function logout(request: Request) {
  const token = getSessionToken(request);
  if (token) removeSession(token);
}

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;

  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1]! : null;
}

export function sessionCookie(token: string): string {
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;
}

export function clearCookie(): string {
  return `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
