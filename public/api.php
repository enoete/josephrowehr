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

hr_migrate();
@mkdir(HR_STORAGE . '/uploads', 0750, true);
$corrFile = HR_STORAGE . '/corrections.json';

switch ($do) {
    case 'data':      // every upload, all corrections and the settings; the browser combines them
        $uploads = [];
        foreach (glob(HR_STORAGE . '/uploads/u*.json') ?: [] as $f) {
            $u = hr_read($f);
            if ($u) {
                unset($u['hash']);
                $uploads[] = $u;
            }
        }
        usort($uploads, fn ($a, $b) => strcmp($a['uploadedAt'], $b['uploadedAt']));
        hr_json(['uploads' => $uploads, 'corrections' => (object) hr_read($corrFile), 'settings' => (object) hr_read($settingsFile)]);

    case 'upload':
        $b = hr_body();
        $csv = (string) ($b['csv'] ?? '');
        $start = (string) ($b['start'] ?? '');
        $end = (string) ($b['end'] ?? '');
        if ($csv === '' || strlen($csv) > 3000000 || !str_contains($csv, 'Timecard Report')
            || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $start) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $end)) {
            hr_json(['error' => 'That file is not a Timecard Report export from the time clock, or it is too large.'], 400);
        }
        $hash = sha1(str_replace("\r\n", "\n", trim($csv)));
        $result = hr_locked(function () use ($hash, $csv, $start, $end, $b) {
            foreach (glob(HR_STORAGE . '/uploads/u*.json') ?: [] as $f) {
                $u = hr_read($f);
                if (($u['hash'] ?? '') === $hash) {
                    return ['id' => $u['id'], 'duplicate' => true];
                }
            }
            $id = 'u' . gmdate('YmdHis') . bin2hex(random_bytes(3));
            hr_write(HR_STORAGE . '/uploads/' . $id . '.json', [
                'id' => $id, 'filename' => mb_substr(basename((string) ($b['filename'] ?? 'timecard.csv')), 0, 120),
                'uploadedAt' => gmdate('c'), 'start' => $start, 'end' => $end, 'employees' => (int) ($b['employees'] ?? 0),
                'hash' => $hash, 'csv' => $csv,
            ]);
            return ['id' => $id, 'duplicate' => false];
        });
        hr_json($result);

    case 'delete':
        $b = hr_body();
        $file = hr_upload_file((string) ($b['id'] ?? ''));
        hr_locked(function () use ($file) {
            if (is_file($file)) {
                unlink($file);
            }
        });
        hr_json(['deleted' => true]);

    case 'correct':   // the punches added by hand and the note for one person on one day
        $b = hr_body();
        $key = (string) ($b['key'] ?? '');
        if (!preg_match('/^\w{1,20}\|\d{4}-\d{2}-\d{2}$/', $key)) {
            hr_json(['error' => 'Unknown day.'], 404);
        }
        $add = [];
        foreach (array_slice((array) ($b['add'] ?? []), 0, 12) as $a) {
            if (preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', (string) ($a['t'] ?? '')) && in_array($a['type'] ?? '', ['IN', 'OUT'], true)) {
                $add[] = ['t' => $a['t'], 'type' => $a['type']];
            }
        }
        $note = trim(mb_substr((string) ($b['note'] ?? ''), 0, 300));
        $all = hr_locked(function () use ($corrFile, $key, $add, $note) {
            $all = hr_read($corrFile);
            if ($add || $note !== '') {
                $all[$key] = ['add' => $add, 'note' => $note, 'at' => gmdate('c')];
            } else {
                unset($all[$key]);
            }
            hr_write($corrFile, $all);
            return $all;
        });
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
