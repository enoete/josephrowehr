<?php
// Shared setup for the API: configuration, session, storage and small helpers.
declare(strict_types=1);

const HR_PRIVATE = __DIR__;
const HR_STORAGE = __DIR__ . '/storage';

function hr_config(): array
{
    static $cfg = null;
    if ($cfg !== null) {
        return $cfg;
    }
    $defaults = ['hr_password' => '', 'session_minutes' => 240];
    $file = HR_PRIVATE . '/config.php';
    $cfg = is_file($file) ? array_merge($defaults, (array) require $file) : $defaults;
    return $cfg;
}

function hr_json(array $body, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function hr_is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}

function hr_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('jrhr');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => hr_is_https(), 'httponly' => true, 'samesite' => 'Strict']);
    session_start();
    $limit = (int) hr_config()['session_minutes'] * 60;
    if (!empty($_SESSION['auth']) && time() - (int) ($_SESSION['seen'] ?? 0) > $limit) {
        $_SESSION = [];
    }
    if (!empty($_SESSION['auth'])) {
        $_SESSION['seen'] = time();
    }
}

function hr_signed_in(): bool
{
    hr_session();
    return !empty($_SESSION['auth']);
}

function hr_body(): array
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        hr_json(['error' => 'Use POST.'], 405);
    }
    // Requests must come from this site's own pages.
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== strtok($_SERVER['HTTP_HOST'] ?? '', ':')) {
        hr_json(['error' => 'Request refused.'], 403);
    }
    $body = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($body) ? $body : [];
}

// Counts failed sign-ins per visitor address so the password cannot be guessed by brute force.
function hr_throttle(string $action): bool
{
    $file = sys_get_temp_dir() . '/jrhr_login_' . hash('sha256', $_SERVER['REMOTE_ADDR'] ?? 'unknown') . '.json';
    $now = time();
    $hits = is_file($file) ? (json_decode((string) file_get_contents($file), true) ?: []) : [];
    $hits = array_values(array_filter($hits, fn ($t) => $now - $t < 900));
    if ($action === 'fail') {
        $hits[] = $now;
        file_put_contents($file, json_encode($hits), LOCK_EX);
    } elseif ($action === 'clear') {
        @unlink($file);
        return true;
    }
    return count($hits) < 8;
}

function hr_storage_ready(): bool
{
    if (!is_dir(HR_STORAGE)) {
        @mkdir(HR_STORAGE, 0750, true);
    }
    return is_dir(HR_STORAGE) && is_writable(HR_STORAGE);
}

function hr_upload_file(string $id): string
{
    if (!preg_match('/^u\d{14}[a-f0-9]{6}$/', $id)) {
        hr_json(['error' => 'Unknown upload.'], 404);
    }
    return HR_STORAGE . '/uploads/' . $id . '.json';
}

// Runs $fn while holding an exclusive lock, so two saves at the same moment cannot overwrite each other.
function hr_locked(callable $fn)
{
    $h = fopen(HR_STORAGE . '/.lock', 'c');
    flock($h, LOCK_EX);
    try {
        return $fn();
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
}

// Earlier versions kept one file per pay period. Move those into the single upload history, once.
function hr_migrate(): void
{
    $old = glob(HR_STORAGE . '/period-*.json') ?: [];
    if (!$old) {
        return;
    }
    hr_locked(function () use ($old) {
        @mkdir(HR_STORAGE . '/uploads', 0750, true);
        $corrFile = HR_STORAGE . '/corrections.json';
        $corr = hr_read($corrFile);
        foreach ($old as $f) {
            $p = hr_read($f);
            if (!$p || empty($p['csv'])) {
                continue;
            }
            $id = 'u' . gmdate('YmdHis', strtotime($p['uploadedAt'] ?? 'now') ?: time()) . bin2hex(random_bytes(3));
            hr_write(HR_STORAGE . '/uploads/' . $id . '.json', [
                'id' => $id, 'filename' => $p['filename'] ?? 'timecard.csv', 'uploadedAt' => $p['uploadedAt'] ?? gmdate('c'),
                'start' => $p['start'], 'end' => $p['end'], 'employees' => $p['employees'] ?? 0,
                'hash' => sha1(str_replace("\r\n", "\n", trim((string) $p['csv']))), 'csv' => $p['csv'],
            ]);
            foreach ((array) ($p['corrections'] ?? []) as $k => $v) {
                $corr[$k] = $v;
            }
            rename($f, $f . '.migrated');
        }
        hr_write($corrFile, $corr);
    });
}

function hr_read(string $file, array $fallback = []): array
{
    if (!is_file($file)) {
        return $fallback;
    }
    $data = json_decode((string) file_get_contents($file), true);
    return is_array($data) ? $data : $fallback;
}

function hr_write(string $file, array $data): void
{
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX) === false || !rename($tmp, $file)) {
        @unlink($tmp);
        hr_json(['error' => 'The server could not save the file. Check that the storage folder is writable.'], 500);
    }
}
