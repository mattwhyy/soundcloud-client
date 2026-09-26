const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sourceDir = path.resolve(__dirname, '..', 'build', 'win-unpacked');
const sourceExe = path.join(sourceDir, 'SoundCloud.exe');
const targetDir = path.join(os.homedir(), 'SoundCloud');

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

    console.log('Updated local SoundCloud app:');
    console.log(targetDir);
} catch (error) {
    console.error('Failed to update the local SoundCloud app.');
    console.error('Make sure SoundCloud is closed and try again.');
    console.error(error);
    process.exit(1);
}
