# cr-effort-claude-5.5 Paper in LaTeX

LaTeX version of `../paper.md` in the ACM `acmart` class, `sigconf` format, with BibTeX and the `ACM-Reference-Format` style (numeric citations, sorted by first author). This is the layout of ICSE and FSE.

`../paper.md` stays the source of truth. Make text changes there and carry them over here. Third-pass detail (full procedure, every test, per-arm tables, spend record) lives in `../supplement.md`, which the paper links to.

## Files

| File | Purpose |
|---|---|
| `main.tex` | The manuscript |
| `references.bib` | References in BibTeX form, matching the References section of `paper.md` |
| `latexmkrc` | latexmk settings: pdfLaTeX and BibTeX |
| `figures/*.pdf` | Figures 1 to 6, converted from `../artifact/figures/*.svg` |
| `figures.ts` | Converts the SVG figures to PDF |
| `check.ts` | Structural check of the class, citations, graphics, cross-references and internal IDs |

## Build

Locally, with TeX Live (which ships `acmart` and `ACM-Reference-Format.bst`):

```
latexmk main.tex
```

On Overleaf, upload this folder (or link it), set the compiler to pdfLaTeX and the main document to `main.tex`. Overleaf runs BibTeX by itself; BibTeX is fast enough for the free plan's compile timeout, so no prebuilt `.bbl` is committed.

## Preprint and Submission Modes

The class options in the first line of `main.tex` set the mode:

| Mode | Options |
|---|---|
| Preprint (current) | `sigconf,nonacm`: no ACM copyright block or conference footer |
| Double-blind submission | `sigconf,review,anonymous`: line numbers, authors hidden |
| Camera-ready | `sigconf`, plus the `\acmConference`, `\acmDOI` and rights commands ACM sends |

For a double-blind submission, also remove the repository links and the Trust My Bot name from the text, or replace them with an anonymized artifact link.

## Figures

The figures are drawn as SVG by `figures.ts`, `models-figure.ts`, `flowchart.ts` and `thinking-figure.ts` in `../artifact/analysis/`. They span both columns (`figure*` at `\textwidth`) so their 11 px labels stay readable. To regenerate the PDFs after the SVGs change, run from this folder (needs Node.js 24 and `rsvg-convert`, for example `brew install librsvg`):

```
node figures.ts
```

## Check

```
node check.ts
```

It exits 1 when:

- `main.tex` does not use `acmart` with `\bibliographystyle{ACM-Reference-Format}` and `\bibliography{references}`, or still uses a biblatex command;
- a citation key is missing from `references.bib`, or a bib entry is never cited (the numbers in `paper.md` assume every entry is cited);
- a bib entry uses a biblatex-only field such as `date` or `journaltitle`;
- an `\includegraphics` file is missing, or a `\ref` points to an undefined label;
- an internal study ID appears in the text outside a repository path or link (see `research/NAMING.md`).

It does not compile the document; the LaTeX build does.

## TODO Markers

Every `TODO(authors)` and `TODO(refs)` marker from `paper.md` is kept in bold so it shows in the PDF.
