# Latest-Literature Full-Text Acquisition Protocol

For each work shown in the formal **Latest Relevant Literature and Comparator Audit**, make one lawful full-text acquisition attempt before final batch packaging.

## Preferred sources

1. publisher/official open-access PDF;
2. official conference/journal PDF;
3. arXiv or recognized preprint server;
4. institutional repository;
5. matching author-accepted manuscript.

Never bypass paywalls, login, CAPTCHA, robots/access controls, or use piracy/unauthorized mirrors.

A closed publisher version still counts as successfully delivered when a lawful matching preprint/accepted manuscript exists.

## Verify downloaded files

Check:

- correct bibliographic work;
- actual PDF, not HTML/login page;
- readable/non-empty;
- title/authors/year/DOI/preprint identifier consistent.

## Acquisition status

Use:

- `downloaded_publisher_oa`
- `downloaded_preprint`
- `downloaded_repository`
- `paywalled`
- `no_public_pdf_found`
- `download_failed`
- `not_assessable`

## Unavailable CSV

If any formal audit item cannot be downloaded, create UTF-8 CSV `无法下载文献清单.csv` with:

- `No.`
- `Title`
- `Authors`
- `Year`
- `Venue/Source`
- `DOI`
- `Landing URL`
- `Access status`
- `Reason not downloaded`
- `Suggested access route`
- `Checked date`

Every formal audit work must end as either one verified PDF or one CSV row.
