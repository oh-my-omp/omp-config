---
tool: read
name: documents
title: Documents, PDFs and notebooks
when: before reading a PDF, Word, PowerPoint, Excel, EPUB or Jupyter notebook
upstream: pi-coding-agent@19.1.1 src/utils/markit.ts, src/tools/read-pdf.ts, src/tools/read.ts, omp://tools/read.md § Documents, § Jupyter notebooks
inject:
  - id: read-documents
    tool: read
    parameter: path
    pattern: '\.(pdf|docx|pptx|xlsx|epub|ipynb)(:|\?|$)'
---
# Documents, PDFs and notebooks

- `.pdf .docx .pptx .xlsx .epub` are converted to Markdown; selectors (`:1-80`, `:-40`, `:raw`) apply to the converted text. Legacy `.doc .ppt .xls .rtf` have no converter and read as binary. ZIP-container documents (`.docx .xlsx .pptx .epub`) also support `:member/path` archive reads (`help://read/archives`).
- A failed conversion returns `[Cannot read .ext file: …]`.
- A PDF page as an image: `doc.pdf:page11.png` (also `:p11-img0.png`, `:page-11.png`) renders the page via headless Chromium (`874x874` viewport, 30 s timeout — not embedded-image extraction); add `?q=<question>` to ask a vision model about it. Scanned PDFs without extractable text list their pages with `:page<N>.png` hints. Works for local filesystem files and archive members, not web URLs or `local://` PDFs.
- `.ipynb` reads as editable cell text with `# %% [code] cell:0` markers; `:raw` returns the notebook JSON.
