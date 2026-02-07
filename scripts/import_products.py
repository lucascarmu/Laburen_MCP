import os
import subprocess
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
XLSX_PATH = ROOT / "data" / "products.xlsx"
OUT_SQL_DIR = ROOT / "sql"
OUT_SQL_PATH = OUT_SQL_DIR / "import_products.sql"

DB_NAME = "laburen_db"
TABLE = "products"

EXPECTED_COLS = [
    "ID",
    "TIPO_PRENDA",
    "TALLA",
    "COLOR",
    "CANTIDAD_DISPONIBLE",
    "PRECIO_50_U",
    "PRECIO_100_U",
    "PRECIO_200_U",
    "DISPONIBLE",
    "CATEGORÍA",
    "DESCRIPCIÓN",
]

def sql_quote(value) -> str:
    """Convierte a literal SQL seguro (simple)."""
    if value is None or (isinstance(value, float) and pd.isna(value)) or (isinstance(value, str) and value.strip() == ""):
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(int(value))
    # string
    s = str(value).replace("'", "''")
    return f"'{s}'"

def money_to_cents(x) -> int:
    """Convierte precio a centavos. Acepta numérico o string."""
    if x is None or (isinstance(x, float) and pd.isna(x)) or (isinstance(x, str) and x.strip() == ""):
        return 0
    if isinstance(x, str):
        s = x.strip()
        s = s.replace(".", "").replace(",", ".")
        try:
            val = float(s)
        except ValueError:
            val = 0.0
    else:
        val = float(x)
    return int(round(val * 100))

def normalize_disponible(x) -> int:
    """DISPONIBLE puede venir como 1/0, TRUE/FALSE, Si/No, etc."""
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return 0
    if isinstance(x, (int, float)):
        return 1 if int(x) != 0 else 0
    s = str(x).strip().lower()
    return 1 if s in {"1", "true", "t", "yes", "y", "si", "sí", "s"} else 0

def run(cmd: list[str]) -> None:
    print("\n$ " + " ".join(cmd))
    subprocess.run(cmd, check=True)

def main():
    if not XLSX_PATH.exists():
        print(f"ERROR: No encuentro el archivo: {XLSX_PATH}")
        print("Guardá el XLSX en ./data/products.xlsx")
        sys.exit(1)

    df = pd.read_excel(XLSX_PATH)

    # Validar columnas
    missing = [c for c in EXPECTED_COLS if c not in df.columns]
    if missing:
        print("ERROR: faltan columnas en el XLSX:", missing)
        print("Columnas encontradas:", list(df.columns))
        sys.exit(1)

    # Normalización
    df = df[EXPECTED_COLS].copy()

    # Texto
    df["TIPO_PRENDA"] = df["TIPO_PRENDA"].astype(str).str.strip()
    df["TALLA"] = df["TALLA"].astype(str).str.strip()
    df["COLOR"] = df["COLOR"].astype(str).str.strip()
    df["CATEGORÍA"] = df["CATEGORÍA"].astype(str).str.strip()
    df["DESCRIPCIÓN"] = df["DESCRIPCIÓN"].astype(str).str.strip()

    # Números
    df["CANTIDAD_DISPONIBLE"] = pd.to_numeric(df["CANTIDAD_DISPONIBLE"], errors="coerce").fillna(0).astype(int)
    df["PRECIO_50_U_CENTS"] = df["PRECIO_50_U"].apply(money_to_cents)
    df["PRECIO_100_U_CENTS"] = df["PRECIO_100_U"].apply(money_to_cents)
    df["PRECIO_200_U_CENTS"] = df["PRECIO_200_U"].apply(money_to_cents)
    df["DISPONIBLE_INT"] = df["DISPONIBLE"].apply(normalize_disponible)

    # Generar SQL
    OUT_SQL_DIR.mkdir(parents=True, exist_ok=True)

    # Si querés conservar carts, borrá solo products; si querés clean total, borrá todo.
    # Acá dejo SOLO products (porque tu pedido fue conservar solo los solicitados):
    header_sql = f"""-- Auto-generated from {XLSX_PATH.name}

DELETE FROM {TABLE};
DELETE FROM sqlite_sequence WHERE name = '{TABLE}';
"""

    insert_prefix = f"""INSERT INTO {TABLE}
(tipo_prenda, talla, color, cantidad_disponible,
 precio_50_u_cents, precio_100_u_cents, precio_200_u_cents,
 disponible, categoria, descripcion)
VALUES
"""

    values_lines = []
    for _, row in df.iterrows():
        values_lines.append(
            "("
            + ", ".join(
                [
                    sql_quote(row["TIPO_PRENDA"]),
                    sql_quote(row["TALLA"]),
                    sql_quote(row["COLOR"]),
                    str(int(row["CANTIDAD_DISPONIBLE"])),
                    str(int(row["PRECIO_50_U_CENTS"])),
                    str(int(row["PRECIO_100_U_CENTS"])),
                    str(int(row["PRECIO_200_U_CENTS"])),
                    str(int(row["DISPONIBLE_INT"])),
                    sql_quote(row["CATEGORÍA"]),
                    sql_quote(row["DESCRIPCIÓN"]),
                ]
            )
            + ")"
        )

    # Para no generar un INSERT gigante, lo partimos en chunks
    chunk_size = 500
    inserts_sql = []
    for i in range(0, len(values_lines), chunk_size):
        chunk = values_lines[i : i + chunk_size]
        inserts_sql.append(insert_prefix + ",\n".join(chunk) + ";\n")

    footer_sql = ""

    OUT_SQL_PATH.write_text(header_sql + "\n".join(inserts_sql) + footer_sql, encoding="utf-8")
    print(f"✅ SQL generado: {OUT_SQL_PATH} (rows={len(df)})")

    # Ejecutar
    target = (sys.argv[1].strip().lower() if len(sys.argv) > 1 else "local")
    if target not in {"local", "remote"}:
        print("Uso: python scripts/import_products.py [local|remote]")
        sys.exit(1)

    flag = "--remote" if target == "remote" else "--local"

    run(["npx", "wrangler", "d1", "execute", DB_NAME, flag, "--file", str(OUT_SQL_PATH)])

    print(f"🎉 Import OK en {target}.")

if __name__ == "__main__":
    main()