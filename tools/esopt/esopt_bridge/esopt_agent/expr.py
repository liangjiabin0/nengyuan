from __future__ import annotations

import re
from typing import Any


class ExprError(ValueError):
    pass


def parse_linear(expr: str) -> dict[str, Any]:
    """Parse 'max 3*x + 2*y' or '5 x1 + 3 x2 <= 100' into terms/sense/rhs."""
    text = expr.strip()
    if not text:
        raise ExprError("empty expression")
    lowered = text.lower()
    obj_sense = "minimize"
    if lowered.startswith("min "):
        obj_sense = "minimize"
        text = text[4:]
    elif lowered.startswith("max "):
        obj_sense = "maximize"
        text = text[4:]
    elif lowered.startswith("minimize "):
        obj_sense = "minimize"
        text = text[9:]
    elif lowered.startswith("maximize "):
        obj_sense = "maximize"
        text = text[9:]

    sense = None
    rhs = 0.0
    for token in ("<=", ">=", "==", "="):
        if token in text:
            left, right = text.split(token, 1)
            sense = "<=" if token == "<=" else ">=" if token == ">=" else "=="
            try:
                rhs = float(right.strip())
            except ValueError as exc:
                raise ExprError(f"right-hand side is not a number: {right}") from exc
            text = left
            break

    text = text.replace("-", "+-")
    terms: list[dict[str, Any]] = []
    token_re = re.compile(r"^([+-]?(?:\d+(?:\.\d*)?|\.\d+)?)\s*\*?\s*([A-Za-z_]\w*)$")
    for part in text.split("+"):
        part = part.strip()
        if not part:
            continue
        match = token_re.match(part.replace(" ", ""))
        if not match:
            raise ExprError(f"cannot parse term '{part}'. Use forms like 3*x, -2 y, or x1")
        coef_text, var = match.group(1), match.group(2)
        if coef_text in {"", "+", "-"}:
            coef = -1.0 if coef_text == "-" else 1.0
        else:
            coef = float(coef_text)
        terms.append({"var": var, "coef": coef})
    if not terms:
        raise ExprError("expression has no variable terms")
    return {"terms": terms, "sense": sense, "rhs": rhs, "obj_sense": obj_sense, "expr": expr}
