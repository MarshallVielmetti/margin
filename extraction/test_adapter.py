import unittest
from paddle_extract import parse_pages


class FakeResult:
    json = {"res": {"width": 100, "height": 200, "parsing_res_list": [
        {"block_content": "x=1", "block_label": "formula", "block_bbox": [10, 20, 80, 40]}
    ]}}


class AdapterTest(unittest.TestCase):
    def test_yields_a_page_before_processing_the_next(self):
        processed = []

        class Pipeline:
            def predict(self, **kwargs):
                raise AssertionError("Eager PDF processing prevents page progress")

            def predict_iter(self, **kwargs):
                for i in range(2):
                    processed.append(i)
                    yield FakeResult()

        pages = parse_pages(Pipeline(), "fixture.pdf")
        first = next(pages)
        self.assertEqual(processed, [0])
        self.assertEqual(first["blocks"][0]["text"], "x=1")
        self.assertEqual(first["blocks"][0]["box"], [10, 20, 80, 40])
        next(pages)
        self.assertEqual(processed, [0, 1])


if __name__ == "__main__":
    unittest.main()
