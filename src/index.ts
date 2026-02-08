type Env = {
	laburen_db: D1Database;
	MCP_SESSION: DurableObjectNamespace;
  };
  
  
// ===== MCP over SSE (legacy HTTP+SSE transport) =====
// Spec: server exposes GET /sse + POST /messages; /sse sends `endpoint` event first.  [oai_citation:1‡modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

type McpSession = {
  sessionId: string;
  // For pushing SSE events
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  // If messages arrive before controller is ready, queue them
  queue: string[];
  createdAt: number;
};

// In-memory session registry (per Worker instance)
const MCP_SESSIONS = new Map<string, McpSession>();

// --- Optional simple auth header for MCP connection ---
const REQUIRE_MCP_KEY = false; // <- ponelo en true si querés exigir header
const MCP_KEY_HEADER = "x-mcp-key";
const MCP_KEY_VALUE = "laburen-dev-key"; // <- si REQUIRE_MCP_KEY=true, Laburen debe enviar este valor

function randomSessionId(): string {
  // crypto.randomUUID is available in Workers
  return crypto.randomUUID();
}

function sseEncode(event: string, data: any): string {
  // SSE "data:" must be a single line; JSON.stringify is OK; newlines need splitting.
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  // Split just in case JSON contains newlines (rare, but safe)
  const lines = payload.split("\n").map((l) => `data: ${l}`).join("\n");
  return `event: ${event}\n${lines}\n\n`;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

function badRequest(message: string, extra: any = {}): Response {
  return json({ ok: false, error: "BAD_REQUEST", message, ...extra }, 400);
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

async function readJson(request: Request): Promise<any> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    throw new Error("Expected application/json body");
  }
  return await request.json();
}

function parseIntSafe(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// --- Pricing logic (tier 50/100/200) ---
function priceTierForQty(qty: number): "50" | "100" | "200" {
  if (qty >= 200) return "200";
  if (qty >= 100) return "100";
  return "50";
}

function unitPriceFromProductRow(product: any, qty: number): number {
  const tier = priceTierForQty(qty);
  if (tier === "200") return Number(product.precio_200_u_cents);
  if (tier === "100") return Number(product.precio_100_u_cents);
  return Number(product.precio_50_u_cents);
}

async function getCartSummary(db: D1Database, cart_id: number) {
  const itemsRes = await db
    .prepare(
      `SELECT
         ci.product_id,
         ci.qty,
         ci.unit_price_cents,
         p.tipo_prenda,
         p.talla,
         p.color,
         p.categoria,
         p.descripcion
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = ?1
       ORDER BY ci.id ASC`
    )
    .bind(cart_id)
    .all();

  const items = (itemsRes.results ?? []).map((r: any) => {
    const line_total_cents = Number(r.qty) * Number(r.unit_price_cents);
    return {
      product_id: r.product_id,
      tipo_prenda: r.tipo_prenda,
      talla: r.talla,
      color: r.color,
      categoria: r.categoria,
      descripcion: r.descripcion,
      qty: Number(r.qty),
      unit_price_cents: Number(r.unit_price_cents),
      line_total_cents,
    };
  });

  const total_cents = items.reduce((acc: number, it: any) => acc + it.line_total_cents, 0);
  return { cart_id, items, total_cents };
}

// --- MCP tool implementations (call D1 directly) ---
async function tool_list_products(env: any, args: any) {
  const query = String(args?.query ?? "").trim();
  const limit = Math.min(parseInt(String(args?.limit ?? "5"), 10) || 5, 20);

  const sql = query
    ? `SELECT
         id, tipo_prenda, talla, color, cantidad_disponible,
         precio_50_u_cents, precio_100_u_cents, precio_200_u_cents,
         disponible, categoria, descripcion
       FROM products
       WHERE disponible = 1
         AND (
           tipo_prenda LIKE ?1 OR
           categoria   LIKE ?1 OR
           color       LIKE ?1 OR
           talla       LIKE ?1 OR
           descripcion LIKE ?1
         )
       ORDER BY id DESC
       LIMIT ?2`
    : `SELECT
         id, tipo_prenda, talla, color, cantidad_disponible,
         precio_50_u_cents, precio_100_u_cents, precio_200_u_cents,
         disponible, categoria, descripcion
       FROM products
       WHERE disponible = 1
       ORDER BY id DESC
       LIMIT ?1`;

  const stmt = env.laburen_db.prepare(sql);
  const result = query
    ? await stmt.bind(`%${query}%`, limit).all()
    : await stmt.bind(limit).all();

  return { query, products: result.results ?? [] };
}

async function tool_get_product(env: any, args: any) {
  const product_id = parseIntSafe(args?.product_id);
  if (!product_id) throw new Error("product_id is required");

  const res = await env.laburen_db
    .prepare(
      `SELECT
         id, tipo_prenda, talla, color, cantidad_disponible,
         precio_50_u_cents, precio_100_u_cents, precio_200_u_cents,
         disponible, categoria, descripcion
       FROM products
       WHERE id = ?1
       LIMIT 1`
    )
    .bind(product_id)
    .first();

  if (!res) return { ok: false, error: "PRODUCT_NOT_FOUND" };
  return { ok: true, product: res };
}

async function tool_create_cart(env: any, args: any) {
  const conversation_id = String(args?.conversation_id ?? "").trim();
  if (!conversation_id) throw new Error("conversation_id is required");

  const existing = await env.laburen_db
    .prepare(`SELECT id FROM carts WHERE conversation_id = ?1 LIMIT 1`)
    .bind(conversation_id)
    .first();

  if (existing?.id) return { ok: true, cart_id: Number(existing.id), created: false };

  const insert = await env.laburen_db
    .prepare(`INSERT INTO carts (conversation_id) VALUES (?1)`)
    .bind(conversation_id)
    .run();

  const cart_id = Number(insert.meta?.last_row_id);
  return { ok: true, cart_id, created: true };
}

async function tool_add_item(env: any, args: any) {
  const cart_id = parseIntSafe(args?.cart_id);
  const product_id = parseIntSafe(args?.product_id);
  const qty = parseIntSafe(args?.qty);

  if (!cart_id) throw new Error("cart_id is required");
  if (!product_id) throw new Error("product_id is required");
  if (!qty || qty <= 0) return { ok: false, error: "INVALID_QTY" };

  const cart = await env.laburen_db
    .prepare(`SELECT id FROM carts WHERE id = ?1 LIMIT 1`)
    .bind(cart_id)
    .first();
  if (!cart) return { ok: false, error: "CART_NOT_FOUND" };

  const product = await env.laburen_db
    .prepare(
      `SELECT
         id, cantidad_disponible, disponible,
         precio_50_u_cents, precio_100_u_cents, precio_200_u_cents
       FROM products
       WHERE id = ?1
       LIMIT 1`
    )
    .bind(product_id)
    .first();

  if (!product) return { ok: false, error: "PRODUCT_NOT_FOUND" };
  if (Number(product.disponible) !== 1) return { ok: false, error: "PRODUCT_NOT_AVAILABLE" };

  const existingItem = await env.laburen_db
    .prepare(`SELECT qty FROM cart_items WHERE cart_id = ?1 AND product_id = ?2 LIMIT 1`)
    .bind(cart_id, product_id)
    .first();

  const currentQty = existingItem?.qty ? Number(existingItem.qty) : 0;
  const newQty = currentQty + qty;

  const stock = Number(product.cantidad_disponible);
  if (newQty > stock) {
    return { ok: false, error: "INSUFFICIENT_STOCK", available: stock, requested: newQty };
  }

  const unit_price_cents = unitPriceFromProductRow(product, newQty);
  const tier = priceTierForQty(newQty);

  if (currentQty > 0) {
    await env.laburen_db
      .prepare(
        `UPDATE cart_items
         SET qty = ?1, unit_price_cents = ?2
         WHERE cart_id = ?3 AND product_id = ?4`
      )
      .bind(newQty, unit_price_cents, cart_id, product_id)
      .run();
  } else {
    await env.laburen_db
      .prepare(
        `INSERT INTO cart_items (cart_id, product_id, qty, unit_price_cents)
         VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(cart_id, product_id, newQty, unit_price_cents)
      .run();
  }

  await env.laburen_db
    .prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?1`)
    .bind(cart_id)
    .run();

  const cartSummary = await getCartSummary(env.laburen_db, cart_id);
  return { ok: true, applied_price_tier: tier, cart: cartSummary };
}

async function tool_update_cart(env: any, args: any) {
  const cart_id = parseIntSafe(args?.cart_id);
  const operation = args?.operation;

  if (!cart_id) throw new Error("cart_id is required");
  if (!operation || typeof operation !== "object") throw new Error("operation is required");

  const cart = await env.laburen_db
    .prepare(`SELECT id FROM carts WHERE id = ?1 LIMIT 1`)
    .bind(cart_id)
    .first();
  if (!cart) return { ok: false, error: "CART_NOT_FOUND" };

  const opType = String(operation.op ?? "").trim();

  if (opType === "remove") {
    const product_id = parseIntSafe(operation.product_id);
    if (!product_id) throw new Error("operation.product_id is required");

    await env.laburen_db
      .prepare(`DELETE FROM cart_items WHERE cart_id = ?1 AND product_id = ?2`)
      .bind(cart_id, product_id)
      .run();
  } else if (opType === "set_qty") {
    const product_id = parseIntSafe(operation.product_id);
    const qty = parseIntSafe(operation.qty);

    if (!product_id) throw new Error("operation.product_id is required");
    if (qty === null) throw new Error("operation.qty is required");

    if (qty <= 0) {
      await env.laburen_db
        .prepare(`DELETE FROM cart_items WHERE cart_id = ?1 AND product_id = ?2`)
        .bind(cart_id, product_id)
        .run();
    } else {
      const product = await env.laburen_db
        .prepare(
          `SELECT
             id, cantidad_disponible, disponible,
             precio_50_u_cents, precio_100_u_cents, precio_200_u_cents
           FROM products
           WHERE id = ?1
           LIMIT 1`
        )
        .bind(product_id)
        .first();

      if (!product) return { ok: false, error: "PRODUCT_NOT_FOUND" };
      if (Number(product.disponible) !== 1) return { ok: false, error: "PRODUCT_NOT_AVAILABLE" };

      const stock = Number(product.cantidad_disponible);
      if (qty > stock) {
        return { ok: false, error: "INSUFFICIENT_STOCK", available: stock, requested: qty };
      }

      const unit_price_cents = unitPriceFromProductRow(product, qty);
      const tier = priceTierForQty(qty);

      const existingItem = await env.laburen_db
        .prepare(`SELECT id FROM cart_items WHERE cart_id = ?1 AND product_id = ?2 LIMIT 1`)
        .bind(cart_id, product_id)
        .first();

      if (existingItem?.id) {
        await env.laburen_db
          .prepare(
            `UPDATE cart_items
             SET qty = ?1, unit_price_cents = ?2
             WHERE cart_id = ?3 AND product_id = ?4`
          )
          .bind(qty, unit_price_cents, cart_id, product_id)
          .run();
      } else {
        await env.laburen_db
          .prepare(
            `INSERT INTO cart_items (cart_id, product_id, qty, unit_price_cents)
             VALUES (?1, ?2, ?3, ?4)`
          )
          .bind(cart_id, product_id, qty, unit_price_cents)
          .run();
      }

      await env.laburen_db
        .prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?1`)
        .bind(cart_id)
        .run();

      const cartSummary = await getCartSummary(env.laburen_db, cart_id);
      return { ok: true, applied_price_tier: tier, cart: cartSummary };
    }
  } else {
    throw new Error("Unsupported operation.op. Use 'remove' or 'set_qty'.");
  }

  await env.laburen_db
    .prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?1`)
    .bind(cart_id)
    .run();

  const cartSummary = await getCartSummary(env.laburen_db, cart_id);
  return { ok: true, cart: cartSummary };
}

async function tool_get_cart(env: any, args: any) {
  const cart_id = parseIntSafe(args?.cart_id);
  const conversation_id = String(args?.conversation_id ?? "").trim();

  let resolvedCartId: number | null = cart_id ?? null;

  if (!resolvedCartId && conversation_id) {
    const cart = await env.laburen_db
      .prepare(`SELECT id FROM carts WHERE conversation_id = ?1 LIMIT 1`)
      .bind(conversation_id)
      .first();
    resolvedCartId = cart?.id ? Number(cart.id) : null;
  }

  if (!resolvedCartId) throw new Error("Provide cart_id or conversation_id");

  const exists = await env.laburen_db
    .prepare(`SELECT id FROM carts WHERE id = ?1 LIMIT 1`)
    .bind(resolvedCartId)
    .first();
  if (!exists) return { ok: false, error: "CART_NOT_FOUND" };

  const cartSummary = await getCartSummary(env.laburen_db, resolvedCartId);
  return { ok: true, cart: cartSummary };
}

// --- MCP JSON-RPC methods ---
function mcpToolsList() {
  // Minimal tool schemas for agent discovery.
  // Keep it simple and explicit.
  return [
    {
      name: "list_products",
      description: "List products filtered by query text.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text (optional)." },
          limit: { type: "integer", description: "Max results (default 5, max 20)." },
        },
      },
    },
    {
      name: "get_product",
      description: "Get full details for a product by id.",
      inputSchema: {
        type: "object",
        properties: {
          product_id: { type: "integer", description: "Product id." },
        },
        required: ["product_id"],
      },
    },
    {
      name: "create_cart",
      description: "Create (or retrieve existing) cart for a conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string", description: "Chatwoot conversation id." },
        },
        required: ["conversation_id"],
      },
    },
    {
      name: "add_item",
      description: "Add product to cart or increase quantity. Reprices by tier on final qty.",
      inputSchema: {
        type: "object",
        properties: {
          cart_id: { type: "integer" },
          product_id: { type: "integer" },
          qty: { type: "integer" },
        },
        required: ["cart_id", "product_id", "qty"],
      },
    },
    {
      name: "update_cart",
      description: "Edit cart items (set_qty/remove). Reprices on qty changes.",
      inputSchema: {
        type: "object",
        properties: {
          cart_id: { type: "integer" },
          operation: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set_qty", "remove"] },
              product_id: { type: "integer" },
              qty: { type: "integer" },
            },
            required: ["op", "product_id"],
          },
        },
        required: ["cart_id", "operation"],
      },
    },
    {
      name: "get_cart",
      description: "Get cart summary by cart_id or conversation_id.",
      inputSchema: {
        type: "object",
        properties: {
          cart_id: { type: "integer" },
          conversation_id: { type: "string" },
        },
      },
    },
  ];
}

async function handleMcpRpc(env: any, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = req.id ?? null;

  // Notifications (no id) => accept silently
  const isNotification = req.id === undefined;

  try {
    if (req.method === "initialize") {
      // Minimal initialize result: tell client server name/version & capabilities.
      const result = {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "laburen-mcp-server", version: "1.0.0" },
        capabilities: {
          tools: {},
        },
      };
      return isNotification ? null : { jsonrpc: "2.0", id, result };
    }

    if (req.method === "tools/list") {
      const result = { tools: mcpToolsList() };
      return isNotification ? null : { jsonrpc: "2.0", id, result };
    }

    if (req.method === "tools/call") {
      const name = String(req.params?.name ?? "");
      const args = req.params?.arguments ?? {};

      let toolResult: any;

      switch (name) {
        case "list_products":
          toolResult = await tool_list_products(env, args);
          break;
        case "get_product":
          toolResult = await tool_get_product(env, args);
          break;
        case "create_cart":
          toolResult = await tool_create_cart(env, args);
          break;
        case "add_item":
          toolResult = await tool_add_item(env, args);
          break;
        case "update_cart":
          toolResult = await tool_update_cart(env, args);
          break;
        case "get_cart":
          toolResult = await tool_get_cart(env, args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // MCP tools/call result commonly returns "content" blocks; keep it simple:
      const result = {
        content: [
          {
            type: "text",
            text: JSON.stringify(toolResult),
          },
        ],
      };

      return isNotification ? null : { jsonrpc: "2.0", id, result };
    }

    // Unknown method
    const error = { code: -32601, message: `Method not found: ${req.method}` };
    return isNotification ? null : { jsonrpc: "2.0", id, error };
  } catch (e: any) {
    const error = { code: -32000, message: e?.message ?? String(e) };
    return isNotification ? null : { jsonrpc: "2.0", id, error };
  }
}

function pushToSession(session: McpSession, payload: string) {
  if (session.controller) {
    session.controller.enqueue(new TextEncoder().encode(payload));
  } else {
    session.queue.push(payload);
  }
}

function requireMcpAuth(request: Request): boolean {
  if (!REQUIRE_MCP_KEY) return true;
  const key = request.headers.get(MCP_KEY_HEADER);
  return key === MCP_KEY_VALUE;
}
  
export class McpSessionDO {
	private state: DurableObjectState;
	private env: Env;
  
	// SSE runtime state (vive en esta instancia del DO)
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	private heartbeat: number | null = null;
  
	constructor(state: DurableObjectState, env: Env) {
	  this.state = state;
	  this.env = env;
	}
  
	private push(event: string, data: any) {
	  if (!this.controller) return;
	  const payload = sseEncode(event, data);
	  this.controller.enqueue(new TextEncoder().encode(payload));
	}
  
	async fetch(request: Request): Promise<Response> {
	  const url = new URL(request.url);
  
	  // (Opcional) auth por header si lo estás usando
	  // if (!requireMcpAuth(request)) return unauthorized();
  
	  // ===== SSE: abre canal =====
	  if (url.pathname === "/sse" && request.method === "GET") {
		// Importante: el sessionId será el ID del Durable Object
		const sessionId = this.state.id.toString();
  
		const base = `${url.protocol}//${url.host}`;
		const messagesUrl = `${base}/messages?sessionId=${encodeURIComponent(sessionId)}`;
  
		const stream = new ReadableStream<Uint8Array>({
		  start: (controller) => {
			this.controller = controller;
  
			// 1) Evento obligatorio: endpoint para POST JSON-RPC
			this.push("endpoint", messagesUrl);
  
			// 2) Mensaje informativo (opcional)
			this.push("message", {
			  jsonrpc: "2.0",
			  method: "notifications/message",
			  params: { level: "info", message: "MCP SSE session established (Durable Object)" },
			});
  
			// 3) Heartbeat para mantener vivo el stream (cada 15s)
			this.heartbeat = setInterval(() => {
			  // comentario SSE (no evento), para keep-alive
			  if (this.controller) {
				this.controller.enqueue(new TextEncoder().encode(`: ping\n\n`));
			  }
			}, 15000) as unknown as number;
		  },
		  cancel: () => {
			this.controller = null;
			if (this.heartbeat) clearInterval(this.heartbeat);
			this.heartbeat = null;
		  },
		});
  
		return sseResponse(stream);
	  }
  
	  // ===== JSON-RPC messages: recibe requests y responde por SSE =====
	  if (url.pathname === "/messages" && request.method === "POST") {
		// Si el DO existe, no hace falta validar sessionId acá:
		// el routing lo hace el Worker principal con env.MCP_SESSION.get(id)
  
		let rpc: JsonRpcRequest;
		try {
		  rpc = (await readJson(request)) as JsonRpcRequest;
		} catch (e: any) {
		  return badRequest("Invalid JSON body", { detail: e?.message ?? String(e) });
		}
  
		const response = await handleMcpRpc(this.env, rpc);
  
		// En este transporte, respondemos por SSE (event: message)
		if (response) this.push("message", response);
  
		return accepted(); // 202
	  }
  
	  return new Response("Not found", { status: 404 });
	}
}


  export default {
	async fetch(request: Request, env: Env): Promise<Response> {
	  const url = new URL(request.url);
	
		// ===== MCP (Durable Object) routing (preserve origin) =====
		if (url.pathname === "/sse" && request.method === "GET") {
			const id = env.MCP_SESSION.newUniqueId();
			const stub = env.MCP_SESSION.get(id);
		
			const doUrl = new URL(request.url);
			doUrl.pathname = "/sse";
			doUrl.search = "";
		
			return stub.fetch(new Request(doUrl.toString(), request));
		}
		
		if (url.pathname === "/messages" && request.method === "POST") {
			const sessionId = url.searchParams.get("sessionId") ?? "";
			if (!sessionId) return json({ ok: false, error: "SESSION_ID_REQUIRED" }, 400);
		
			const id = env.MCP_SESSION.idFromString(sessionId);
			const stub = env.MCP_SESSION.get(id);
		
			const doUrl = new URL(request.url);
			doUrl.pathname = "/messages";
		
			return stub.fetch(new Request(doUrl.toString(), request));
		}
	  
	  try {
		// Health
		if (url.pathname === "/health") {
		  return json({ ok: true, service: "laburen-mcp-server" });
		}
  
		// list_products
		if (url.pathname === "/list_products") {
			const data = await tool_list_products(env, {
				query: (url.searchParams.get("query") ?? "").trim(),
				limit: parseInt(url.searchParams.get("limit") ?? "5", 10),
			});
			return json({ ok: true, ...data });
		}
  
		// get_product
		if (url.pathname === "/get_product") {
			const product_id = parseIntSafe(url.searchParams.get("product_id"));
			if (!product_id) return badRequest("product_id is required");
		  
			const data = await tool_get_product(env, { product_id });
			if (data?.ok === false && data?.error === "PRODUCT_NOT_FOUND") {
			  return json({ ok: false, error: "PRODUCT_NOT_FOUND" }, 404);
			}
			return json(data);
		}
  
		// create_cart
		if (url.pathname === "/create_cart" && request.method === "POST") {
			const body = await readJson(request);
			const data = await tool_create_cart(env, { conversation_id: body?.conversation_id });
			return json(data);
		}
  
		// add_item
		if (url.pathname === "/add_item" && request.method === "POST") {
			const body = await readJson(request);
			const data = await tool_add_item(env, {
			  cart_id: body?.cart_id,
			  product_id: body?.product_id,
			  qty: body?.qty,
			});
		  
			// Mapear errores a HTTP codes (opcional, pero queda pro)
			if (data?.ok === false) {
			  const e = data.error;
			  const status =
				e === "CART_NOT_FOUND" || e === "PRODUCT_NOT_FOUND" ? 404 :
				e === "INVALID_QTY" ? 400 :
				e === "PRODUCT_NOT_AVAILABLE" || e === "INSUFFICIENT_STOCK" ? 409 :
				400;
			  return json(data, status);
			}
		  
			return json(data);
		}
  
		// update_cart
		if (url.pathname === "/update_cart" && request.method === "POST") {
			const body = await readJson(request);
			const data = await tool_update_cart(env, {
			  cart_id: body?.cart_id,
			  operation: body?.operation,
			});
		  
			if (data?.ok === false) {
			  const e = data.error;
			  const status =
				e === "CART_NOT_FOUND" || e === "PRODUCT_NOT_FOUND" ? 404 :
				e === "PRODUCT_NOT_AVAILABLE" || e === "INSUFFICIENT_STOCK" ? 409 :
				400;
			  return json(data, status);
			}
		  
			return json(data);
		}
  
		// get_cart
		if (url.pathname === "/get_cart") {
			const data = await tool_get_cart(env, {
			  cart_id: parseIntSafe(url.searchParams.get("cart_id")),
			  conversation_id: (url.searchParams.get("conversation_id") ?? "").trim(),
			});
		  
			if (data?.ok === false && data?.error === "CART_NOT_FOUND") {
			  return json(data, 404);
			}
		  
			return json(data);
		}

		// ===== MCP SSE endpoints =====
		if (url.pathname === "/sse" && request.method === "GET") {
			if (!requireMcpAuth(request)) return unauthorized();
		
			const sessionId = randomSessionId();
			const session: McpSession = {
			sessionId,
			controller: null,
			queue: [],
			createdAt: Date.now(),
			};
			MCP_SESSIONS.set(sessionId, session);
		
			const base = `${url.protocol}//${url.host}`;
			const messagesUrl = `${base}/messages?sessionId=${encodeURIComponent(sessionId)}`;
		
			const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				session.controller = controller;
		
				// 1) Mandatory endpoint event (tells client where to POST JSON-RPC)  [oai_citation:2‡modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)
				pushToSession(session, sseEncode("endpoint", messagesUrl));
		
				// 2) Optional: send a hello/info message to help debugging
				pushToSession(
				session,
				sseEncode("message", {
					jsonrpc: "2.0",
					method: "notifications/message",
					params: { level: "info", message: "MCP SSE session established" },
				})
				);
		
				// Flush queued (if any)
				for (const queued of session.queue) controller.enqueue(new TextEncoder().encode(queued));
				session.queue = [];
			},
			cancel() {
				// Client disconnected
				MCP_SESSIONS.delete(sessionId);
			},
			});
		
			return sseResponse(stream);
		}
		
		if (url.pathname === "/messages" && request.method === "POST") {
			if (!requireMcpAuth(request)) return unauthorized();
		
			const sessionId = url.searchParams.get("sessionId") ?? "";
			if (!sessionId) return badRequest("Missing sessionId");
		
			const session = MCP_SESSIONS.get(sessionId);
			if (!session) return json({ ok: false, error: "SESSION_NOT_FOUND" }, 404);
		
			let rpc: JsonRpcRequest;
			try {
			rpc = (await readJson(request)) as JsonRpcRequest;
			} catch (e: any) {
			return badRequest("Invalid JSON body", { detail: e?.message ?? String(e) });
			}
		
			// Handle JSON-RPC; push response on SSE as `message` events  [oai_citation:3‡modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)
			const response = await handleMcpRpc(env, rpc);
			if (response) {
			pushToSession(session, sseEncode("message", response));
			}
		
			// Legacy transport typically responds 202 and delivers response via SSE
			return accepted();
		}
  
		return new Response("Not found", { status: 404 });
	  } catch (err: any) {
		// evita 1101 opaco
		return json(
		  { ok: false, error: "INTERNAL_ERROR", message: err?.message ?? String(err) },
		  500
		);
	  }
	},
  };