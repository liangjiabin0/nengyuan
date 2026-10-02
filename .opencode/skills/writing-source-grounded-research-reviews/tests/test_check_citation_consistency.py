import unittest

from scripts.check_citation_consistency import analyze_citations, expand_citation_content


class CitationConsistencyTests(unittest.TestCase):
    def test_expand_ranges_and_groups(self):
        self.assertEqual(expand_citation_content("1,3-5，8"), [1, 3, 4, 5, 8])

    def test_report_missing_unused_and_sequence(self):
        text = (
            "正文结论[1,3-4]，另一结论[4]。\n"
            "参考文献\n"
            "[1] 张三. A[J]. 期刊, 2024.\n"
            "[2] 李四. B[J]. 期刊, 2023.\n"
            "[4] 王五. D[J]. 期刊, 2022."
        )
        report = analyze_citations(text)
        self.assertEqual(report["cited_numbers"], [1, 3, 4])
        self.assertEqual(report["missing_reference_numbers"], [3])
        self.assertEqual(report["unused_reference_numbers"], [2])
        self.assertEqual(report["non_sequential_reference_numbers"], [3])

    def test_uses_last_reference_heading_after_table_of_contents(self):
        text = (
            "目录\n参考文献\n1 正文\n正文结论[1]。\n"
            "参考文献\n[1] 张三. A[J]. 期刊, 2024."
        )
        report = analyze_citations(text)
        self.assertEqual(report["cited_numbers"], [1])
        self.assertEqual(report["reference_numbers"], [1])
        self.assertTrue(report["ok"])

    def test_duplicate_reference_numbers(self):
        text = (
            "正文[1]。\n参考文献\n"
            "[1] 张三. A[J]. 期刊, 2024.\n"
            "[1] 李四. B[J]. 期刊, 2023."
        )
        report = analyze_citations(text)
        self.assertEqual(report["duplicate_reference_numbers"], [1])


if __name__ == "__main__":
    unittest.main()
