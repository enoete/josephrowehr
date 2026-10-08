# HR Timecards

Portal for the Joseph Rowe HR manager: upload the time clock's Timecard Report export (CSV) and get
hours, timecards, missing-punch follow-ups and punctuality reports, with Excel, CSV and print/PDF exports.

Plain PHP 8.1+. No database, no build step, nothing to install. Uploads, corrections and settings are
saved as files in `private/storage/`, outside the web folder.

## Uploads build one record

Every uploaded export joins a single record, and reports cover any date range. For each person and each
report day, one copy is kept: the one from the file whose range runs furthest past that day (it was
exported later, so it saw the whole day), then the one with more punches, then the most recent upload.
So the same file twice, overlapping files, files in any order, and a file exported mid-day followed by a
fuller one all give the same result as one complete export. `node tests/merge.js <export.csv>` checks
this. An exact repeat of a file is recognised and not stored again. Corrections belong to the person and
day, not to a file, so they survive any upload or removal.

Older installs that saved one file per pay period are converted automatically the first time the portal
loads; the old file is kept beside it with a `.migrated` ending.

## Layout

    public/                 the website (this is the document root)
      index.html            the portal
      api.php               sign-in, uploads, corrections and settings
      assets/engine.js      reads the clock export and rebuilds each working day
      assets/app.js         screens, reports and exports
      assets/vendor/        SheetJS (Apache 2.0) for Excel exports
    private/                never served to the web
      config.example.php    copy to config.php and set the password
      storage/              uploads, corrections and settings (created and filled by the portal)
    tests/check.js          node tests/check.js <export.csv> prints what the engine makes of a file
    tests/merge.js          node tests/merge.js <export.csv> checks that overlapping and repeated uploads count once

## Deploying on Plesk (hr.josephrowelaw.com)

This repository holds only the HR portal. Rowebot lives in enoete/josephrowelaw.

1. Create the subdomain `hr.josephrowelaw.com`.
2. Hosting settings: set the document root to `hr.josephrowelaw.com/public`.
3. Git: remote repository `https://<read-only token>@github.com/enoete/josephrowehr.git`, repository name `hr.git`, branch `main`, deployment directory
   `/hr.josephrowelaw.com`. Use a fine-grained GitHub token limited to this repository with read-only Contents access (a deploy key can belong to only one repository, and Plesk's key is already on Rowebot's).
4. Files: copy `private/config.example.php` to `private/config.php` and set `hr_password`.
5. Install the free Let's Encrypt certificate.
6. Open https://hr.josephrowelaw.com and sign in.

Check that https://hr.josephrowelaw.com/private/config.example.php is not found. If it opens, the
document root is wrong.

## How the clock export is read

The clock is set to start a new day in the afternoon (between 4:15 and 4:30 PM in the September 2026
export) instead of at midnight. Each morning clock-in is therefore filed under the day before, and the
clock cannot pair it with that evening's clock-out, so it reports "Missing IN" / "Missing OUT" and leaves
those hours out of its totals. It also does not pair a stretch longer than about eight hours.

The portal puts each day back together: a punch before the changeover time belongs to the next calendar
day. It then pairs each clock-in with the next clock-out on the same day. Every figure it rebuilt is
marked, and the clock's own totals are shown alongside. The changeover time is a setting; clear it if the
clock is later set to change day at midnight.

The best fix is on the clock itself: set the day change to midnight (00:00) and allow shifts longer than
eight hours.
