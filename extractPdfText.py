#!/usr/bin/env python3
"""
extractPdfText.py — Extract text from a PDF using pdfplumber.
Called by parsePdf.js via child_process.

Usage:
    python3 extractPdfText.py /path/to/file.pdf

Output:
    Extracted text printed to stdout (UTF-8).
    Exits with code 1 and error message to stderr on failure.
"""

import sys
import pdfplumber


def extract_text(pdf_path):
    """Extract all text from every page of the PDF."""
    full_text = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                full_text.append(text)
    return "\n".join(full_text)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 extractPdfText.py <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]

    try:
        text = extract_text(pdf_path)
        print(text)
    except FileNotFoundError:
        print(f"Error: File not found — {pdf_path}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error extracting PDF text: {e}", file=sys.stderr)
        sys.exit(1)
