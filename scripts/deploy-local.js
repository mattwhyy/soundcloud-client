const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const sourceDir = path.resolve(__dirname, '..', 'build', 'win-unpacked');
const sourceExe = path.join(sourceDir, 'SoundCloud.exe');
const targetDir = path.join(os.homedir(), 'SoundCloud');

function sha256(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

if (!fs.existsSync(sourceExe)) {
    console.error('No packaged SoundCloud build found at:');
    console.error(sourceExe);
    console.error('Build the app first, then run pnpm run deploy-local.');
    process.exit(1);
}

if (process.platform === 'win32') {
    try {
        const taskList = execFileSync(
            'tasklist',
            ['/FI', 'IMAGENAME eq SoundCloud.exe', '/NH'],
            { encoding: 'utf8', windowsHide: true }
        );

        if (/SoundCloud\.exe/i.test(taskList)) {
            console.error('SoundCloud.exe is currently running.');
            console.error('Close the app first so Windows can replace its files, then run this command again.');
            process.exit(1);
        }
    } catch (error) {
        // If tasklist itself is unavailable, continue and let the copy operation
        // report any locked-file error normally.
    }
}

try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

    const sourceAsar = path.join(sourceDir, 'resources', 'app.asar');
    const targetAsar = path.join(targetDir, 'resources', 'app.asar');

    if (!fs.existsSync(sourceAsar) || !fs.existsSync(targetAsar)) {
        throw new Error('resources/app.asar is missing after deployment');
    }

    const sourceHash = sha256(sourceAsar);
    const targetHash = sha256(targetAsar);

    if (sourceHash !== targetHash) {
        throw new Error('Deployment verification failed: app.asar hashes do not match');
    }

    console.log('Updated local SoundCloud app:');
    console.log(targetDir);
    console.log('Verified resources/app.asar SHA-256:');
    console.log(targetHash);
    console.log('Note: SoundCloud.exe itself may keep the same hash/timestamp because app code lives in app.asar.');
} catch (error) {
    console.error('Failed to update the local SoundCloud app.');
    console.error('Make sure SoundCloud is closed and try again.');
    console.error(error);
    process.exit(1);
}
