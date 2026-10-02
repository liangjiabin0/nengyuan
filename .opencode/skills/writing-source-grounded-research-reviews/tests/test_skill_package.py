import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SkillPackageContractTests(unittest.TestCase):
    def test_skill_frontmatter_and_name_are_valid(self):
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        match = re.match(r"---\n(.*?)\n---", text, re.S)
        self.assertIsNotNone(match)
        frontmatter = match.group(1)
        name = re.search(r"^name:\s*(.+)$", frontmatter, re.M).group(1).strip()
        description = re.search(r"^description:\s*(.+)$", frontmatter, re.M).group(1).strip()
        self.assertRegex(name, r"^[A-Za-z0-9-]+$")
        self.assertTrue(description.startswith("Use when"))
        self.assertLessEqual(len(frontmatter), 1024)

    def test_required_supporting_files_exist(self):
        required = [
            "references/universal-prompt.md",
            "references/report-structure.md",
            "references/literature-review-style.md",
            "references/evidence-and-citation-rules.md",
            "references/word-format-spec.md",
            "examples/literature-evidence-matrix-template.md",
            "examples/research-section-template.md",
            "examples/technical-source-map-template.md",
            "scripts/extract_reference_list.py",
            "scripts/check_citation_consistency.py",
            "scripts/inspect_docx_format.py",
        ]
        missing = [path for path in required if not (ROOT / path).exists()]
        self.assertEqual(missing, [])

    def test_universal_prompt_contains_output_contract(self):
        text = (ROOT / "references/universal-prompt.md").read_text(encoding="utf-8")
        required_phrases = [
            "作者与年份",
            "研究对象",
            "解决的问题",
            "仍有不足",
            "关键难点",
            "技术参考来源",
            "拟拓展",
            "Word原生公式",
            "宋体",
            "Times New Roman",
            "三线表",
        ]
        missing = [phrase for phrase in required_phrases if phrase not in text]
        self.assertEqual(missing, [])

    def test_no_accidental_todo_markers(self):
        paths = [ROOT / "SKILL.md", ROOT / "README.md"] + list((ROOT / "references").glob("*.md"))
        accidental = []
        for path in paths:
            text = path.read_text(encoding="utf-8")
            for marker in ("TODO", "TBD", "implement later"):
                if marker in text:
                    accidental.append((str(path.relative_to(ROOT)), marker))
        self.assertEqual(accidental, [])


if __name__ == "__main__":
    unittest.main()
