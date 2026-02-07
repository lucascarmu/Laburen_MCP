# Laburen – MCP Backend (Carrito Conversacional)

Este repositorio contiene la implementación del **MCP (Model Context Provider)** para un agente conversacional orientado a comercio, diseñado para integrarse con **Chatwoot** y permitir a un agente de IA:

- Explorar productos
- Consultar detalles
- Crear y mantener un carrito por conversación
- Agregar, modificar y eliminar productos del carrito
- Aplicar precios por volumen de forma consistente

La solución está desplegada sobre **Cloudflare Workers** y utiliza **Cloudflare D1** como base de datos.

---

## 📌 Alcance del proyecto

Este repositorio cubre los siguientes entregables del desafío:

| Nº | Elemento | Estado |
|---|---|---|
| 1 | Agente desplegado | ⏳ (fuera del alcance de esta documentación) |
| 2 | Repositorio GitHub (MCP) | ✅ Implementado |
| 3 | Diagrama(s) & documento conceptual | ✅ `/docs` |

La documentación se centra exclusivamente en el **código del MCP**, sus endpoints y la lógica de negocio implementada.

---

## 🏗️ Arquitectura general

- **Runtime**: Cloudflare Workers
- **Base de datos**: Cloudflare D1 (SQLite)
- **Patrón**: API HTTP + estado persistente por conversación
- **Integración prevista**: Chatwoot → Agente → MCP (este repo)

El MCP expone endpoints HTTP que el agente utiliza como *tools* para tomar decisiones durante la conversación.

---

## 🗂️ Estructura del repositorio

```
laburen-mcp-server/
├── src/
│   └── index.ts              # Worker + endpoints MCP
├── migrations/
│   └── 0001_init.sql         # Esquema de base de datos
├── scripts/
│   └── import_products.py    # Importador de productos desde XLSX
├── data/
│   └── products.xlsx         # Dataset de productos (input); colocar aquí el archivo (ignorado por .gitignore)
├── docs/
│   └── flow_diagram.jpg      # Diagrama de flujo del agente
├── wrangler.toml
└── README.md
```

---

## 🗃️ Modelo de datos

### products
Representa el catálogo disponible.

- tipo_prenda
- talla
- color
- categoria
- descripcion
- cantidad_disponible
- disponible (0/1)
- precio_50_u_cents
- precio_100_u_cents
- precio_200_u_cents

Los precios se almacenan en **centavos** para evitar errores de punto flotante.

---

### carts
Un carrito por conversación.

- conversation_id (único)
- created_at
- updated_at

---

### cart_items
Ítems dentro del carrito.

- cart_id
- product_id
- qty
- unit_price_cents

El **precio unitario aplicado se persiste** para garantizar consistencia si el catálogo cambia.

---

## 💰 Lógica de precios por volumen

El precio unitario se calcula en función de la cantidad total del producto en el carrito:

- qty < 100 → precio_50_u
- 100 ≤ qty < 200 → precio_100_u
- qty ≥ 200 → precio_200_u

Este cálculo se aplica tanto al agregar productos como al modificar cantidades.

---

## 🔌 Endpoints del MCP

### Healthcheck
```
GET /health
```

Verifica que el Worker esté operativo.

---

### Listar productos
```
GET /list_products?query=texto
```

Devuelve un listado de productos disponibles filtrados por texto libre.

Uso típico: exploración inicial del usuario.

---

### Obtener detalle de producto
```
GET /get_product?product_id=ID
```

Devuelve el detalle completo de un producto específico.

Uso típico: cuando el usuario pide más información sobre un producto mostrado previamente.

---

### Crear carrito
```
POST /create_cart
Content-Type: application/json

{
  "conversation_id": "cw_123"
}
```

- Crea un carrito asociado a la conversación.
- Si el carrito ya existe, devuelve el existente.
- Garantiza **idempotencia por conversación**.

---

### Agregar ítem al carrito
```
POST /add_item
Content-Type: application/json

{
  "cart_id": 1,
  "product_id": 10,
  "qty": 50
}
```

- Valida existencia de carrito y producto
- Verifica stock disponible
- Calcula precio por volumen
- Inserta o actualiza el ítem
- Devuelve resumen del carrito

---

### Obtener carrito
```
GET /get_cart?cart_id=1
GET /get_cart?conversation_id=cw_123
```

Devuelve el estado actual del carrito con:

- ítems
- subtotales
- total acumulado

---

### Actualizar carrito (extra)
```
POST /update_cart
Content-Type: application/json
```

#### Cambiar cantidad
```
{
  "cart_id": 1,
  "operation": {
    "op": "set_qty",
    "product_id": 10,
    "qty": 120
  }
}
```

#### Eliminar producto
```
{
  "cart_id": 1,
  "operation": {
    "op": "remove",
    "product_id": 10
  }
}
```

Este endpoint permite editar el carrito y recalcula precios si el cambio de cantidad cruza un umbral de volumen.

---

## 🔄 Flujo conversacional (alto nivel)

1. Usuario explora productos → `list_products`
2. Usuario solicita detalles → `get_product`
3. Usuario decide comprar → `create_cart`
4. Usuario agrega productos → `add_item`
5. Usuario revisa estado → `get_cart`
6. (Opcional) Usuario edita carrito → `update_cart`

El diagrama completo se encuentra en la carpeta `/docs`.

---

## 📥 Importación de productos

El catálogo se importa desde un archivo Excel (`products.xlsx`) mediante un script en Python.

```
python scripts/import_products.py local
python scripts/import_products.py remote
```

El script:
- normaliza datos
- convierte precios a centavos
- limpia el catálogo previo
- inserta todos los productos de forma segura en D1

---

## ✅ Consideraciones de diseño

- Estado persistente por conversación
- Precios inmutables por ítem una vez aplicados
- Manejo explícito de errores (stock, inexistencia, invalidaciones)
- Endpoints pensados para ser consumidos como *tools* por un agente LLM
- Código preparado para escalar a nuevas operaciones

---

## 📎 Notas finales

Este MCP constituye el backend completo necesario para un agente conversacional de e-commerce, desacoplado del canal (Chatwoot) y enfocado en lógica de negocio clara y consistente.

La integración del agente y su despliegue se realiza en una etapa posterior.

---