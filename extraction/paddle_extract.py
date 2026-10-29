"""Local PP-StructureV3 adapter. No model API or document upload is used."""
import argparse
import json
from pathlib import Path


def normalize_result(result):
    data = result.json
    if isinstance(data, str):
        data = json.loads(data)
    data = data.get("res", data)
    return {
        "width": data["width"],
        "height": data["height"],
        "blocks": [
            {"text": b.get("block_content", ""), "label": b["block_label"], "box": b["block_bbox"]}
            for b in data["parsing_res_list"]
        ],
    }


def parse_pages(pipeline, pdf):
    # predict() eagerly processes every page in PaddleOCR 3.7.
    # Iteration exposes each completed page immediately for useful progress.
    for result in pipeline.predict_iter(input=pdf):
        yield normalize_result(result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf")
    parser.add_argument("output")
    args = parser.parse_args()
    from paddleocr import PPStructureV3
    pipeline = PPStructureV3(
        device="cpu",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        use_formula_recognition=True,
    )
    pages = []
    for index, page in enumerate(parse_pages(pipeline, args.pdf)):
        pages.append(page)
        print(f"Parsed page {index + 1}", flush=True)
    Path(args.output).write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
