import re
import unicodedata

_PUNCTUATION = str.maketrans({",": "，", ";": "；", ":": "：", "!": "！", "?": "？"})


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).replace("\u200b", "").replace("\ufeff", "")
    normalized = normalized.translate(_PUNCTUATION)
    normalized = re.sub(r"[\t\r\n\u3000 ]+", " ", normalized)
    normalized = re.sub(r"\s+([，。；：！？])", r"\1", normalized)
    normalized = re.sub(r"([，。；：！？])\s+", r"\1", normalized)
    return normalized.strip()
