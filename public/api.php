<?php
// One endpoint for the whole portal: api.php?do=<action>
require __DIR__ . '/../private/bootstrap.php';

$do = $_GET['do'] ?? '';
$cfg = hr_config();

if ($do === 'me') {
    hr_json(['signedIn' => hr_signed_in(), 'ready' => $cfg['hr_password'] !== '', 'storage' => hr_storage_ready()]);
}

if ($do === 'login') {
    $body = hr_body();
    $stored = (string) $cfg['hr_password'];
    if ($stored === '') {
        hr_json(['error' => 'Sign-in has not been set up yet. Ask your administrator to finish the configuration.'], 503);
    }
    if (!hr_throttle('check')) {
        hr_json(['error' => 'Too many attempts. Wait 15 minutes and try again.'], 429);
    }
    $given = (string) ($body['password'] ?? '');
    $isHash = (password_get_info($stored)['algo'] ?? null) !== null;
    if ($given === '' || !($isHash ? password_verify($given, $stored) : hash_equals($stored, $given))) {
        hr_throttle('fail');
        usleep(600000);
        hr_json(['error' => 'That password is not correct.'], 401);
    }
    hr_throttle('clear');
    hr_session();
    session_regenerate_id(true);
    $_SESSION['auth'] = true;
    $_SESSION['seen'] = time();
    hr_json(['signedIn' => true]);
}

if ($do === 'logout') {
    hr_body();
    hr_session();
    $_SESSION = [];
    session_destroy();
    hr_json(['signedIn' => false]);
}

// Everything below needs a signed-in session.
if (!hr_signed_in()) {
    hr_json(['error' => 'Please sign in.'], 401);
}
session_write_close();
if (!hr_storage_ready()) {
    hr_json(['error' => 'The storage folder is missing or not writable. Ask your administrator to check private/storage.'], 500);
}
$settingsFile = HR_STORAGE . '/settings.json';

switch ($do) {
    case 'periods':   // list of uploaded pay periods, newest first, plus saved settings
        $list = [];
        foreach (glob(HR_STORAGE . '/period-*.json') ?: [] as $f) {
            $p = hr_read($f);
            if ($p) {
                $list[] = ['id' => $p['id'], 'start' => $p['start'], 'end' => $p['end'], 'filename' => $p['filename'],
                    'uploadedAt' => $p['uploadedAt'], 'employees' => $p['employees'] ?? null];
            }
        }
        usort($list, fn ($a, $b) => strcmp($b['start'], $a['start']));
        hr_json(['periods' => $list, 'settings' => hr_read($settingsFile)]);

    case 'period':    // one pay period: the export as uploaded and any corrections
        hr_json(hr_read(hr_period_file((string) ($_GET['id'] ?? '')), ['error' => 'Unknown pay period.']));

    case 'upload':
        $b = hr_body();
        $csv = (string) ($b['csv'] ?? '');
        $start = (string) ($b['start'] ?? '');
        $end = (string) ($b['end'] ?? '');
        if ($csv === '' || strlen($csv) > 3000000 || !str_contains($csv, 'Timecard Report')
            || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $start) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $end)) {
            hr_json(['error' => 'That file is not a Timecard Report export, or it is too large.'], 400);
        }
        $id = str_replace('-', '', $start) . '-' . str_replace('-', '', $end);
        $file = hr_period_file($id);
        $existing = hr_read($file);
        if ($existing && empty($b['replace'])) {
            hr_json(['error' => 'exists', 'id' => $id], 409);
        }
        hr_write($file, [
            'id' => $id, 'start' => $start, 'end' => $end,
            'filename' => mb_substr(basename((string) ($b['filename'] ?? 'timecard.csv')), 0, 120),
            'uploadedAt' => gmdate('c'), 'employees' => (int) ($b['employees'] ?? 0), 'csv' => $csv,
            // Corrections are kept when the same period is uploaded again unless the caller asks to drop them.
            'corrections' => !empty($b['keepCorrections']) && $existing ? ($existing['corrections'] ?? []) : [],
        ]);
        hr_json(['id' => $id]);

    case 'delete':
        $b = hr_body();
        $file = hr_period_file((string) ($b['id'] ?? ''));
        if (is_file($file)) {
            unlink($file);
        }
        hr_json(['deleted' => true]);

    case 'correct':   // save the manual punches and note for one person on one day
        $b = hr_body();
        $file = hr_period_file((string) ($b['id'] ?? ''));
        $p = hr_read($file);
        $key = (string) ($b['key'] ?? '');
        if (!$p || !preg_match('/^\w{1,20}\|\d{4}-\d{2}-\d{2}$/', $key)) {
            hr_json(['error' => 'Unknown pay period or day.'], 404);
        }
        $add = [];
        foreach (array_slice((array) ($b['add'] ?? []), 0, 12) as $a) {
            if (preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', (string) ($a['t'] ?? '')) && in_array($a['type'] ?? '', ['IN', 'OUT'], true)) {
                $add[] = ['t' => $a['t'], 'type' => $a['type']];
            }
        }
        $note = trim(mb_substr((string) ($b['note'] ?? ''), 0, 300));
        $all = (array) ($p['corrections'] ?? []);
        if ($add || $note !== '') {
            $all[$key] = ['add' => $add, 'note' => $note, 'at' => gmdate('c')];
        } else {
            unset($all[$key]);
        }
        $p['corrections'] = $all;
        hr_write($file, $p);
        hr_json(['corrections' => (object) $all]);

    case 'settings':
        $b = hr_body();
        $time = fn ($v, $d) => preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', (string) $v) ? (string) $v : $d;
        $s = [
            'cutoff' => ($b['cutoff'] ?? '') === '' ? '' : $time($b['cutoff'], '16:30'),
            'workStart' => $time($b['workStart'] ?? '', '08:30'),
            'workEnd' => $time($b['workEnd'] ?? '', '16:30'),
            'graceMin' => max(0, min(120, (int) ($b['graceMin'] ?? 10))),
            'lunchMin' => max(0, min(180, (int) ($b['lunchMin'] ?? 0))),
            'assumeSameLabel' => !empty($b['assumeSameLabel']),
            'holidays' => array_values(array_unique(array_filter(array_map('strval', (array) ($b['holidays'] ?? [])),
                fn ($d) => (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)))),
        ];
        hr_write($settingsFile, $s);
        hr_json(['settings' => $s]);
}
hr_json(['error' => 'Unknown request.'], 404);
