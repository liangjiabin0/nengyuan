"""Check workbook resource bounds before a native loader allocates its tables."""

import io
import re
import zipfile
from xml.etree.ElementTree import iterparse


def check_workbook(source):
    with zipfile.ZipFile(source) as archive:
        for name in archive.namelist():
            if not re.fullmatch(r"xl/worksheets/sheet[0-9]+\.xml", name):
                continue
            data = archive.read(name)
            if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
                raise ValueError("模型 XML 不允许实体或外部文档声明")
            for _, element in iterparse(io.BytesIO(data), events=["end"]):
                tag = element.tag.rsplit("}", 1)[-1]
                if tag == "row" and int(element.attrib.get("r", "0")) > 10000:
                    raise ValueError("模型工作表行列超限，请清理超出算例范围的单元格")
                if tag == "c":
                    match = re.fullmatch(
                        r"([A-Z]+)([0-9]+)", element.attrib.get("r", "")
                    )
                    if match:
                        column = 0
                        for letter in match[1]:
                            column = column * 26 + ord(letter) - ord("A") + 1
                        if column > 500 or int(match[2]) > 10000:
                            raise ValueError(
                                "模型工作表行列超限，请清理超出算例范围的单元格"
                            )
                if tag == "f":
                    raise ValueError(
                        "算例模型不接受公式，请将已确认的参数转为数值后上传"
                    )
                element.clear()
