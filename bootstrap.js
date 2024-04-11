(async () => {
    const fs = require('fs');
    const {release, tmpdir} = require("os");
    const {resolve, join, dirname, basename} = require("path");
    const yargs = require('yargs/yargs')
    const { hideBin } = require('yargs/helpers');
    const { spawn, exec} = require('child_process');
    const { PowerShell } = require("node-powershell");
    const key = require('./key.json');

    const cliArgs = yargs(hideBin(process.argv))
        .option('snapshot', {
            type: 'boolean',
            description: 'Enable Snapshot for System Disk (Changes are reverted on shutdown)'
        })
        .option('rw', {
            type: 'boolean',
            description: 'Enable RW for System Disk'
        })
        .option('detach', {
            type: 'boolean',
            description: 'Detach Lifecycle Controller'
        })
        .argv

    process.title = `ARS NOVA KONGOU Bootstrap`;

    async function runCommand(input) {
        return new Promise(async ok => {
            try {
                const printCommand = PowerShell.command([input]);
                const result = await ps.invoke(printCommand);
                if (result.hadErrors) {
                    console.log(result.raw);
                }
                ok(result);
            } catch (error) {
                console.error(error);
                ok(false);
            }
        });
    }

    async function prepareDisk(o) {
        let diskPath = resolve(o.disk);
        // Remove any existing disk mounts
        await runCommand(`Dismount-DiskImage -ImagePath "${diskPath}" -Confirm:$false -ErrorAction SilentlyContinue`);
        if (o.delta) {
            // Generate Path for Runtime Disk Image
            const diskExt = ('.' + o.disk.toString().split('.').pop());
            const basePath = dirname(diskPath);
            const deltaName = `${basename(diskPath, diskExt)}-runtime${diskExt}`;
            const deltaPath = resolve(join(basePath, deltaName));
            // Remove Delta Disk if exists
            await runCommand(`Dismount-DiskImage -ImagePath "${deltaPath}" -Confirm:$false -ErrorAction SilentlyContinue`, true);
            // Delete Runtime Delta Disk if exists
            if (fs.existsSync(deltaPath)) {
                // Ignore Errors
                try { fs.unlinkSync(deltaPath) } catch (e) { }
            }
            // Generate Runtime Delta Disk by generating a DiskPart Script
            // The PowerShell alternative does not exist without Hyper-V
            const diskPartCommand = `create vdisk FILE="${deltaPath}" PARENT="${diskPath}\n"`
            const diskPathScript = resolve(join(tmpdir(), 'create-vhd.dat'))
            fs.writeFileSync(diskPathScript, diskPartCommand, { encoding: "ascii" });
            await runCommand(`& diskpart.exe /s "${diskPathScript}"`, true);
            // Cleanup
            try { fs.unlinkSync(diskPathScript) } catch (e) { }
            // Redirect Path when its saved
            if (fs.existsSync(deltaPath)) {
                diskPath = deltaPath;
            } else {
                console.error("Failed to create the delta disk!");
            }
        }
        // Attach the disk to the drive letter or folder
        const mountCmd = await runCommand(`Mount-DiskImage -ImagePath "${diskPath}" -StorageType VHD -NoDriveLetter -Passthru -Access ${(o.delta || o.writeAccess) ? 'ReadWrite' : 'ReadOnly'} -Confirm:$false -ErrorAction Stop | Get-Disk | Get-Partition | where { ($_ | Get-Volume) -ne $Null } | Add-PartitionAccessPath -AccessPath ${o.mountPoint} -ErrorAction Stop | Out-Null`, true);
        return (mountCmd);
    }
    async function dismountCmd(o) {
        const wasEncrypted = await runCommand(`(Get-BitLockerVolume -MountPoint "${o.mountPoint}" -ErrorAction SilentlyContinue).ProtectionStatus`)
        if (!wasEncrypted.hadErrors && wasEncrypted.raw && wasEncrypted.raw === "On" && o.lockDisk)
            await runCommand(`Lock-BitLocker -MountPoint "${o.mountPoint}" -ForceDismount -Confirm:$false -ErrorAction SilentlyContinue`, false);
        // Remove any existing disk mounts
        let diskPath = resolve(o.disk);
        if (o.delta) {
            const diskExt = ('.' + o.disk.toString().split('.').pop());
            const basePath = dirname(diskPath);
            const deltaName = `${basename(diskPath, diskExt)}-runtime${diskExt}`;
            const deltaPath = resolve(join(basePath, deltaName));
            console.log(deltaPath);
            await runCommand(`Dismount-DiskImage -ImagePath "${deltaPath}" -Confirm:$false -ErrorAction SilentlyContinue`, true);
            if (fs.existsSync(deltaPath)) {
                // Ignore Errors
                try { fs.unlinkSync(deltaPath) } catch (e) { }
            }
        }
        await runCommand(`Dismount-DiskImage -ImagePath "${diskPath}" -Confirm:$false -ErrorAction SilentlyContinue`, true);
        return true;
    }
    async function unlockDisk(o, returned_key) {
        const wasEncrypted = await runCommand(`(Get-BitLockerVolume -MountPoint "${o.mountPoint}" -ErrorAction SilentlyContinue).ProtectionStatus`)
        let unlockCmd = false;
        if (!wasEncrypted.hadErrors && wasEncrypted.raw && (wasEncrypted.raw === "On" || wasEncrypted.raw === "Unknown"))
            unlockCmd = await runCommand(`Unlock-BitLocker -MountPoint "${o.mountPoint}" -Password $(ConvertTo-SecureString -String "${returned_key}" -AsPlainText -Force) -Confirm:$false -ErrorAction Stop`, false);
        return ((wasEncrypted.raw && wasEncrypted.raw === "Off") || unlockCmd);
    }
    async function catchShutdown() {
        if (fs.existsSync(resolve(`Q:\\boot\\eject.ps1`))) {
            const unloadCmd = await runCommand(`. Q:\\boot\\eject.ps1`);
            if (!unloadCmd) {
                console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to run shutdown script in system disk\x1b[0m');
            }
        }
        const ejectCmd = await dismountCmd({
            disk: resolve('./system.vhd'),
            mountPoint: 'Q:\\',
            delta: cliArgs.snapshot,
        })
        if (!ejectCmd) {
            console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to eject system disk\x1b[0m');
            process.exit(105);
        }
    }

    const ps = new PowerShell({
        executableOptions: {
            '-ExecutionPolicy': 'Bypass',
            '-NoProfile': true,
        },
    });

    if (fs.existsSync('./system.vhd')) {
        if (fs.existsSync('./update.system.vhd')) {

        }

        const prepareCmd = await prepareDisk({
            disk: resolve('./system.vhd'),
            mountPoint: 'Q:\\',
            delta: cliArgs.snapshot,
            writeAccess: cliArgs.rw
        });
        if (!prepareCmd) {
            console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to mount system disk\x1b[0m');
            process.exit(100);
        } else {
            const unlockCmd = !(key && key.sys_disk) || await unlockDisk({ mountPoint: 'Q:\\' }, key.sys_disk);
            if (!unlockCmd) {
                console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to unlock system disk\x1b[0m');
                process.exit(101);
            } else if (fs.existsSync(resolve(`Q:\\boot\\bootloader.ps1`))) {
                const preloadCmd = await runCommand(`. Q:\\boot\\bootloader.ps1`);
                if (!preloadCmd) {
                    console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to run bootloader in system disk\x1b[0m');
                    process.exit(102);
                }
            }
        }
    } else {
        console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to load in system disk\x1b[0m');
        process.exit(99);
    }

    if (!cliArgs.detach) {
        const lcc = spawn(resolve(join("Q:\\bin", "\\savior_of_song_lifecycle.exe")), ['--diskMode'], {
            windowsHide: true,
            stdio: 'inherit'
        });
        lcc.on('exit', (code) => {
            console.log(`LCC Process ${lcc.pid} exited with code ${code}`);
            catchShutdown();
        });
    }

    process.on('SIGINT', async () => {
        try {
            await catchShutdown();
        } catch (e) {
            console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to shutdown properly\x1b[0m');
            console.error(e);
        }
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        try {
            await catchShutdown();
        } catch (e) {
            console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to shutdown properly\x1b[0m');
            console.error(e);
        }
        process.exit(0);
    });
})()
