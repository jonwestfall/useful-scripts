# Student Work Anonymizer

A command-line Python utility for creating anonymized copies of student submissions for blind review, norming, assessment, or feedback workflows.

The script processes a directory of student work, assigns each file a dummy anonymous ID, removes likely identifying information, adds the anonymous ID to the document, and creates a private crosswalk CSV mapping anonymous IDs back to the original submissions.

> This is a practical anonymization helper, not a guarantee of perfect de-identification. Always spot-check outputs before sharing them for blind review.

---

## Features

- Processes a folder of student submissions.
- Assigns anonymous IDs such as `S0001`, `S0002`, `S0003`.
- Creates anonymized copies of supported files.
- Produces a private crosswalk CSV.
- Can infer likely student identifiers from:
  - filenames
  - document text
  - common labels such as `Name:`, `Student:`, `Author:`, and `Submitted by:`
  - document metadata
- Can optionally use a roster/list of names, emails, or student IDs to search for and redact.
- Strips common metadata from PDF, Word, and PowerPoint files.
- Flags files that may require manual review.

---

## Supported File Types

| Format | Extension | Notes |
|---|---:|---|
| PDF | `.pdf` | Uses PyMuPDF redaction for extractable text |
| Word | `.docx` | Uses `python-docx` |
| PowerPoint | `.pptx` | Uses `python-pptx` |

Legacy Office files such as `.doc` and `.ppt` are not processed directly. Convert them to `.docx` or `.pptx` first.

---

## Installation

Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install dependencies:

```bash
pip install pymupdf python-docx python-pptx
```

---

## Basic Usage

```bash
python anonymize_student_work.py ./submissions --output ./anonymized
```

This will:

1. scan `./submissions`
2. create anonymized copies in `./anonymized`
3. create a crosswalk file at:

```text
./anonymized/anonymization_crosswalk.csv
```

---

## Usage With a Roster

You can provide a roster of names, emails, or student IDs to improve redaction.

```bash
python anonymize_student_work.py ./submissions --output ./anonymized --names roster.csv
```

The roster can be either a plain text file or a CSV.

### Plain Text Roster

```text
Jane Smith
Alex Johnson
jane.smith@university.edu
```

### CSV Roster

The script recognizes common columns such as `name`, `first`, `last`, `email`, and `student_id`.

```csv
first,last,email,student_id
Jane,Smith,jane.smith@university.edu,123456
Alex,Johnson,alex.johnson@university.edu,987654
```

If no recognized columns are found, every non-empty cell is treated as a possible identifier.

---

## Dry Run

Before creating anonymized copies, you can run the script in dry-run mode:

```bash
python anonymize_student_work.py ./submissions --output ./anonymized --names roster.csv --dry-run
```

Dry-run mode creates the manifest/crosswalk but does not write anonymized files. This is useful for checking what the script would detect.

---

## Recursive Processing

To process files in nested folders:

```bash
python anonymize_student_work.py ./submissions --output ./anonymized --recursive
```

---

## Custom Anonymous IDs

By default, IDs look like this:

```text
S0001
S0002
S0003
```

You can customize the prefix, starting number, and number width.

```bash
python anonymize_student_work.py ./submissions --output ./anonymized --prefix P --start 101 --width 3
```

This would produce IDs such as:

```text
P101
P102
P103
```

---

## Output Files

For each supported input file, the script creates an anonymized copy using the anonymous ID as the filename.

Example:

```text
submissions/
  Jane Smith Research Paper.docx
  Alex Johnson Final Reflection.pdf

anonymized/
  S0001.docx
  S0002.pdf
  anonymization_crosswalk.csv
```

The crosswalk CSV includes:

| Column | Description |
|---|---|
| `anon_id` | Assigned anonymous ID |
| `source_file` | Original file path |
| `output_file` | Anonymized file path |
| `status` | Processing status |
| `source_sha256` | Hash of original file |
| `identifiers_found` | Identifiers detected in the original |
| `identifiers_removed` | Identifiers removed/replaced |
| `inferred_identifiers` | Names inferred from filename or document text |
| `metadata_identifiers` | Values found in document metadata |
| `notes` | Warnings or manual-review flags |

---

## Privacy and Security

The crosswalk file contains re-identification information. Treat it as sensitive.

Recommended practices:

- Do not commit `anonymization_crosswalk.csv` to Git.
- Store the crosswalk separately from anonymized files.
- Restrict access to the crosswalk.
- Spot-check anonymized files before sharing them.
- Keep original submissions in a protected location.
- Consider deleting intermediate output once review is complete.

A useful `.gitignore` entry:

```gitignore
# Student anonymization outputs
anonymized/
anonymized_output/
anonymization_crosswalk.csv
*crosswalk*.csv
```

---

## Important Limitations

This script reduces identifying information, but it cannot guarantee complete anonymization.

Manual review is especially important when documents contain:

- scanned PDFs
- screenshots
- images of title pages
- names embedded in charts or figures
- comments or tracked changes
- speaker notes
- embedded objects
- unusual document metadata
- references to personal experiences that identify the student
- LMS-generated filenames with hidden identifiers

### Scanned PDFs

If a PDF contains images rather than extractable text, the script cannot reliably redact names without OCR. These files are flagged in the manifest notes.

### Images Inside Documents

Names embedded in images inside Word, PowerPoint, or PDF files are not removed.

### Comments and Tracked Changes

The script attempts to flag possible comments or tracked changes in Office files, but you should manually inspect those files before sharing them.

---

## Suggested Workflow

1. Put original submissions in a dedicated folder.

   ```text
   submissions/
   ```

2. Prepare a roster if available.

   ```text
   roster.csv
   ```

3. Run a dry run.

   ```bash
   python anonymize_student_work.py ./submissions --output ./anonymized --names roster.csv --dry-run
   ```

4. Review the generated crosswalk/manifest notes.

5. Run the real anonymization.

   ```bash
   python anonymize_student_work.py ./submissions --output ./anonymized --names roster.csv
   ```

6. Spot-check the anonymized files.

7. Share only the anonymized files with reviewers.

8. Store the crosswalk securely for later re-identification.

---

## Example

```bash
python anonymize_student_work.py ~/Downloads/PSY331_Submissions \
  --output ~/Downloads/PSY331_Anonymized \
  --names ~/Downloads/PSY331_Roster.csv \
  --recursive
```

Example output:

```text
S0001: Smith_Jane_Final.docx
S0002: Johnson_Alex_Project.pdf
S0003: Lee_Morgan_Presentation.pptx

Manifest written to: /Users/jon/Downloads/PSY331_Anonymized/anonymization_crosswalk.csv
Processed: 3; dry-run: 0; skipped: 0; errors: 0
Keep the manifest private; it is the re-identification crosswalk.
```

---

## Troubleshooting

### `ModuleNotFoundError`

Install the dependencies:

```bash
pip install pymupdf python-docx python-pptx
```

### PDF output still contains a name

The name may be inside an image, scan, annotation, or unusual text layer. Manually inspect the file and consider OCR/manual redaction.

### Word or PowerPoint output still contains a name

Check for comments, tracked changes, speaker notes, images, embedded files, or unusual metadata.

### `.doc` or `.ppt` files are skipped

Convert them to `.docx` or `.pptx` first.

---

## Notes for FERPA-Sensitive Workflows

This script is intended to support privacy-conscious educational workflows, but it is not a substitute for institutional policy, FERPA guidance, IRB procedures, or professional judgment.

Before using anonymized student work for research, assessment publication, external review, or training materials, confirm that your use is permitted under applicable policies and approvals.

---

## License

Add your preferred license here.
