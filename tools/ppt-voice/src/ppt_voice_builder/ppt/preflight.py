from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from ppt_voice_builder.domain.models import SlideNote


@dataclass(frozen=True)
class PreflightReport:
    slide_count: int
    empty_note_slides: tuple[int, ...]
    character_count: int
    estimated_cost_yuan: Decimal


def estimate_cost_yuan(character_count: int, price_per_10k_chars: Decimal) -> Decimal:
    if character_count < 0 or price_per_10k_chars < 0:
        raise ValueError("字符数和单价不能为负数")
    value = Decimal(character_count) * price_per_10k_chars / Decimal(10_000)
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def build_preflight_report(notes: list[SlideNote], price: Decimal) -> PreflightReport:
    empty = tuple(note.slide_index for note in notes if not note.has_note)
    count = sum(len(note.normalized_text) for note in notes)
    return PreflightReport(len(notes), empty, count, estimate_cost_yuan(count, price))
