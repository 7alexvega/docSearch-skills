# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "docling>=2.0.0",
#   "pypdf>=4.0.0",
#   "questionary>=2.0.0",
#   "rich>=13.0.0",
# ]
# ///

from __future__ import annotations

import argparse
import multiprocessing
import os
import sys
import tempfile
import threading
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import questionary
from docling.document_converter import DocumentConverter
from pypdf import PdfReader, PdfWriter
from rich.progress import BarColumn, MofNCompleteColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn


_worker_converter: DocumentConverter | None = None
_progress_queue: multiprocessing.Queue | None = None


def _worker_init(queue: multiprocessing.Queue) -> None:
    global _worker_converter, _progress_queue
    _worker_converter = DocumentConverter()
    _progress_queue = queue


def _worker_task(pdf_path: Path, output_path: Path) -> None:
    assert _worker_converter is not None

    def callback(page_num: int, total_pages: int) -> None:
        if _progress_queue is not None:
            _progress_queue.put((pdf_path.name, page_num, total_pages))

    convert_pdf(_worker_converter, pdf_path, output_path, progress_callback=callback)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert PDFs to markdown with Docling while retaining page numbers."
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=None,
        help="Directory containing source PDFs. Prompted interactively if omitted.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for markdown outputs. Prompted interactively if omitted.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing markdown files.",
    )
    parser.add_argument(
        "--pdf",
        action="append",
        default=[],
        help="Convert only a named PDF file or document stem. Can be passed multiple times.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Convert at most this many PDFs, useful for a smoke test.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help=(
            "Number of parallel worker processes. "
            f"Default: min(6, cpu_count) = {min(6, os.cpu_count() or 1)}. "
            "Set to 1 to disable multiprocessing. Prompted interactively if omitted."
        ),
    )
    return parser.parse_args()


def prompt_for_workers(cpu_count: int) -> int:
    default = min(6, cpu_count)
    answer = questionary.text(
        f"Worker processes (1–{cpu_count}, default {default}): ",
        default=str(default),
    ).ask()
    if answer is None:
        raise SystemExit(1)
    try:
        value = int(answer.strip())
    except ValueError:
        return default
    return max(1, min(value, cpu_count))


def prompt_for_directory(prompt_text: str, must_exist: bool) -> Path:
    while True:
        answer = questionary.text(prompt_text).ask()
        if answer is None:
            raise SystemExit(1)
        path = Path(answer.strip()).expanduser().resolve()
        if must_exist and not path.is_dir():
            print(f"Directory does not exist: {path}")
            continue
        return path


def markdown_for_page(converter: DocumentConverter, page_pdf: Path) -> str:
    result = converter.convert(page_pdf)
    markdown = result.document.export_to_markdown()
    return markdown.strip()


def write_single_page_pdf(reader: PdfReader, page_index: int, path: Path) -> None:
    writer = PdfWriter()
    writer.add_page(reader.pages[page_index])
    with path.open("wb") as handle:
        writer.write(handle)


def convert_pdf(
    converter: DocumentConverter,
    pdf_path: Path,
    output_path: Path,
    progress_callback: Callable[[int, int], None] | None = None,
) -> None:
    reader = PdfReader(str(pdf_path))
    total_pages = len(reader.pages)
    sections: list[str] = [
        f"# {pdf_path.stem}",
        "",
        f"Source PDF: `{pdf_path.name}`",
        "",
    ]

    with tempfile.TemporaryDirectory(prefix=f"{pdf_path.stem}-pages-") as temp_dir:
        temp_path = Path(temp_dir)
        for page_index in range(total_pages):
            page_number = page_index + 1
            page_pdf = temp_path / f"{pdf_path.stem}-page-{page_number}.pdf"
            write_single_page_pdf(reader, page_index, page_pdf)

            page_markdown = markdown_for_page(converter, page_pdf)
            sections.extend(
                [
                    f"<!-- page:{page_number} -->",
                    f"## Page {page_number}",
                    "",
                    page_markdown,
                    "",
                ]
            )

            if progress_callback is not None:
                progress_callback(page_number, total_pages)

    tmp_path = output_path.with_suffix(".md.tmp")
    tmp_path.write_text("\n".join(sections).rstrip() + "\n", encoding="utf-8")
    tmp_path.replace(output_path)


def selected_pdfs(input_dir: Path, filters: list[str], limit: int | None) -> list[Path]:
    pdfs = sorted(input_dir.glob("*.pdf"))
    if filters:
        wanted = {item if item.lower().endswith(".pdf") else f"{item}.pdf" for item in filters}
        pdfs = [pdf for pdf in pdfs if pdf.name in wanted]
    if limit is not None:
        pdfs = pdfs[:limit]
    return pdfs


def main() -> int:
    args = parse_args()
    cpu_count = os.cpu_count() or 1
    interactive = not args.input_dir or not args.output_dir

    input_dir = (
        args.input_dir.resolve()
        if args.input_dir
        else prompt_for_directory("Input directory (PDFs): ", must_exist=True)
    )
    output_dir = (
        args.output_dir.resolve()
        if args.output_dir
        else prompt_for_directory("Output directory (markdown): ", must_exist=False)
    )

    if args.workers is None:
        workers = prompt_for_workers(cpu_count) if interactive else min(6, cpu_count)
    elif args.workers > cpu_count:
        print(f"Warning: --workers {args.workers} exceeds logical CPU count ({cpu_count}), clamping to {cpu_count}.")
        workers = cpu_count
    else:
        workers = args.workers

    if not input_dir.exists():
        print(f"Input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    pdfs = selected_pdfs(input_dir, args.pdf, args.limit)
    if not pdfs:
        print(f"No PDF files found in {input_dir}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)

    work_items: list[tuple[Path, Path]] = []
    for index, pdf_path in enumerate(pdfs, start=1):
        output_path = output_dir / f"{pdf_path.stem}.md"
        if output_path.exists() and not args.force:
            print(f"[{index}/{len(pdfs)}] Skipping {output_path.name}")
            continue
        work_items.append((pdf_path, output_path))

    if not work_items:
        print(f"Done. Markdown files are in: {output_dir}")
        return 0

    n_workers = min(workers, len(work_items))

    progress_columns = (
        SpinnerColumn(),
        TextColumn("{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
    )

    if n_workers == 1:
        converter = DocumentConverter()
        with Progress(*progress_columns) as progress:
            file_task = progress.add_task("Files", total=len(work_items))
            page_task = progress.add_task("", total=1, visible=False)

            for pdf_path, output_path in work_items:
                reader = PdfReader(str(pdf_path))
                total_pages = len(reader.pages)
                progress.update(
                    page_task,
                    description=pdf_path.name,
                    completed=0,
                    total=total_pages,
                    visible=True,
                )

                def callback(page_num: int, _total: int, _t: int = page_task) -> None:
                    progress.update(_t, completed=page_num)

                convert_pdf(converter, pdf_path, output_path, progress_callback=callback)
                progress.update(file_task, advance=1)
                progress.update(page_task, visible=False)

    else:
        failed: list[tuple[Path, str]] = []
        progress_queue: multiprocessing.Queue = multiprocessing.Queue()
        file_tasks: dict[str, int] = {}

        with Progress(*progress_columns) as progress:
            overall = progress.add_task("Files", total=len(work_items))

            def drain_queue() -> None:
                while True:
                    item = progress_queue.get()
                    if item is None:
                        return
                    pdf_name, page_num, total_pages = item
                    if pdf_name not in file_tasks:
                        file_tasks[pdf_name] = progress.add_task(pdf_name, total=total_pages)
                    progress.update(file_tasks[pdf_name], completed=page_num)
                    if page_num >= total_pages:
                        progress.update(file_tasks[pdf_name], visible=False)

            reader = threading.Thread(target=drain_queue, daemon=True)
            reader.start()

            with ProcessPoolExecutor(
                max_workers=n_workers,
                initializer=_worker_init,
                initargs=(progress_queue,),
            ) as pool:
                futures = {
                    pool.submit(_worker_task, pdf_path, output_path): pdf_path
                    for pdf_path, output_path in work_items
                }
                for future in as_completed(futures):
                    pdf_path = futures[future]
                    try:
                        future.result()
                    except Exception as exc:
                        failed.append((pdf_path, str(exc)))
                    progress.update(overall, advance=1)

            progress_queue.put(None)
            reader.join()

        if failed:
            print(f"\n{len(failed)} file(s) failed to convert:")
            for path, err in failed:
                print(f"  {path.name} — {err}")
            print("\nRe-run the script to retry. Completed files will be skipped automatically.")

    print(f"Done. Markdown files are in: {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
