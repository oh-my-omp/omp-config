---
tool: read
name: documents
title: Documents, PDFs and notebooks
when: before reading a PDF, Word, PowerPoint, Excel, EPUB or Jupyter notebook
upstream: pi-coding-agent@18.13.2 src/utils/markit.ts, src/tools/read-pdf.ts, src/tools/read.ts, omp://tools/read.md § Documents, § Jupyter notebooks
---
# Documents, PDFs and notebooks

- `.pdf .docx .pptx .xlsx .epub` are converted to Markdown; selectors (`:1-80`, `:-40`, `:raw`) apply to the converted text. Legacy `.doc .ppt .xls .rtf` have no converter and read as binary.
- A failed conversion returns `[Cannot read .ext file: …]`.
- A PDF page as an image: `doc.pdf:page11.png` (also `:p11-img0.png`, `:page-11.png`); add `?q=<question>` to ask a vision model about it. Scanned PDFs without extractable text list their pages with page-image hints. Works for local files and archive members, not web or `local://` PDFs.
- `.ipynb` reads as editable cell text with `# %% [code] cell:0` markers; `:raw` returns the notebook JSON.
