interface Env {
	laburen_db: D1Database;
  }
  
  type JsonValue = any;
  
  function json(data: JsonValue, status = 200): Response {
	return new Response(JSON.stringify(data), {
	  status,
	  headers: { "content-type": "application/json; charset=utf-8" },
	});
  }
  
  function badRequest(message: string, extra: JsonValue = {}) {
	return json({ ok: false, error: "BAD_REQUEST", message, ...extra }, 400);
  }
  
  function parseIntSafe(v: any): number | null {
	if (v === null || v === undefined) return null;
	const n = Number.parseInt(String(v), 10);
	return Number.isFinite(n) ? n : null;
  }
  
  async function readJson(request: Request): Promise<any> {
	const ct = request.headers.get("content-type") ?? "";
	if (!ct.toLowerCase().includes("application/json")) {
	  throw new Error("Expected application/json body");
	}
	return await request.json();
  }
  
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
	// items + product fields
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
  
  export default {
	async fetch(request: Request, env: Env): Promise<Response> {
	  const url = new URL(request.url);
  
	  try {
		// Health
		if (url.pathname === "/health") {
		  return json({ ok: true, service: "laburen-mcp-server" });
		}
  
		// list_products
		if (url.pathname === "/list_products") {
		  const query = (url.searchParams.get("query") ?? "").trim();
		  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 20);
  
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
  
		  return json({ ok: true, query, products: result.results });
		}
  
		// get_product
		if (url.pathname === "/get_product") {
		  const product_id = parseIntSafe(url.searchParams.get("product_id"));
		  if (!product_id) return badRequest("product_id is required");
  
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
  
		  if (!res) return json({ ok: false, error: "PRODUCT_NOT_FOUND" }, 404);
  
		  return json({ ok: true, product: res });
		}
  
		// create_cart
		if (url.pathname === "/create_cart" && request.method === "POST") {
		  const body = await readJson(request);
		  const conversation_id = (body?.conversation_id ?? "").toString().trim();
		  if (!conversation_id) return badRequest("conversation_id is required");
  
		  // si existe, devolver
		  const existing = await env.laburen_db
			.prepare(`SELECT id FROM carts WHERE conversation_id = ?1 LIMIT 1`)
			.bind(conversation_id)
			.first();
  
		  if (existing?.id) {
			return json({ ok: true, cart_id: Number(existing.id), created: false });
		  }
  
		  // crear
		  const insert = await env.laburen_db
			.prepare(`INSERT INTO carts (conversation_id) VALUES (?1)`)
			.bind(conversation_id)
			.run();
  
		  // D1 devuelve meta con last_row_id
		  const cart_id = Number(insert.meta?.last_row_id);
		  return json({ ok: true, cart_id, created: true });
		}
  
		// add_item
		if (url.pathname === "/add_item" && request.method === "POST") {
		  const body = await readJson(request);
  
		  const cart_id = parseIntSafe(body?.cart_id);
		  const product_id = parseIntSafe(body?.product_id);
		  const qty = parseIntSafe(body?.qty);
  
		  if (!cart_id) return badRequest("cart_id is required");
		  if (!product_id) return badRequest("product_id is required");
		  if (!qty || qty <= 0) return json({ ok: false, error: "INVALID_QTY" }, 400);
  
		  // validar carrito
		  const cart = await env.laburen_db
			.prepare(`SELECT id FROM carts WHERE id = ?1 LIMIT 1`)
			.bind(cart_id)
			.first();
		  if (!cart) return json({ ok: false, error: "CART_NOT_FOUND" }, 404);
  
		  // validar producto
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
  
		  if (!product) return json({ ok: false, error: "PRODUCT_NOT_FOUND" }, 404);
		  if (Number(product.disponible) !== 1) return json({ ok: false, error: "PRODUCT_NOT_AVAILABLE" }, 409);
  
		  // qty actual en carrito (si existe)
		  const existingItem = await env.laburen_db
			.prepare(`SELECT qty FROM cart_items WHERE cart_id = ?1 AND product_id = ?2 LIMIT 1`)
			.bind(cart_id, product_id)
			.first();
  
		  const currentQty = existingItem?.qty ? Number(existingItem.qty) : 0;
		  const newQty = currentQty + qty;
  
		  const stock = Number(product.cantidad_disponible);
		  if (newQty > stock) {
			return json(
			  { ok: false, error: "INSUFFICIENT_STOCK", available: stock, requested: newQty },
			  409
			);
		  }
  
		  // calcular precio por tier usando la cantidad FINAL
		  const unit_price_cents = unitPriceFromProductRow(product, newQty);
		  const tier = priceTierForQty(newQty);
  
		  // upsert (si existe, update; si no, insert)
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
  
		  // actualizar updated_at
		  await env.laburen_db
			.prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?1`)
			.bind(cart_id)
			.run();
  
		  const summary = await getCartSummary(env.laburen_db, cart_id);
		  return json({
			ok: true,
			applied_price_tier: tier,
			cart: summary,
		  });
		}
  
		// update_cart
		if (url.pathname === "/update_cart" && request.method === "POST") {
		  const body = await readJson(request);
		  const cart_id = parseIntSafe(body?.cart_id);
		  const op = body?.operation;
  
		  if (!cart_id) return badRequest("cart_id is required");
		  if (!op || typeof op !== "object") return badRequest("operation is required");
  
		  const cart = await env.laburen_db
			.prepare(`SELECT id FROM carts WHERE id = ?1 LIMIT 1`)
			.bind(cart_id)
			.first();
		  if (!cart) return json({ ok: false, error: "CART_NOT_FOUND" }, 404);
  
		  const opType = String(op.op ?? "").trim();
  
		  if (opType === "remove") {
			const product_id = parseIntSafe(op.product_id);
			if (!product_id) return badRequest("operation.product_id is required");
  
			await env.laburen_db
			  .prepare(`DELETE FROM cart_items WHERE cart_id = ?1 AND product_id = ?2`)
			  .bind(cart_id, product_id)
			  .run();
  
		  } else if (opType === "set_qty") {
			const product_id = parseIntSafe(op.product_id);
			const qty = parseIntSafe(op.qty);
  
			if (!product_id) return badRequest("operation.product_id is required");
			if (qty === null) return badRequest("operation.qty is required");
  
			// qty <= 0 => remove (más amigable)
			if (qty <= 0) {
			  await env.laburen_db
				.prepare(`DELETE FROM cart_items WHERE cart_id = ?1 AND product_id = ?2`)
				.bind(cart_id, product_id)
				.run();
			} else {
			  // validar producto + stock
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
  
			  if (!product) return json({ ok: false, error: "PRODUCT_NOT_FOUND" }, 404);
			  if (Number(product.disponible) !== 1) return json({ ok: false, error: "PRODUCT_NOT_AVAILABLE" }, 409);
  
			  const stock = Number(product.cantidad_disponible);
			  if (qty > stock) {
				return json(
				  { ok: false, error: "INSUFFICIENT_STOCK", available: stock, requested: qty },
				  409
				);
			  }
  
			  const unit_price_cents = unitPriceFromProductRow(product, qty);
			  const tier = priceTierForQty(qty);
  
			  // si existe item -> update, si no -> insert
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
  
			  // para que el agente pueda decir “te apliqué precio por 100u”
			  // lo devolvemos en la respuesta
			  await env.laburen_db
				.prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?1`)
				.bind(cart_id)
				.run();
  
			  const summary = await getCartSummary(env.laburen_db, cart_id);
			  return json({ ok: true, applied_price_tier: tier, cart: summary });
			}
		  } else {
			return badRequest("Unsupported operation.op. Use 'remove' or 'set_qty'.");
		  }
  
		  await env.laburen_db
			.prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?1`)
			.bind(cart_id)
			.run();
  
		  const summary = await getCartSummary(env.laburen_db, cart_id);
		  return json({ ok: true, cart: summary });
		}
  
		// get_cart
		if (url.pathname === "/get_cart") {
		  const cart_id = parseIntSafe(url.searchParams.get("cart_id"));
		  const conversation_id = (url.searchParams.get("conversation_id") ?? "").trim();
  
		  let resolvedCartId: number | null = cart_id ?? null;
  
		  if (!resolvedCartId && conversation_id) {
			const cart = await env.laburen_db
			  .prepare(`SELECT id FROM carts WHERE conversation_id = ?1 LIMIT 1`)
			  .bind(conversation_id)
			  .first();
			resolvedCartId = cart?.id ? Number(cart.id) : null;
		  }
  
		  if (!resolvedCartId) return badRequest("Provide cart_id or conversation_id");
  
		  const exists = await env.laburen_db
			.prepare(`SELECT id FROM carts WHERE id = ?1 LIMIT 1`)
			.bind(resolvedCartId)
			.first();
  
		  if (!exists) return json({ ok: false, error: "CART_NOT_FOUND" }, 404);
  
		  const summary = await getCartSummary(env.laburen_db, resolvedCartId);
		  return json({ ok: true, cart: summary });
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