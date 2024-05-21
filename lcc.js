(async () => {
    const versionNumber = "1.2"
    const yargs = require('yargs/yargs')
    const key = require('./key.json');
    const { hideBin } = require('yargs/helpers');
    const express = require('express');
    const request = require('request');
    const fs = require('fs');
    const { release, tmpdir } = require("os");
    const { snapshot } = require("process-list");
    const { spawn, exec} = require('child_process');
    const { PowerShell } = require("node-powershell");
    const terminal = require( 'terminal-kit' );
    const term = terminal.terminal;
    let config = {};
    const {resolve, join, dirname, basename} = require("path");
    const sleep = (waitTimeInMs) => new Promise(resolve => setTimeout(resolve, waitTimeInMs));
    const {md5} = require("request/lib/helpers");
    let state = {};

    const app = express();
    const uApp = express();
    const port = 6799;

    uApp.set('view engine', 'pug');
    uApp.use('/static', express.static('./public'));

    const cliArgs = yargs(hideBin(process.argv))
        .option('diskMode', {
            type: 'boolean',
            description: 'Enable Disk Mode'
        })
        .option('checkCode', {
            type: 'string',
            description: 'Last State Code'
        })
        .argv

    let statusMessage = "Ready";
    let preboot_process = null;
    let keychip_process = null;
    let application_armed = false;

    setInterval(() => {
        if (!application_armed) {
            process.title = `ARS NOVA KONGOU Lifecycle Controller [ ${statusMessage} ]`;
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

    async function catchShutdown() {
        await stopLifecycle();
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

    process.on('SIGINT', async () => {
        try {
            console.error("SIGINT");
            await catchShutdown();
        } catch (e) {
            console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to shutdown properly\x1b[0m');
            console.error(e);
        }
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        try {
            console.error("SIGTERM");
            await catchShutdown();
        } catch (e) {
            console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to shutdown properly\x1b[0m');
            console.error(e);
        }
        process.exit(0);
    });

    try {
        if (fs.existsSync((cliArgs.diskMode) ? resolve(join('Q:\\var\\lifecycle\\', 'config.json')) : './config.json')) {
            config = JSON.parse(fs.readFileSync((cliArgs.diskMode) ? resolve(join('Q:\\var\\lifecycle\\', 'config.json')) : './config.json').toString());
        } else {
            console.error("Config file does not exsist!");
            process.exit(110);
        }
        if (fs.existsSync(config.state_file || ((cliArgs.diskMode) ? resolve(join('Q:\\nvram\\', 'state.json')) : './state.json'))) {
            state = JSON.parse(fs.readFileSync(config.state_file || ((cliArgs.diskMode) ? resolve(join('Q:\\nvram\\', 'state.json')) : './state.json')).toString());
        } else {
            console.error("System State file does not exsist!");
            await saveState();
        }
    } catch (e) {
        console.error("Failed to load system state: ", e)
    }

    async function reloadConfig(req, res, next) {
        loadConfig();
        next();
    }
    async function loadConfig() {
        if (fs.existsSync((cliArgs.diskMode) ? resolve(join('Q:\\var\\lifecycle\\', 'config.json')) : './config.json')) {
            try {
                config = JSON.parse(fs.readFileSync((cliArgs.diskMode) ? resolve(join('Q:\\var\\lifecycle\\', 'config.json')) : './config.json').toString());
            } catch (e) {
                console.error("Failed to load config file", e.message)
            }
        }
    }

    async function pullBookcaseID() {
        try {
            if (config.config && config.config.mcu && (config.config.mcu.ip_address || config.config.mcu.mcu_link) && config.config.mcu.pull_id) {
                return await new Promise((ok) => {
                    request((config.config.mcu.mcu_link) ? `http://127.0.0.1:6833/mcu_link/${config.config.mcu.mcu_link_command || "game_id"}`: `http://${config.config.mcu.ip_address}/select/game_id`, {
                        timeout: 5000
                    }, async (error, response, body) => {
                        if (!error && response.statusCode === 200) {
                            const id = parseInt(body.toString());
                            if (!isNaN(id)) {
                                const bookcases = getBookshelfs();
                                if (bookcases) {
                                    const found_shelf = bookcases.filter(e => e.id && e.id.toString() === id.toString());
                                    if (found_shelf.length !== 0) {
                                        state['select_bookcase'] = found_shelf[0].key;
                                        saveState();
                                        ok(found_shelf[0].key);
                                    } else {
                                        console.error(`Returned Bookcase ID ${id} does not exist!`);
                                        ok(undefined);
                                    }
                                } else {
                                    console.error(`Unable to load bookcase library!`);
                                    ok(undefined);
                                }
                            } else {
                                console.error(`Returned Bookcase ID "${body.toString()}" is not a valid integer!`);
                                ok(undefined);
                            }
                        } else {
                            if (error)
                                console.error(error);
                            ok(undefined);
                        }
                    })
                })
            } else {
                return undefined
            }
        } catch (e) {
            console.error("Failed to read bookcases: ", e)
            return undefined;
        }
    }

    async function saveState() {
        try {
            fs.writeFileSync(config.state_file || ((cliArgs.diskMode) ? resolve(join('Q:\\nvram\\', 'state.json')) : './state.json'), JSON.stringify(state, undefined, 1), {
                encoding: "utf8"
            })
        } catch (e) {
            console.error("Failed to write system state: ", e)
        }
    }
    function getBookshelfs() {
        try {
            const bookcases = JSON.parse(fs.readFileSync(config.bookcase_file || ((cliArgs.diskMode) ? resolve(join('Q:\\nvram\\', 'bookcase.json')) : './bookcase.json')).toString());
            if (bookcases.shelfs) {
                return Object.keys(bookcases.shelfs)
                    .map(k => {
                        return {
                            key: k,
                            ...bookcases.shelfs[k]
                        }
                    })
            } else {
                return null;
            }
        } catch (e) {
            console.error("Failed to read bookcases: ", e)
            return undefined;
        }
    }
    async function getCurrentBookcase() {
        try {
            const bookcases = JSON.parse(fs.readFileSync(config.bookcase_file || ((cliArgs.diskMode) ? resolve(join('Q:\\nvram\\', 'bookcase.json')) : './bookcase.json')).toString());
            if (bookcases.shelfs && bookcases.shelfs[state.select_bookcase]) {
                let keystore_values = undefined;
                if (bookcases.shelfs[state.select_bookcase].keychain !== undefined && config.config && config.config.use_keystore) {
                    const keystore = JSON.parse(fs.readFileSync(config.keystore_file || ((cliArgs.diskMode) ? resolve(join('Q:\\nvram\\', 'keystore.json')) : './keystore.json')).toString());
                    if (keystore && keystore.keychain && keystore.keychain.length > 0  && keystore.keychain[bookcases.shelfs[state.select_bookcase].keychain]) {
                        keystore_values = keystore.keychain[bookcases.shelfs[state.select_bookcase].keychain];
                    }
                }
                const rto = await generateRuntimeOptionsConfig(bookcases.shelfs[state.select_bookcase]);
                return {
                    bookcase_dir: config.bookcase_dir,
                    key: state.select_bookcase,
                    prepare_script: (config.scripts && config.scripts.prepare) ? ((config.scripts.prepare.includes(':\\')) ? config.scripts.prepare : join(config.system_dir, config.scripts.prepare)) : undefined,
                    pre_exec_script: (config.scripts && config.scripts.pre_exec) ? ((config.scripts.pre_exec.includes(':\\')) ? config.scripts.pre_exec : join(config.system_dir, config.scripts.pre_exec)) : undefined,
                    cleanup_script: (config.scripts && config.scripts.cleanup) ? ((config.scripts.cleanup.includes(':\\')) ? config.scripts.cleanup : join(config.system_dir, config.scripts.cleanup)): undefined,
                    shutdown_script: (config.scripts && config.scripts.shutdown) ? ((config.scripts.shutdown.includes(':\\')) ? config.scripts.shutdown : join(config.system_dir, config.scripts.shutdown)) : undefined,
                    no_dismount_vhds: cliArgs.diskMode || (config.config && config.config.keychip.no_dismount_vhds) || bookcases.no_dismount_vhds || undefined,
                    network_driver: (config.drivers && config.drivers.network) ? ((config.drivers.network.includes(':\\')) ? config.drivers.network : join(config.system_dir, config.drivers.network)) : undefined,
                    network_overlay: (config.drivers && config.drivers.network_overlay) ? ((config.drivers.network_overlay.includes(':\\')) ? config.drivers.network_overlay : join(config.system_dir, config.drivers.network_overlay)) : undefined,
                    network_start_script: (config.scripts && config.scripts.network_install) ? ((config.scripts.network_install.includes(':\\')) ? config.scripts.network_install : join(config.system_dir, config.scripts.network_install)) : undefined,
                    network_stop_script: (config.scripts && config.scripts.network_remove) ? ((config.scripts.network_remove.includes(':\\')) ? config.scripts.network_remove : join(config.system_dir, config.scripts.network_remove)) : undefined,
                    patch_driver: (rto && Object.keys(rto).length > 0) ? (config.drivers && config.drivers.patcher) ? ((config.drivers.patcher.includes(':\\')) ? config.drivers.patcher : join(config.system_dir, config.drivers.patcher)) : undefined : undefined,
                    patchs_found: (rto && Object.keys(rto).length > 0),
                    keystore: keystore_values || undefined,
                    ...bookcases.shelfs[state.select_bookcase]
                }
            } else {
                return null;
            }
        } catch (e) {
            console.error("Failed to read bookcases: ", e)
            return undefined;
        }
    }

    async function generateIonaConfig(data = undefined) {
        const current_bc = (data || await getCurrentBookcase());
        if (current_bc) {
            let _publish_config = {
                lifecycle_controller: true,
                debug: state.enable_debugger || false,
                verbose: state.enable_verbose || false,
                login_key: (current_bc.keystore && current_bc.keystore.key) ? current_bc.keystore.key : (current_bc.auth && current_bc.auth.key) ? current_bc.auth.key : (current_bc.login && current_bc.login.key) ? current_bc.login.key : undefined,
                login_iv: (current_bc.keystore && current_bc.keystore.iv) ? current_bc.keystore.iv : (current_bc.auth && current_bc.auth.iv) ? current_bc.auth.iv : (current_bc.login && current_bc.login.iv) ? current_bc.login.iv : undefined,
                keychip_id: (current_bc.keystore && current_bc.keystore.keychip_id) ? current_bc.keystore.keychip_id : (current_bc.auth && current_bc.auth.keychip_id) ? current_bc.auth.keychip_id : undefined,
                board_id: (current_bc.keystore && current_bc.keystore.board_id) ? current_bc.keystore.board_id : (current_bc.auth && current_bc.auth.board_id) ? current_bc.auth.board_id : undefined,
                id: (current_bc.config && current_bc.config.id) ? current_bc.config.id.toString() : undefined,
                ini: (current_bc.config && current_bc.config.ini) ? current_bc.config.ini.toString() : (!current_bc.no_app_ini) ? "Y:\\segatools.ini" : undefined,
                app: (current_bc.books && current_bc.books.application) ? resolve(join(current_bc.bookcase_dir, `\\${current_bc.book_dir}\\${current_bc.books.application}`)) : undefined,
                appdata: (current_bc.books && current_bc.books.appdata) ? resolve(join(current_bc.bookcase_dir, `\\${current_bc.book_dir}\\${current_bc.books.appdata}`)) : undefined,
                option: (current_bc.books && current_bc.books.options) ? resolve(join(current_bc.bookcase_dir, `\\${current_bc.book_dir}\\${current_bc.books.options}`)) : undefined,
                runtime_modify: (current_bc.books && current_bc.books.overlay) ? resolve(join(current_bc.bookcase_dir, `\\${current_bc.book_dir}\\${current_bc.books.overlay}`)) : undefined,
                app_delta: (current_bc.delta && current_bc.delta.application) ? !!current_bc.delta.application : false,
                option_delta: (current_bc.delta && current_bc.delta.options) ? !!current_bc.delta.options : false,
                runtime_delta: (current_bc.delta && current_bc.delta.overlay) ? !!current_bc.delta.overlay : false,
                runtime_modify_option: (current_bc.config && current_bc.config.sys_argument) ? current_bc.config.sys_argument : undefined,
                app_script: current_bc.app_exec || undefined,
                prepare_script: (current_bc.scripts && current_bc.scripts.prepare) ? ((current_bc.scripts.prepare.includes(':\\')) ? current_bc.scripts.prepare : join(config.system_dir, current_bc.scripts.prepare)) : (current_bc.prepare_script || undefined),
                pre_exec_script: (current_bc.scripts && current_bc.scripts.pre_exec) ? ((current_bc.scripts.pre_exec.includes(':\\')) ? current_bc.scripts.pre_exec : join(config.system_dir, current_bc.scripts.pre_exec)) : (current_bc.pre_exec_script || undefined),
                cleanup_script: (current_bc.scripts && current_bc.scripts.cleanup) ? ((current_bc.scripts.cleanup.includes(':\\')) ? current_bc.scripts.cleanup : join(config.system_dir, current_bc.scripts.cleanup)) : (current_bc.cleanup_script || undefined),
                shutdown_script: (current_bc.scripts && current_bc.scripts.shutdown) ? ((current_bc.scripts.shutdown.includes(':\\')) ? current_bc.scripts.shutdown : join(config.system_dir, current_bc.scripts.shutdown)) : (current_bc.shutdown_script || undefined),
                network_driver: (current_bc.drivers && current_bc.drivers.network) ? ((current_bc.drivers.network.includes(':\\')) ? current_bc.drivers.network : join(config.system_dir, current_bc.drivers.network)) : (current_bc.network_driver || undefined),
                network_overlay: (current_bc.drivers && current_bc.drivers.network_overlay) ? ((current_bc.drivers.network_overlay.includes(':\\')) ? current_bc.drivers.network_overlay : join(config.system_dir, current_bc.drivers.network_overlay)) : (current_bc.network_overlay || undefined),
                network_config: ((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network)) && current_bc.config && current_bc.config.network) ? ((current_bc.drivers.network_overlay.includes(':\\')) ? current_bc.drivers.network_overlay : join(config.system_dir, current_bc.drivers.network_overlay)) : ((!current_bc.no_network_config && !!(current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network))) ? (state['networking_group']) ? join(((cliArgs.diskMode && !config.ramdisk_dir) ? 'Q:\\tmp\\' : config.ramdisk_dir), "\\haruna.config.json") : "Y:\\net_config.json" : undefined),
                network_start_script: ((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network)) && current_bc.scripts && current_bc.scripts.network_install) ? ((current_bc.scripts.network_install.includes(':\\')) ? current_bc.scripts.network_install : join(config.system_dir, current_bc.scripts.network_install)) : (((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network))) ? (current_bc.network_start_script || undefined) : undefined),
                network_stop_script: ((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network)) && current_bc.scripts && current_bc.scripts.network_remove) ? ((current_bc.scripts.network_remove.includes(':\\')) ? current_bc.scripts.network_remove : join(config.system_dir, current_bc.scripts.network_remove)) : (((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network))) ? (current_bc.network_stop_script || undefined) : undefined),
                patch_driver: (current_bc.patchs_found) ? (current_bc.drivers && current_bc.drivers.patcher) ? ((current_bc.drivers.patcher.includes(':\\')) ? current_bc.drivers.patcher : join(config.system_dir, current_bc.drivers.patcher)) : (current_bc.patch_driver || undefined) : undefined,
                no_dismount_vhds: current_bc.no_dismount_vhds || undefined,
                fork_exec: (current_bc.config && current_bc.config.fork_exec) ? current_bc.config.fork_exec : undefined,
                delevate_exec: (current_bc.config && current_bc.config.delevate_exec) ? current_bc.config.delevate_exec : undefined,
            }
            if (_publish_config.network_driver && (state.disable_networking || !(current_bc.config && current_bc.config.enable_network))) {
                delete _publish_config.network_driver;
                delete _publish_config.network_config;
                delete _publish_config.network_start_script;
                delete _publish_config.network_stop_script;
            }
            if (_publish_config.network_driver && (current_bc.config && current_bc.config.disable_network_overlay)) {
                delete _publish_config.network_overlay;
            }
            if (_publish_config.runtime_modify && state.disable_overlay) {
                delete _publish_config.runtime_modify;
                _publish_config.app_delta = false;
                _publish_config.option_delta = false;
                _publish_config.runtime_delta = false;
            }
            if (config.config && config.config.keychip) {
                if (config.config.keychip.software_key !== undefined) {
                    _publish_config.softwareMode = config.config.keychip.software_key;
                } else if (config.config.keychip.serial_port) {
                    _publish_config.port = config.config.keychip.serial_port;
                }
                if (config.config.keychip.asr) {
                    _publish_config.asrState = resolve(join("Q:\\proc\\", "\\state.txt"));
                    _publish_config.asrConfig = resolve(join("Q:\\proc\\", "\\current_config.txt"));
                    _publish_config.asrErrors = resolve(join("Q:\\proc\\", "\\config_errors.txt"));
                }
            }
            return _publish_config;
        } else {
            return undefined;
        }
    }
    async function generateHarunaConfig() {
        try {
            if (config.config && config.config.network) {
                const network_config = JSON.parse(fs.readFileSync(resolve((config.config.network.includes(':\\') ? config.config.network : join(config.system_dir, config.config.network)))).toString());
                let current_config = await getCurrentBookcase();
                if (!network_config.login)
                    network_config.login = {};
                if (network_config.login && state['networking_group'])
                    network_config.login.group = state['networking_group'].toUpperCase().toString();
                if (network_config.login && current_config.config && current_config.config.network_memo)
                    network_config.login.memo = current_config.config.network_memo;
                return network_config;
            } else {
                return undefined;
            }
        }catch (e) {
            console.error("Failed to read bookcases: ", e)
            return undefined;
        }
    }
    async function generateRuntimeOptionsConfig(data = undefined, raw = false) {
        try {
            const current_bc = (data || await getCurrentBookcase());
            let rtopts = {};
            if (current_bc && current_bc.config && current_bc.config.accept_options && current_bc.config.accept_options.length > 0) {
                current_bc.config.accept_options.map(e => {
                    const opts = e.toString().toLowerCase().split(':')
                    if (raw) {
                        rtopts[e.toString().toLowerCase()] = state['runtime_options'][opts[0]]
                    } else {
                        if (state['runtime_options'][opts[0]]) {
                            rtopts[opts[0]] = state['runtime_options'][opts[0]]
                            if (opts.length > 1) {
                                rtopts[opts[0] + "_" + opts[1]] = state['runtime_options'][opts[0]]
                            }
                        }
                    }
                })
            }
            if (current_bc && current_bc.config && current_bc.config.enabled_options && Object.keys(current_bc.config.enabled_options).length > 0) {
                Object.keys(current_bc.config.enabled_options).map(e => {
                    const opts = e.toString().toLowerCase().split(':')
                    if (raw) {
                        rtopts[e.toString().toLowerCase()] = current_bc.config.enabled_options[e];
                    } else {
                        rtopts[opts[0]] = current_bc.config.enabled_options[e];
                        if (opts.length > 1) {
                            rtopts[opts[0] + "_" + opts[1]] = current_bc.config.enabled_options[e]
                        }
                    }
                })
            }
            return rtopts;
        } catch (e) {
            console.error("Failed to read bookcases: ", e)
            return undefined;
        }
    }
    async function generateDownloadOrderConfig() {
        try {
            const bookcases = JSON.parse(fs.readFileSync(config.bookcase_file || ((cliArgs.diskMode) ? resolve(join('Q:\\nvram\\', 'bookcase.json')) : './bookcase.json')).toString());
            if (bookcases.bookshop && bookcases.bookshop.default) {
                return {
                    default: (bookcases.bookshop.default.url) ? bookcases.bookshop.default.url : undefined,
                    repos: (bookcases.bookshop.repos && Object.keys(bookcases.bookshop.repos).length > 0) ? bookcases.bookshop.repos : undefined
                }
            } else {
                return null;
            }
        } catch (e) {
            console.error("Failed to read bookcases: ", e)
            return undefined;
        }
    }

    async function killRunningApplications() {
        const current_bc = await getCurrentBookcase();
        if (current_bc) {
            let proc_names = []
            if (config.stop_processes)
                proc_names.push(...config.stop_processes);
            if (current_bc.stop_processes)
                proc_names.push(...current_bc.stop_processes);
            if (proc_names.length > 0) {
                const processes = await snapshot('pid', 'name');
                await Promise.all(processes.filter(p => proc_names.includes(p.name.toLowerCase())).map(p => {
                    try {
                        exec(`taskkill /F /IM ${p.name.toLowerCase()}`);
                    } catch (e) {
                        console.error(`Failed to kill ${p.name.toLowerCase()}: ${e.message}`)
                    }
                }))
            }
        }
    }
    function waitForKeychipCheckout() {
        return new Promise((resolve, reject) => {
            if (keychip_process) {
                keychip_process.on('exit', (code) => {
                    console.log(`Keychip Process ${keychip_process.pid} exited with code ${code}`);
                    application_armed = false;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    async function startLifecycle() {
        statusMessage = "Preboot";
        const prebootPath = resolve(join(config.preboot_dir, "\\preboot.exe"));
        if (!(prebootPath && fs.existsSync(prebootPath))) {
            return ["No Bootloader", false];
        } else {
            if (preboot_process) {
                exec('taskkill /F /IM preboot.exe');
            }
            let commands = [
                `Start-ScheduledTask -TaskName "TEMP_SOS_PREBOOT"`,
                "Sleep -Seconds 1"
            ]
            if (config.config && config.config.preboot && config.config.preboot.init_script)
                commands.unshift(`. "${resolve(config.config.preboot.init_script.includes(':\\') ? config.config.preboot.init_script : join(config.system_dir, config.config.preboot.init_script))}"`)
            await createTask(prebootPath, true, "preboot", resolve(config.preboot_dir));
            preboot_process = spawn("powershell.exe", [
                "-Command",
                `&{ ${commands.join('; ')} }`,
            ], {
                stdio: 'inherit' // Inherit the standard IO of the Node.js process
            });
            preboot_process.on('exit', async function () {
                await runCommand(`Unregister-ScheduledTask -TaskName "TEMP_SOS_PREBOOT" -Confirm:$false -ErrorAction SilentlyContinue`);
            })
            preboot_process.on('close', async function () {
                await runCommand(`Unregister-ScheduledTask -TaskName "TEMP_SOS_PREBOOT" -Confirm:$false -ErrorAction SilentlyContinue`);
            })
            preboot_process.on('end', async function () {
                await runCommand(`Unregister-ScheduledTask -TaskName "TEMP_SOS_PREBOOT" -Confirm:$false -ErrorAction SilentlyContinue`);
            })
            return ["Started Bootloader", true]
        }
    }
    async function stopLifecycle() {
        if (application_armed) {
            await new Promise((ok) => {
                request(`http://localhost:6789/terminate`, {
                    timeout: 15000
                },async (error, response, body) => {
                    if (!error && response.statusCode === 200)
                        console.log("Keychip Response: " + body.toString());
                    ok();
                })
            })
            await killRunningApplications();
        } else if (keychip_process !== null) {
            exec('taskkill /pid ' + keychip_process.pid + ' /T /F');
        }
        await waitForKeychipCheckout();
        if (config.drivers.keychip)
            exec('taskkill /IM ' + basename(config.drivers.keychip) + ' /F');
        if (preboot_process)
            exec('taskkill /pid ' + preboot_process.pid + ' /T /F');
        exec('taskkill /F /IM preboot.exe');
        keychip_process = null;
        preboot_process = null;
        application_armed = false;
        if (fs.existsSync(resolve(`Q:\\lib\\lifecycle\\checkout.ps1`))) {
            const unloadCmd = await runCommand(`. Q:\\lib\\lifecycle\\checkout.ps1`);
            if (!unloadCmd) {
                console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to checkout system\x1b[0m');
            }
        }
        if (config.download_order && fs.existsSync(resolve(config.download_order))) {
            const ejectCmd = await dismountCmd({
                disk: resolve(config.download_order),
                mountPoint: 'P:\\'
            })
            if (!ejectCmd) {
                console.error('\n\x1b[5m\x1b[41m\x1b[30mFailed to eject DLO disk\x1b[0m');
            }
        }
    }
    async function restartIfNeeded() {
        if (application_armed) {
            await stopLifecycle();
            return await startLifecycle();
        } else {
            return ["Not Running", true]
        }
    }
    async function createTask(exec, is_direct, task_name, workingDir) {
        return new Promise(async ok => {
            try {
                fs.copyFileSync(join(__dirname , 'JOB_SOS_APP.xml'), join(tmpdir(), 'job.xml'));
                const printCommand = PowerShell.command([
                    `Unregister-ScheduledTask -TaskName "TEMP_SOS_${task_name.toUpperCase()}" -Confirm:$false -ErrorAction SilentlyContinue; `,
                    `Register-ScheduledTask -TaskName "TEMP_SOS_${task_name.toUpperCase()}" -Xml (Get-Content -Raw -Path "${resolve(join(tmpdir(), 'job.xml'))}") -ErrorAction Stop; `,
                    ((is_direct) ? `Set-ScheduledTask -TaskName "TEMP_SOS_${task_name.toUpperCase()}" -Action (New-ScheduledTaskAction -Execute '${exec}' -WorkingDirectory "${workingDir}")` : `Set-ScheduledTask -TaskName "TEMP_SOS_${task_name.toUpperCase()}" -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Minimized -ExecutionPolicy Bypass -File ${exec} -WorkingDirectory "${workingDir}")`),
                ]);
                const result = await ps.invoke(printCommand);
                if (result.hadErrors) {
                    console.log(result.raw);
                }
                fs.unlinkSync(join(tmpdir(), 'job.xml'));
                ok(result);
            } catch (error) {
                console.error(error);
                fs.unlinkSync(join(tmpdir(), 'job.xml'));
                ok(false);
            }
        });
    }

    app.get("/lcc/bookcase", reloadConfig, async (req, res) => {
        const current_bc = await getCurrentBookcase();
        res.status(200).json(current_bc);
    });
    app.get("/lcc/bookcase/id", reloadConfig, async (req, res) => {
        const current_bc = await getCurrentBookcase();
        res.status(200).send(current_bc.id.toString());
    });
    app.get("/lcc/bookcase/key", reloadConfig, async (req, res) => {
        const current_bc = await getCurrentBookcase();
        res.status(200).send(current_bc.key.toString());
    });
    app.get("/lcc/bookcase/set", reloadConfig, async (req, res) => {
        let found_shelf = [];
        if (req.query.id) {
            const bookcases = getBookshelfs();
            if (bookcases) {
                found_shelf = bookcases.filter(e => e.id && e.id.toString() === req.query.id);
                if (found_shelf.length === 0) {
                    res.status(404).json({
                        state: false,
                        message: "Bookshelf with not found",
                    })
                }
            } else {
                res.status(500).json({
                    state: false,
                    message: "No Bookshelfs are setup",
                })
            }
        } else if (req.query.name) {
            const bookcases = getBookshelfs();
            if (bookcases) {
                found_shelf = bookcases.filter(e => e.key && e.key.toString() === req.query.name)
                if (found_shelf.length === 0) {
                    res.status(404).json({
                        state: false,
                        message: "Bookshelf with not found",
                    })
                }
            } else {
                res.status(500).json({
                    state: false,
                    message: "No Bookshelfs are setup",
                })
            }
        } else {
            res.status(500).json({
                state: false,
                message: "Missing Query",
            })
        }
        if (found_shelf.length > 0) {
            state['select_bookcase'] = found_shelf[0].key;
            saveState();
            const needed_restart = await restartIfNeeded()
            res.status(200).json({
                state: true,
                message: "Changed Bookcase",
                id: found_shelf[0].id || null,
                name: found_shelf[0].name || "Unnamed Bookself",
                lc_state: needed_restart[0]
            })
        }
    });

    app.get("/lcc/bookcase/mount", reloadConfig, async (req, res) => {
        try {
            const keychipPath = resolve(join(config.system_dir, config.drivers.keychip));

            // Launching the executable in a new window
            const childProcess = spawn(keychipPath, ['--lifecycleEnabled', '--editMode'], {
                detached: true,
                stdio: 'ignore',
                shell: true
            });

            childProcess.unref(); // Allow the parent process to exit independently
            res.status(200).send("Mounting Disks");
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lcc/bookcase/eject", reloadConfig, async (req, res) => {
        try {
            const keychipPath = resolve(join(config.system_dir, config.drivers.keychip));

            // Launching the executable in a new window
            const childProcess = spawn(keychipPath, [keychipPath, '--lifecycleEnabled', '--shutdown'], {
                detached: true,
                stdio: 'ignore',
                shell: true
            });

            childProcess.unref(); // Allow the parent process to exit independently
            res.status(200).send("Ejecting Disks");
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });

    app.get("/lcc/options/:key", (req, res) => {
        if (state['runtime_options'] && state['runtime_options'][req.params.key.toString().toLowerCase()] !== undefined) {
            res.status(200).send((state['runtime_options'][req.params.key.toString().toLowerCase()]).toString())
        } else {
            res.status(404).send("Not Found");
        }

    });
    app.get("/lcc/options/:key/:set", (req, res) => {
        if (!state['runtime_options'])
            state['runtime_options'] = {};
        if (req.params.set.toString().toLowerCase() === 'true' || req.params.set.toString().toLowerCase() === 'false') {
            state['runtime_options'][req.params.key.toString().toLowerCase()] = (req.params.set.toString().toLowerCase() === 'true');
        } else {
            state['runtime_options'][req.params.key.toString().toLowerCase()] = req.params.set.toString();
        }
        saveState();
        res.status(200).json({
            state: true,
            key: req.params.key.toString(),
            value: state['runtime_options'][req.params.key.toString().toLowerCase()],
            message: "Saved Option Setting",
        })
    });

    app.get("/lcc/network/state", (req, res) => {
        res.status(200).send((!(state['disable_networking'])).toString())
    });
    app.get("/lcc/network/state/:set", (req, res) => {
        state['disable_networking'] = (req.params.set !== "true");
        saveState();
        res.status(200).json({
            state: !(state['disable_networking']),
            message: "Saved Networking Setting",
        })
    });
    app.get("/lcc/network/group", (req, res) => {
        res.status(200).send(state['networking_group'])
    });
    app.get("/lcc/network/group/:set", (req, res) => {
        if (["A", "B", "C", "D", "E", "F"].indexOf(req.params.set.toUpperCase()) !== -1) {
            state['networking_group'] = req.params.set;
            saveState();
            res.status(200).json({
                state: state['networking_group'],
                message: "Saved Networking Group ID",
            })
        } else {
            res.status(400).json({
                state: false,
                message: "Invalid Network Group",
            })
        }
    });

    app.get("/lcc/overlay/state", (req, res) => {
        res.status(200).send((!(state['disable_overlay'])).toString())
    });
    app.get("/lcc/overlay/state/:set", (req, res) => {
        state['disable_overlay'] = (req.params.set !== "on");
        saveState();
        res.status(200).json({
            state: !(state['disable_overlay']),
            message: "Saved Overlay Setting",
        })
    });

    app.get("/lcc/debugger/state", (req, res) => {
        res.status(200).send((state['enable_debugger']).toString())
    });
    app.get("/lcc/debugger/state/:set", (req, res) => {
        state['enable_debugger'] = (req.params.set === "on");
        saveState();
        res.status(200).json({
            state: state['enable_debugger'],
            message: "Saved Debugger Setting",
        })
    });

    app.get("/lce/kongou", reloadConfig, async (req, res) => {
        const bookcase = await getCurrentBookcase();
        const current_bc = await generateIonaConfig(bookcase);
        let name = ""
        name += ((current_bc.id) ? (current_bc.id.toString() + " // ") : "")
        name += ((bookcase.name) ? bookcase.name : bookcase.id) + " // "
        name += ((current_bc.software_mode) ? "Software Key" : "Hardware Key")
        name += ((current_bc.login_key && current_bc.login_iv) ? " // Auth Hash: " + md5(current_bc.login_key + current_bc.login_iv) : "")
        name += ((current_bc.runtime_modify) ? " // RTO" : "")
        name += ((current_bc.patch_driver) ? " // RTP" : "")
        name += ((current_bc.runtime_modify_option) ? " // Sys Arg: " + current_bc.runtime_modify_option : "")
        name += ((current_bc.network_driver) ? " // Haruna Global Matching" : "")

        res.status(200).send(name)
    })
    app.get("/lce/kongou/pull_id", reloadConfig, async (req, res) => {
        try {
            const response = await pullBookcaseID();
            res.status((response) ? 200 : 500).send("ID returned was = " + response);
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lce/kongou/init", reloadConfig, async (req, res) => {
        try {
            const response = await startLifecycle();
            res.status((response[1]) ? 200 : 500).send(response[0]);
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lce/kongou/dlo", reloadConfig, async (req, res) => {
        try {
            statusMessage = "Download Order";
            if (config.download_order && fs.existsSync(resolve(config.download_order))) {
                const prepareCmd = await prepareDisk({
                    disk: resolve(config.download_order),
                    mountPoint: 'P:\\',
                    delta: false,
                    writeAccess: true
                });
                if (!prepareCmd) {
                    res.status(400).send("Download Order Failed to Initialize!");
                } else {
                    const unlockCmd = !(key && key.dlo_disk) || await unlockDisk({ mountPoint: 'P:\\' }, key.dlo_disk);
                    if (!unlockCmd) {
                        res.status(400).send("Download Order Failed to Authenticate!");
                    } else if (fs.existsSync(resolve(`Q:\\lib\\lifecycle\\download_order.ps1`))) {
                        const preloadCmd = await runCommand(`. Q:\\lib\\lifecycle\\download_order.ps1`);
                        if (!preloadCmd) {
                            res.status(400).send("Download Order Failed!");
                        } else {
                            res.status(400).send("Download Order Complete!");
                        }
                    } else {
                        res.status(200).send("Download Request Skipped");
                    }
                }
            } else {
                res.status(200).send("Download Request Skipped");
            }
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lce/kongou/start", reloadConfig, async (req, res) => {
        try {
            statusMessage = "Keychip Start";
            const keychipPath = resolve(join(config.system_dir, config.drivers.keychip));

            if (req.query && req.query.force) {
                if (keychip_process) {
                    exec('taskkill /IM ' + basename(config.drivers.keychip) + ' /F');
                }
            }
            if (!(keychipPath && fs.existsSync(keychipPath))) {
                res.status(500).send("No Keychip Driver");
            } else if (keychip_process && !(req.query && req.query.force)) {
                exec('taskkill /IM ' + basename(config.drivers.keychip) + ' /F');
            } else {
                application_armed = true;
                keychip_process = spawn(keychipPath, ['--lifecycleEnabled'], {
                    windowsHide: true,
                    stdio: 'inherit'
                });
                res.status(200).send("Keychip Started");
            }
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lce/kongou/start/update", reloadConfig, async (req, res) => {
        try {
            statusMessage = "Keychip Update";
            const keychipPath = resolve(join(config.system_dir, config.drivers.keychip));

            if (!(keychipPath && fs.existsSync(keychipPath))) {
                res.status(500).send("No Keychip Driver");
            } else if (keychip_process) {
                res.status(500).send("Keychip Already Running");
            } else {
                keychip_process = spawn(keychipPath, ['--lifecycleEnabled', '--update'], {
                    windowsHide: true,
                    stdio: 'inherit'
                });
                await waitForKeychipCheckout();
                keychip_process = null;
                res.status(200).send("Update Completed");
            }
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lce/kongou/stop", reloadConfig, async (req, res) => {
        try {
            await stopLifecycle();
            statusMessage = "Ready";
            res.status(200).send("Lifecycle Stopped");
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lce/kongou/restart", reloadConfig, async (req, res) => {
        try {
            await stopLifecycle();
            await sleep(2000);
            const response = await startLifecycle();
            res.status((response[1]) ? 200 : 500).send(response[0]);
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });
    app.get("/lce/kongou/estop", reloadConfig, async (req, res) => {
        try {
            statusMessage = "ESTOP";
            killRunningApplications();
            if (config.drivers.keychip)
                exec('taskkill /IM ' + basename(config.drivers.keychip) + ' /F');
            exec('taskkill /F /IM preboot.exe');
            keychip_process = null;
            preboot_process = null;
            application_armed = false;
            res.status(200).send("Lifecycle Stopped");
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });

    app.get("/lce/iona/config.json", reloadConfig, async (req, res) => {
        const current_bc = await generateIonaConfig();
        if (current_bc) {
            res.status(200).json(current_bc);
        } else {
            res.status(500).json({
                state: false,
                message: "Unable to retrieve configuration",
            })
        }
    });
    app.get("/lce/ramdisk/write/iona", reloadConfig, async (req, res) => {
        const current_bc = await generateIonaConfig();
        if (((cliArgs.diskMode && !config.ramdisk_dir) || config.ramdisk_dir) && current_bc) {
            fs.writeFile(resolve(join(((cliArgs.diskMode && !config.ramdisk_dir) ? 'Q:\\tmp\\' : config.ramdisk_dir), "\\iona.boot.json")), JSON.stringify(current_bc), {
                encoding: "utf8"
            }, (err) => {
                if (!err) {
                    res.status(200).json({
                        state: true,
                        message: "Iona Configuration saved to RamDisk",
                    });
                } else {
                    res.status(500).json({
                        state: false,
                        message: "Iona Configuration failed to save to RamDisk",
                        error_message: err.message
                    });
                }
            })

        } else {
            res.status(500).json({
                state: false,
                message: "Unable to retrieve or save configuration",
            })
        }
    });

    app.get("/lce/haruna/config.json", reloadConfig, async (req, res) => {
        const current_bc = await generateHarunaConfig();
        if (current_bc) {
            res.status(200).json(current_bc);
        } else {
            res.status(500).json({
                state: false,
                message: "Unable to retrieve configuration",
            })
        }
    });
    app.get("/lce/ramdisk/write/haruna", reloadConfig, async (req, res) => {
        const current_bc = await generateHarunaConfig();
        if (((cliArgs.diskMode && !config.ramdisk_dir) || config.ramdisk_dir) && current_bc) {
            fs.writeFile(resolve(join(((cliArgs.diskMode && !config.ramdisk_dir) ? 'Q:\\tmp\\' : config.ramdisk_dir), "\\haruna.config.json")), JSON.stringify(current_bc), {
                encoding: "utf8"
            }, (err) => {
                if (!err) {
                    res.status(200).json({
                        state: true,
                        message: "Haruna Configuration saved to RamDisk",
                    });
                } else {
                    res.status(500).json({
                        state: false,
                        message: "Haruna Configuration failed to save to RamDisk",
                        error_message: err.message
                    });
                }
            })

        } else {
            res.status(500).json({
                state: false,
                message: "Unable to retrieve or save configuration",
            })
        }
    });

    app.get("/lce/rtopts/config.json", reloadConfig, async (req, res) => {
        const current_bc = await generateRuntimeOptionsConfig(undefined, (req.query && req.query.raw && req.query.raw === "true"));
        if (current_bc) {
            res.status(200).json(current_bc);
        } else {
            res.status(500).json({
                state: false,
                message: "Unable to retrieve configuration",
            })
        }
    });
    app.get("/lce/ramdisk/write/rtopts", reloadConfig, async (req, res) => {
        const current_bc = await generateRuntimeOptionsConfig();
        if (((cliArgs.diskMode && !config.ramdisk_dir) || config.ramdisk_dir) && current_bc) {
            fs.writeFile(resolve(join(((cliArgs.diskMode && !config.ramdisk_dir) ? 'Q:\\tmp\\' : config.ramdisk_dir), "\\runtime_options.config.json")), JSON.stringify(current_bc), {
                encoding: "utf8"
            }, (err) => {
                if (!err) {
                    res.status(200).json({
                        state: true,
                        message: "Runtime Options Configuration saved to RamDisk",
                    });
                } else {
                    res.status(500).json({
                        state: false,
                        message: "Runtime Options failed to save to RamDisk",
                        error_message: err.message
                    });
                }
            })

        } else {
            res.status(500).json({
                state: false,
                message: "Unable to retrieve or save configuration",
            })
        }
    });

    app.get("/lce/download_order/addons.json", reloadConfig, async (req, res) => {
        const current_bc = await generateDownloadOrderConfig();
        if (current_bc) {
            res.status(200).json(current_bc);
        } else {
            res.status(500).json({
                state: false,
                message: "Unable to retrieve configuration",
            })
        }
    });

    app.get("/system/restart", reloadConfig, async (req, res) => {
        if (fs.existsSync(resolve(`Q:\\lib\\lifecycle\\update_bin.ps1`))) {
            const updateCmd = await runCommand(`. Q:\\lib\\lifecycle\\update_bin.ps1`);
            if (!updateCmd) {
                res.status(400).send("Update Failed!");
            } else {
                res.status(200).send("Update Lifecycle Controller")
            }
        } else {
            res.status(200).send("Restart Lifecycle Controller")
        }
        process.exit(0);
    })

    uApp.get("/", async (req, res) => {
        res.status(200).render('homepage', {})
    })

    app.listen(port, () => { });
    uApp.listen(8080, () => { });

    let dirtyConfig = false;
    function mainMenu() {
        const items = [ `System${(dirtyConfig) ? '(!)' : ''}`, 'Library' , 'Keystore', 'Options' , 'Crediting', 'Networking' , 'View' , 'Help' ] ;
        const options = {
            y: 1 ,	// the menu will be on the top of the terminal
            style: term.inverse ,
            selectedStyle: term.dim.black.bgBrightMagenta
        } ;

        term.clear();
        term.magenta(`Kongou Lifecycle Controller v${versionNumber}`);
        term.singleLineMenu( items , options , function( error , response ) {
            switch (response.selectedText) {
                case 'System(!)':
                case 'System':
                    systemMenu();
                    break;
                case 'Library':
                    libraryMenu();
                    break;
                case 'Keystore':
                    keystoreMenu();
                    break;
                case 'Options':
                    optionsMenu();
                    break;
                case 'Networking':
                    networkMenu();
                    break;
                case 'View':
                    viewMenu();
                    break;
                case 'Help':
                    helpMenu();
                    break;
                default:
                    mainMenu();
                    break;
            }
        });
    }
    function systemMenu() {
        const items = [
            '^^^',
            'Start Application',
            'Invoke BlueSteel LIVE',
            'Commit Changes to Disk',
            'Restart LCC',
            'Exit to System Menu',
        ] ;

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedText.split(' [')[0]) {
                case '^^^':
                    mainMenu();
                    break;
                case 'Restart LCC':
                    process.exit(10);
                    break;
                case 'Exit to System Menu':
                    process.exit(777);
                    break;
                default:
                    mainMenu();
                    break;
            }
        }) ;
    }
    async function libraryMenu() {
        const current_bc = await getCurrentBookcase();
        const items = [
            '^^^',
            `Select Active Bookcase [${(current_bc) ? current_bc.key : "NONE"}] >` ,
            'Load Bookshelf from USB',
            'Load Bookshelf from Bookstore (Download Order)',
            'Modify Bookshelf >',
            'Delete Bookshelf >',
            'Modify Bookcase Configuration File',
        ] ;

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedText.split(' [')[0]) {
                case '^^^':
                    mainMenu();
                    break;
                case 'Select Active Bookcase':
                    selectActiveBookcase();
                    break;
                default:
                    mainMenu();
                    break;
            }
        }) ;
    }
    async function selectActiveBookcase() {
        let items = [ ];
        const bookcases = getBookshelfs();
        const bookshelf_name = bookcases.map(e => '- ' + e.name)
        const bookshelf_ids = bookcases.map(e => e.id)
        items.push(...bookshelf_name);

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedText.split(' [')[0]) {
                default:
                    const selectedIndex = response.selectedIndex
                    const id = bookshelf_ids[selectedIndex];
                    const found_shelf = bookcases.filter(e => e.id && e.id.toString() === id.toString());
                    state['select_bookcase'] = found_shelf[0].key;
                    saveState();
                    dirtyConfig = true;
                    break;
            }
            mainMenu()
        }) ;
    }
    function keystoreMenu() {
        const items = [
            '^^^',
            'Load Keychip from USB',
            'Erase Keystore',
        ] ;

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedText.split(' [')[0]) {
                case '^^^':
                    mainMenu();
                    break;
                default:
                    mainMenu();
                    break;
            }
        }) ;
    }
    function networkMenu() {
        const items = [
            '^^^',
            `Global Matching [${(!(state['disable_networking'])) ? "ENABLED" : "DISABLED"}] >`,
            `Matching Group [${(state['networking_group']) ? state['networking_group'] : "UNSET"}] >`,
            `Server Settings >`,
        ] ;

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedText.split(' [')[0]) {
                case '^^^':
                    mainMenu();
                    break;
                case 'Global Matching':
                    state['disable_networking'] = !(!!state['disable_networking'])
                    saveState();
                    dirtyConfig = true;
                    mainMenu();
                    break;
                case 'Matching Group':
                    matchingGroupMenu();
                    break;
                default:
                    mainMenu();
                    break;
            }
        }) ;
    }
    function matchingGroupMenu() {
        const items = [
            `Public A`,
            `Public B`,
            `Public C`,
            `Public D`,
        ];

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedIndex) {
                case 0:
                    state['networking_group'] = "A";
                    break;
                case 1:
                    state['networking_group'] = "B";
                    break;
                case 2:
                    state['networking_group'] = "C";
                    break;
                case 3:
                    state['networking_group'] = "D";
                    break;
                default:
                    break;
            }
            dirtyConfig = true;
            saveState();
            term.red("You must update your Cabinet Group settings in game as well!\n");
            setTimeout(() => {mainMenu();}, 1500)
        }) ;
    }
    function optionsMenu() {
        const items = [
            '^^^',
            `Enabled Options >`,
            `Add/Remove Accepted Options >`,
            `Load Options from USB >`,
            `LIVE Repository Settings >`,
        ] ;

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedText.split(' [')[0]) {
                case '^^^':
                    mainMenu();
                    break;
                default:
                    mainMenu();
                    break;
            }
        }) ;
    }
    function viewMenu() {
        const items = [
            '^^^',
            `Bookcase Information`,
            `System Information`,
            `Repository Information`,
        ] ;

        term.singleColumnMenu( items , function( error , response ) {
            switch (response.selectedText.split(' [')[0]) {
                case '^^^':
                    mainMenu();
                    break;
                default:
                    mainMenu();
                    break;
            }
        }) ;
    }
    function helpMenu() {
        term.magenta("\n\nKongou Lifecycle Controller for BlueSteel 3\n\n")
        term.blue("BlueSteel Project by Yukimi Kazari (Academy City Research P.S.R.)\n");
        term.blue("Open Source Application Lifecycle and Security Platform\n");
        term.blue("Kongou - Kirishima - Iona - Haruna - Takao\n\n")
        term.white("Support can be found in the Official Missless server\n");
        term.red("Issues and Bugs should be reported to Yukimi Kazari\n");
        term.singleColumnMenu( ['Return'] , function( error , response ) {
            mainMenu();
        }) ;
    }

    await loadConfig();
    if (cliArgs.checkCode) {
        if (cliArgs.checkCode === "777") {
            mainMenu();
        } else if (config.config && config.config.auto_start) {
            startLifecycle();
        }
    } else if (config.config && config.config.auto_start) {
        startLifecycle();
    }
})()
