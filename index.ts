import homepage from "./index.html";
import { verifyLogin, verifySession, logout, sessionCookie, clearCookie } from "./auth";
import {
  addMapping,
  listMappings,
  getMapping,
  deleteMapping,
  toggleMappingActive,
  setMappingDirection,
  getSyncStats,
  getGroupsFromDB,
  getGroupsLastUpdated,
} from "./db";
import {
  initialize as initWhatsApp,
  restartWhatsApp,
  getState,
  getQRDataURL,
  getPendingAccountReset,
  confirmAccountReset,
  dismissAccountReset,
  refreshGroups,
  fetchMissedMessages,
  fetchMoreMissedMessages,
  syncMessages,
  ignoreMessages,
  getReconcileSummary,
} from "./whatsapp";
import { RECONCILE_PAGE_SIZE } from "./constants";

const PORT = parseInt(process.env.PORT || "3000", 10);

// --- Helpers ---
function json(data: any, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function unauthorized() {
  return json({ error: "Unauthorized" }, 401);
}

function requireAuth(req: Request): Response | null {
  if (!verifySession(req)) return unauthorized();
  return null;
}

// --- Rate limiter ---
const loginAttempts = new Map<string, number[]>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (attempts.length >= RATE_LIMIT_MAX) return false;
  attempts.push(now);
  loginAttempts.set(ip, attempts);
  return true;
}

// --- Start WhatsApp on server boot ---
let whatsappInitPromise: Promise<void> | null = null;

function ensureWhatsApp() {
  if (whatsappInitPromise) return;
  whatsappInitPromise = initWhatsApp().catch((err) => {
    console.error("[Server] WhatsApp init failed:", err);
    whatsappInitPromise = null;
  });
}

// --- Server ---
const server = Bun.serve({
  port: PORT,

  routes: {
    "/": homepage,

    "/freiren.webp": (req) => new Response(Bun.file("public/freiren.webp")),

    "/api/auth/login": {
      POST: async (req) => {
        const ip = server.requestIP(req)?.address || "unknown";
        if (!checkRateLimit(ip)) {
          return json({ error: "Too many login attempts. Try again later." }, 429);
        }

        const body = (await req.json()) as { email?: string; password?: string; totp?: string };
        const { email, password, totp } = body;

        if (!email || !password || !totp) {
          return json({ error: "Email, password, and TOTP code are required" }, 400);
        }

        const token = verifyLogin(email, password, totp);
        if (!token) {
          return json({ error: "Invalid credentials or TOTP code" }, 401);
        }

        // Initialize WhatsApp on first successful login
        ensureWhatsApp();

        return json({ success: true }, 200, {
          "Set-Cookie": sessionCookie(token),
        });
      },
    },

    "/api/auth/logout": {
      POST: (req) => {
        logout(req);
        return json({ success: true }, 200, {
          "Set-Cookie": clearCookie(),
        });
      },
    },

    "/api/auth/status": {
      GET: (req) => {
        const authenticated = verifySession(req);
        return json({
          authenticated,
          whatsappState: authenticated ? getState() : null,
        });
      },
    },

    "/api/whatsapp/status": {
      GET: (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        return json({
          state: getState(),
          qr: getQRDataURL(),
          pendingAccountReset: getPendingAccountReset(),
        });
      },
    },

    "/api/whatsapp/restart": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        try {
          whatsappInitPromise = null;
          await restartWhatsApp();
          return json({ success: true });
        } catch (err) {
          console.error("[API] WhatsApp restart error:", err);
          return json({ error: "Failed to restart WhatsApp" }, 500);
        }
      },
    },

    "/api/whatsapp/reset": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        await confirmAccountReset();
        return json({ success: true });
      },
    },

    "/api/whatsapp/dismiss-reset": {
      POST: (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        dismissAccountReset();
        return json({ success: true });
      },
    },

    "/api/groups": {
      GET: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        const url = new URL(req.url);
        const shouldRefresh = url.searchParams.get("refresh") === "true";

        let groups;
        if (shouldRefresh) {
          const fresh = await refreshGroups();
          groups = fresh.map((g) => ({ id: g.id, name: g.name, participantCount: g.participantCount }));
        } else {
          const dbGroups = getGroupsFromDB();
          groups = dbGroups.map((g) => ({ id: g.id, name: g.name, participantCount: g.participant_count }));
        }

        return json({ groups, lastUpdated: getGroupsLastUpdated() });
      },
    },

    "/api/mappings": {
      GET: (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;
        return json(listMappings());
      },

      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        const body = (await req.json()) as {
          sourceGroupId?: string;
          sourceGroupName?: string;
          targetGroupId?: string;
          targetGroupName?: string;
          bidirectional?: boolean;
        };
        const { sourceGroupId, sourceGroupName, targetGroupId, targetGroupName, bidirectional } = body;

        if (!sourceGroupId || !targetGroupId) {
          return json({ error: "sourceGroupId and targetGroupId are required" }, 400);
        }

        if (sourceGroupId === targetGroupId) {
          return json({ error: "Source and target must be different groups" }, 400);
        }

        const mapping = addMapping(
          sourceGroupId,
          sourceGroupName || null,
          targetGroupId,
          targetGroupName || null,
          !!bidirectional
        );

        return json(mapping, 201);
      },
    },

    "/api/mappings/:id": {
      PATCH: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return json({ error: "Invalid mapping ID" }, 400);

        const existing = getMapping(id);
        if (!existing) return json({ error: "Mapping not found" }, 404);

        const body = (await req.json()) as { active?: boolean; bidirectional?: boolean };

        if (body.active !== undefined) {
          toggleMappingActive(id, !!body.active);
        }
        if (body.bidirectional !== undefined) {
          setMappingDirection(id, !!body.bidirectional);
        }

        return json(getMapping(id));
      },

      DELETE: (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return json({ error: "Invalid mapping ID" }, 400);

        const deleted = deleteMapping(id);
        if (!deleted) return json({ error: "Mapping not found" }, 404);

        return json({ success: true });
      },
    },

    "/api/stats": {
      GET: (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;
        return json(getSyncStats());
      },
    },

    "/api/reconcile/summary": {
      GET: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;
        if (getState() !== "ready") return json({ error: "WhatsApp not connected" }, 503);
        try {
          return json(await getReconcileSummary());
        } catch (err) {
          console.error("[API] Reconcile summary error:", err);
          return json({ error: "Failed to fetch reconcile summary" }, 500);
        }
      },
    },

    "/api/reconcile/messages": {
      GET: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;
        if (getState() !== "ready") return json({ error: "WhatsApp not connected" }, 503);

        const url = new URL(req.url);
        const mappingId = parseInt(url.searchParams.get("mappingId") || "", 10);
        const direction = url.searchParams.get("direction") || "forward";

        if (isNaN(mappingId)) return json({ error: "mappingId is required" }, 400);
        if (direction !== "forward" && direction !== "reverse") {
          return json({ error: "direction must be 'forward' or 'reverse'" }, 400);
        }

        try {
          return json(await fetchMissedMessages(mappingId, direction));
        } catch (err) {
          console.error("[API] Reconcile messages error:", err);
          return json({ error: "Failed to fetch messages" }, 500);
        }
      },
    },

    "/api/reconcile/sync": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;
        if (getState() !== "ready") return json({ error: "WhatsApp not connected" }, 503);

        const body = (await req.json()) as {
          mappingId?: number;
          direction?: string;
          messageIds?: string[];
        };
        if (!body.mappingId || !body.messageIds?.length) {
          return json({ error: "mappingId and messageIds[] are required" }, 400);
        }

        try {
          return json(await syncMessages(body.mappingId, body.direction || "forward", body.messageIds));
        } catch (err) {
          console.error("[API] Reconcile sync error:", err);
          return json({ error: "Failed to sync messages" }, 500);
        }
      },
    },

    "/api/reconcile/ignore": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;

        const body = (await req.json()) as {
          mappingId?: number;
          direction?: string;
          messageIds?: string[];
        };
        if (!body.mappingId || !body.messageIds?.length) {
          return json({ error: "mappingId and messageIds[] are required" }, 400);
        }

        try {
          return json(await ignoreMessages(body.mappingId, body.direction || "forward", body.messageIds));
        } catch (err) {
          console.error("[API] Reconcile ignore error:", err);
          return json({ error: "Failed to ignore messages" }, 500);
        }
      },
    },

    "/api/reconcile/load-more": {
      POST: async (req) => {
        const denied = requireAuth(req);
        if (denied) return denied;
        if (getState() !== "ready") return json({ error: "WhatsApp not connected" }, 503);

        const body = (await req.json()) as {
          mappingId?: number;
          direction?: string;
          currentCount?: number;
        };
        if (!body.mappingId) return json({ error: "mappingId is required" }, 400);

        try {
          return json(await fetchMoreMissedMessages(
            body.mappingId,
            body.direction || "forward",
            body.currentCount || RECONCILE_PAGE_SIZE
          ));
        } catch (err) {
          console.error("[API] Reconcile load-more error:", err);
          return json({ error: "Failed to load more messages" }, 500);
        }
      },
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`[Frieren] Server running at http://localhost:${server.port}`);
