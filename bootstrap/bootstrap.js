(async () => {
    const fs = require('fs');
    const { release, tmpdir } = require("os");
    const {resolve, join, dirname, basename} = require("path");
    const yargs = require('yargs/yargs')
    const { hideBin } = require('yargs/helpers');
    const { spawn, exec} = require('child_process');
    const { PowerShell } = require("node-powershell");
    const key = require('../key.json');
    const terminal = require( 'terminal-kit' );
    const term = terminal.terminal;

    const express = require('express');
    const app = express();
    const port = 6797;
    let lcc;
    let lastError = "";

    const bluesteel_data = 'C:\\ProgramData\\Academy City Research\\BlueSteel Project\\'
    const bluesteel_nvram = 'S:\\system_nvram.vhd'

    const cliArgs = yargs(hideBin(process.argv))
        .option('snapshot', {
            type: 'boolean',
            description: 'Enable Snapshot for System Disk (Changes are reverted on shutdown)'
        })
        .option('detach', {
            type: 'boolean',
            description: 'Detach Lifecycle Controller'
        })
        .argv

    let continueStartup = true;
    let readInput = true;

    /*await term.drawImage(join(__dirname , 'images/kongou.png'), {
        shrink: { width: term.width, height: term.height * 2 }
    })*/
    term.grabInput( { mouse: 'button' } ) ;

    term.cyan("\nBlueSteel 3\n\n");
    console.log('Press ESC to interrupt normal startup');
    term.on( 'key' , async function( name , matches , data ) {
        if (readInput && name === 'ESCAPE' ) {
            continueStartup = false;
            stopWatchingKeyboard();
            console.clear()
            console.log('Please Wait...');
            await mountVolume();
            enterMateanceMenu();
        }
    });

    function stopWatchingKeyboard() {
        clearTimeout(watchkey);
        watchkey = null;
        readInput = false;
        console.clear();
    }


    let statusMessage = "STEP 0 : Initializing...";
    let handOver = false;
    setInterval(() => {
        if (!handOver) {
            process.title = `ARS NOVA KONGOU Startup [ ${statusMessage} ]`;
        }
    }, 100);

    const ps = new PowerShell({
        executableOptions: {
            '-ExecutionPolicy': 'Bypass',
            '-NoProfile': true,
        },
    });

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
            statusMessage = "STEP 6 : Create Snapshot"
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
                lastError = 'Failed to run shutdown script in system disk';
                console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
            }
        }
        const ejectCmd = await dismountCmd({
            disk: resolve(join(bluesteel_data, '\\Kongou\\system.vhd')),
            mountPoint: 'Q:\\',
            delta: cliArgs.snapshot,
        })
        if (!ejectCmd) {
            lastError = 'Failed to eject system disk';
            console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
        }
    }

    async function mountVolume() {
        if (fs.existsSync(resolve(join(bluesteel_data, '\\Update\\system_update.ps1')))) {
            statusMessage = "STEP 3 : Apply Update"
            exec(
                `cmd.exe /c start powershell.exe -noExit -Command "& { ./system_update.ps1; Remove-Item -Force -Recurse -Confirm:$false ./*; shutdown /t 5 /r }"`,
                {
                    cwd: resolve(join(bluesteel_data, '\\Update\\'))
                });
            enterMateanceMenu()
        } else if (fs.existsSync(resolve(join(bluesteel_data, '\\Kongou\\system.vhd')))) {
            if (fs.existsSync(resolve(join(bluesteel_data, '\\Kongou\\new.system.vhd')))) {
                statusMessage = "STEP 1 : Update System Disk"
                const ejectCmd = await dismountCmd({
                    disk: resolve(join(bluesteel_data, '\\Kongou\\system.vhd')),
                    mountPoint: 'Q:\\',
                    delta: cliArgs.snapshot,
                })
                if (!ejectCmd) {
                    lastError = 'Failed to eject system disk';
                    console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
                }
                if (!!(await runCommand(`Copy-Item -Path "${resolve(join(bluesteel_data, '\\Kongou\\system.vhd'))}" -Destination "${resolve(join(bluesteel_data, '\\Kongou\\backup.system.vhd'))}" -Force -Confirm:$false`))) {
                    if (!(await runCommand(`Move-Item -Path "${resolve(join(bluesteel_data, '\\Kongou\\new.system.vhd'))}" -Destination "${resolve(join(bluesteel_data, '\\Kongou\\system.vhd'))}" -Force -Confirm:$false`))) {
                        lastError = 'Failed to update system disk';
                        console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
                    }
                } else {
                    lastError = 'Failed to backup system disk';
                    console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
                }
            }
            statusMessage = "STEP 5 : Prepare System Disk"
            const prepareCmd = await prepareDisk({
                disk: resolve(join(bluesteel_data, '\\Kongou\\system.vhd')),
                mountPoint: 'Q:\\',
                delta: cliArgs.snapshot,
                writeAccess: true
            });
            if (!prepareCmd) {
                lastError = 'Failed to mount system disk';
                console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
            } else {
                statusMessage = "STEP 7 : Authorize System Disk"
                const unlockCmd = !(key && key.sys_disk) || await unlockDisk({ mountPoint: 'Q:\\' }, key.sys_disk);
                if (!unlockCmd) {
                    lastError = 'Failed to authenticate system disk';
                    console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
                } else {
                    if (!fs.existsSync(resolve(bluesteel_nvram))) {
                        statusMessage = "STEP 8 : Erase NVRAM"
                        try {
                            const diskPartCommand = `create vdisk file="${resolve(bluesteel_nvram)}" type=expandable maximum=1024\n` +
                                'attach vdisk\n' +
                                'create partition primary\n' +
                                'format fs=ntfs quick\n' +
                                'detach vdisk\n' +
                                'exit\n'
                            const diskPathScript = resolve(join(tmpdir(), 'create-nvram.dat'))
                            fs.writeFileSync(diskPathScript, diskPartCommand, {encoding: "ascii"});
                            await runCommand(`& diskpart.exe /s "${diskPathScript}"`, true);
                            // Cleanup
                            try { fs.unlinkSync(diskPathScript) } catch (e) { }
                        } catch (e) {
                            lastError = 'Failed to erase NVRAM';
                            console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
                        }
                    }
                    statusMessage = "STEP 8 : Prepare NVRAM"
                    await dismountCmd({
                        disk: resolve(bluesteel_nvram),
                        mountPoint: 'Q:\\nvram\\'
                    })
                    try {
                        await runCommand(`Remove-Item -Path "Q:\\nvram\\"`, true);
                        await runCommand(`New-Item -ItemType Directory -Path "Q:\\nvram\\"`, true);
                    } catch (e) { }
                    const prepareNVRAM = await prepareDisk({
                        disk: resolve(bluesteel_nvram),
                        mountPoint: 'Q:\\nvram\\',
                        writeAccess: true
                    });
                    if (!prepareNVRAM) {
                        lastError = 'Failed to mount NVRAM';
                        console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
                    } else {
                        if (fs.existsSync(resolve(`Q:\\boot\\bootloader.ps1`))) {
                            statusMessage = "STEP 9 : Bootloader"
                            const preloadCmd = await runCommand(`. Q:\\boot\\bootloader.ps1 "${key.update_password}"`);
                            if (!preloadCmd) {
                                lastError = 'Failed to run bootloader in system disk';
                                console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
                            }
                        }
                    }
                }

            }
        } else {
            lastError = 'Missing System Disk Image';
            console.error(`n\x1b[5m\x1b[41m\x1b[30m${lastError}\x1b[0m`);
        }
    }

    async function startLCC(checkCode, enterMenu) {
        statusMessage = "STEP 10 : Controller Start"
        if (fs.existsSync(resolve(join("Q:\\bin", "\\savior_of_song_lifecycle.exe")))) {
            handOver = true
            term.grabInput(false);
            lcc = spawn(resolve(join("Q:\\bin", "\\savior_of_song_lifecycle.exe")), ['--diskMode', "--checkCode", checkCode], {
                windowsHide: true,
                stdio: 'inherit'
            });
            lcc.on('exit', async (code) => {
                handOver = false;
                if (code && code !== 0) {
                    statusMessage = "STEP 20 : Controller Restart"
                    await catchShutdown();
                    await mountVolume();
                    if (code === 777) {
                        enterMateanceMenu()
                    } else {
                        startLCC(code);
                    }
                } else {
                    statusMessage = "STEP 14 : Controller Death"
                    console.log(`LCC Process ${lcc.pid} exited with code ${code}`);
                    await catchShutdown();
                }
            });
        } else {
            lastError = "No Lifecycle Controller Present"
            enterMateanceMenu();
        }
    }

    async function enterMateanceMenu() {
        statusMessage = 'System Menu'
        continueStartup = false;

        console.clear();
        term.red( 'System Menu\n' ) ;
        if (lastError !== "")
            term.yellow( `Last Error: ${lastError}` ) ;
        console.log("\n");

        const items = [
            'Lifecycle Configuration',
            'Install Platform Update from USB',
            'Format System',
            'Restart System',
            'System Configuration',
            'Exit',
            'Terminate (Developer Mode)'
        ] ;

        term.singleColumnMenu(items , async function(error , response) {
            console.clear();
            switch (response.selectedText) {
                case "System Configuration":
                    toolsMenu();
                    break;
                 case "Terminate (Developer Mode)":
                    process.exit(0);
                    break;
                case "Exit":
                    if (fs.existsSync(resolve(join("Q:\\bin", "\\savior_of_song_lifecycle.exe"))) && !cliArgs.detach) {
                        startLCC(0);
                    } else {
                        lastError = "No Lifecycle Controller or System Disk Present";
                        enterMateanceMenu();
                    }
                    break;
                case "Restart System":
                    await runCommand(`shutdown /r /t 0`);
                    break;
                case "Lifecycle Configuration":
                    console.clear();
                    term.yellow('Please Wait...');
                    startLCC(777);
                    break;
                default:
                    enterMateanceMenu();
                    break;
            }
        });
    }
    async function toolsMenu() {
        statusMessage = 'System Configuration'
        continueStartup = false;

        console.clear();
        term.yellow( 'System Configuration\n\n' );

        const fileNames = fs.readdirSync(resolve(join(bluesteel_data, '\\Kongou\\Shortcuts\\'))).filter(e => e.endsWith('.lnk'))
        const items = [
            ...fileNames.map(e => e.split('.')[0]),
            'Return'
        ] ;

        term.singleColumnMenu(items , async function(error , response) {
            console.clear();
            switch (response.selectedText) {
                case "Return":
                    enterMateanceMenu();
                    break;
                default:
                    await runCommand(`Invoke-Item "${resolve(join(bluesteel_data, '\\Kongou\\Shortcuts\\', (fileNames[response.selectedIndex])))}"`);
                    toolsMenu();
                    break;
            }
        });
    }
    async function applyUSBUpdate() {
        statusMessage = "Apply Update"
        console.clear();

    }

    app.get('/reload/controller', (req, res) => {

    })

    app.get('/disk/commit', (req, res) => {

})

    app.listen(port, () => { });

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


    let watchkey = setTimeout(async () => {
        stopWatchingKeyboard();
        await mountVolume();
        if (fs.existsSync(resolve(join("Q:\\bin", "\\savior_of_song_lifecycle.exe"))) && !cliArgs.detach && continueStartup) {
            startLCC(0);
        } else {
            enterMateanceMenu();
        }
    }, 5000);
})()
