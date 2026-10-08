<?php
// Copy this file to config.php (same folder) and fill in the password.
// config.php is never committed to Git and must stay outside the public web folder.
return [
    // Sign-in password for the HR manager. Either a plain password or a hash made with PHP's password_hash().
    'hr_password' => '',

    // Longest a signed-in session lasts without activity, in minutes.
    'session_minutes' => 240,
];
