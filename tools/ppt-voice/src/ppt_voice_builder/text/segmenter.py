import re


def segment_text(text: str, max_chars: int = 500) -> list[str]:
    if max_chars < 1:
        raise ValueError("max_chars 必须大于 0")
    if len(text) <= max_chars:
        return [text] if text else []
    parts = re.findall(r".*?[。！？；]|.+$", text)
    segments: list[str] = []
    current = ""
    for part in parts:
        while len(part) > max_chars:
            if current:
                segments.append(current)
                current = ""
            segments.append(part[:max_chars])
            part = part[max_chars:]
        if current and len(current) + len(part) > max_chars:
            segments.append(current)
            current = ""
        current += part
    if current:
        segments.append(current)
    return segments
