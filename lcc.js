const express = require('express');
const request = require('request');
const fs = require('fs');
const {release, tmpdir} = require("os");
const { snapshot } = require("process-list");
const { spawn, exec} = require('child_process');
const { PowerShell } = require("node-powershell");
let config = {};
const {resolve, join} = require("path");
const {md5} = require("request/lib/helpers");
let state = {}

const app = express();
const port = 6799;

app.set('view engine', 'pug');
app.use('/static', express.static('./public'));

const ps = new PowerShell({
    executableOptions: {
        '-ExecutionPolicy': 'Bypass',
        '-NoProfile': true,
    },
});
const psUtility = new PowerShell({
    executableOptions: {
        '-ExecutionPolicy': 'Bypass',
        '-NoProfile': true,
    },
});
(() => {
    try {
        if (fs.existsSync('./config.json')) {
            config = JSON.parse(fs.readFileSync('./config.json').toString());
        } else {
            console.error("Config file does not exsist!")
        }
        if (fs.existsSync(config.state_file || './state.json')) {
            state = JSON.parse(fs.readFileSync(config.state_file || './state.json').toString());
        } else {
            console.error("System State file does not exsist!")
        }
    } catch (e) {
        console.error("Failed to load system state: ", e)
    }
})()

setInterval(() => {
    process.title = `ARS NOVA KONGOU Lifecycle Controller`;
}, 100);

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
        fs.writeFileSync(config.state_file || './state.json', JSON.stringify(state, undefined, 1), {
            encoding: "utf8"
        })
    } catch (e) {
        console.error("Failed to write system state: ", e)
    }
}
function getBookshelfs() {
    try {
        const bookcases = JSON.parse(fs.readFileSync(config.bookcase_file || './bookcase.json').toString());
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
        const bookcases = JSON.parse(fs.readFileSync(config.bookcase_file || './bookcase.json').toString());
        if (bookcases.shelfs && bookcases.shelfs[state.select_bookcase]) {
            let keystore_values = undefined;
            if (bookcases.shelfs[state.select_bookcase].keychain !== undefined && config.config && config.config.use_keystore) {
                const keystore = JSON.parse(fs.readFileSync(config.keystore_file || './keystore.json').toString());
                if (keystore && keystore.keychain && keystore.keychain.length > 0  && keystore.keychain[bookcases.shelfs[state.select_bookcase].keychain]) {
                    keystore_values = keystore.keychain[bookcases.shelfs[state.select_bookcase].keychain];
                }
            }
            return {
                bookcase_dir: config.bookcase_dir,
                key: state.select_bookcase,
                prepare_script: (config.scripts && config.scripts.prepare) ? ((config.scripts.prepare.includes(':\\')) ? config.scripts.prepare : join(config.system_dir, config.scripts.prepare)) : undefined,
                pre_exec_script: (config.scripts && config.scripts.pre_exec) ? ((config.scripts.pre_exec.includes(':\\')) ? config.scripts.pre_exec : join(config.system_dir, config.scripts.pre_exec)) : undefined,
                cleanup_script: (config.scripts && config.scripts.cleanup) ? ((config.scripts.cleanup.includes(':\\')) ? config.scripts.cleanup : join(config.system_dir, config.scripts.cleanup)): undefined,
                shutdown_script: (config.scripts && config.scripts.shutdown) ? ((config.scripts.shutdown.includes(':\\')) ? config.scripts.shutdown : join(config.system_dir, config.scripts.shutdown)) : undefined,
                no_dismount_vhds: bookcases.no_dismount_vhds || undefined,
                network_driver: (config.drivers && config.drivers.network) ? ((config.drivers.network.includes(':\\')) ? config.drivers.network : join(config.system_dir, config.drivers.network)) : undefined,
                network_overlay: (config.drivers && config.drivers.network_overlay) ? ((config.drivers.network_overlay.includes(':\\')) ? config.drivers.network_overlay : join(config.system_dir, config.drivers.network_overlay)) : undefined,
                network_start_script: (config.scripts && config.scripts.network_install) ? ((config.scripts.network_install.includes(':\\')) ? config.scripts.network_install : join(config.system_dir, config.scripts.network_install)) : undefined,
                network_stop_script: (config.scripts && config.scripts.network_remove) ? ((config.scripts.network_remove.includes(':\\')) ? config.scripts.network_remove : join(config.system_dir, config.scripts.network_remove)) : undefined,
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
            network_config: ((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network)) && current_bc.config && current_bc.config.network) ? ((current_bc.drivers.network_overlay.includes(':\\')) ? current_bc.drivers.network_overlay : join(config.system_dir, current_bc.drivers.network_overlay)) : ((!current_bc.no_network_config && !!(current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network))) ? (state['networking_group']) ? join(config.ramdisk_dir, "\\haruna.config.json") : "Y:\\net_config.json" : undefined),
            network_start_script: ((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network)) && current_bc.scripts && current_bc.scripts.network_install) ? ((current_bc.scripts.network_install.includes(':\\')) ? current_bc.scripts.network_install : join(config.system_dir, current_bc.scripts.network_install)) : (((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network))) ? (current_bc.network_start_script || undefined) : undefined),
            network_stop_script: ((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network)) && current_bc.scripts && current_bc.scripts.network_remove) ? ((current_bc.scripts.network_remove.includes(':\\')) ? current_bc.scripts.network_remove : join(config.system_dir, current_bc.scripts.network_remove)) : (((current_bc.network_driver || (current_bc.drivers && current_bc.drivers.network))) ? (current_bc.network_stop_script || undefined) : undefined),
            no_dismount_vhds: current_bc.no_dismount_vhds || undefined,
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
                _publish_config.asrState = resolve(join(config.preboot_dir, "\\preboot_Data\\StreamingAssets", "\\state.txt"));
                _publish_config.asrConfig = resolve(join(config.preboot_dir, "\\preboot_Data\\StreamingAssets", "\\current_config.txt"));
                _publish_config.asrErrors = resolve(join(config.preboot_dir, "\\preboot_Data\\StreamingAssets", "\\config_errors.txt"));
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
                    process.kill(p.pid);
                    console.log(`Killed process: ${p.name}`);
                } catch (e) {
                    console.error(e.message);
                }
            }))
        }
    }
}
function waitForKeychipCheckout() {
    return new Promise((resolve, reject) => {
        if (keychip_process) {
            keychip_process.on('exit', (code) => {
                console.log(`Process ${keychip_process.pid} exited with code ${code}`);
                application_armed = false;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

async function startLifecycle() {
    const prebootPath = resolve(join(config.preboot_dir, "\\preboot.exe"));
    if (!(prebootPath && fs.existsSync(prebootPath))) {
        return ["No Bootloader", false];
    } else if (preboot_process) {
        return ["Bootloader Already Running", false];
    } else {
        if (config.config && config.config.preboot && config.config.preboot.task_name) {
            exec(`schtasks /run /tn ${config.config.preboot.task_name}`, (e, stdout, stderr) => {
                if (e) {
                    console.error(e.message)
                }
            });
        } else {
            let args = [];
            if (parseInt((release()).split('.').pop()) >= 22000)
                args.push('/machine:amd64')
            args.push('/trustlevel:0x20000');
            args.push(`"${prebootPath}"`);
            preboot_process = spawn('runas', args, {
                cwd: resolve(config.preboot_dir),
                detached: true,
                stdio: 'ignore'
            });
        }
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
    if (preboot_process) {
        exec('taskkill /pid ' + preboot_process.pid + ' /T /F');
    } else {
        exec('taskkill /F /IM preboot.exe');
    }
    keychip_process = null;
    preboot_process = null;
    application_armed = false;
}
async function restartIfNeeded() {
    if (application_armed) {
        await stopLifecycle();
        return await startLifecycle();
    } else {
        return ["Not Running", true]
    }
}


app.get("/lcc/bookcase", async (req, res) => {
    const current_bc = await getCurrentBookcase();
    res.status(200).json(current_bc);
});
app.get("/lcc/bookcase/id", async (req, res) => {
    const current_bc = await getCurrentBookcase();
    res.status(200).send(current_bc.id.toString());
});
app.get("/lcc/bookcase/key", async (req, res) => {
    const current_bc = await getCurrentBookcase();
    res.status(200).send(current_bc.key.toString());
});
app.get("/lcc/bookcase/set", async (req, res) => {
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

app.get("/lcc/bookcase/mount", async (req, res) => {
    try {
        const keychipPath = resolve(join(config.system_dir, config.drivers.keychip));
        const ionaBootJsonPath = resolve(join(config.ramdisk_dir, "\\iona.boot.json"));

        // Launching the executable in a new window
        const childProcess = spawn(keychipPath, ['--env', ionaBootJsonPath, '--editMode'], {
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
app.get("/lcc/bookcase/eject", async (req, res) => {
    try {
        const keychipPath = resolve(join(config.system_dir, config.drivers.keychip));
        const ionaBootJsonPath = resolve(join(config.ramdisk_dir, "\\iona.boot.json"));

        // Launching the executable in a new window
        const childProcess = spawn(keychipPath, [keychipPath, '--env', ionaBootJsonPath, '--shutdown'], {
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

let preboot_process = null;
let keychip_process = null;
let application_armed = false;
app.get("/lce/kongou", async (req, res) => {
    const bookcase = await getCurrentBookcase();
    const current_bc = await generateIonaConfig(bookcase);
    let name = ""
    name += ((current_bc.id) ? (current_bc.id.toString() + " // ") : "")
    name += ((bookcase.name) ? bookcase.name : bookcase.id) + " // "
    name += ((current_bc.software_mode) ? "Software Key" : "Hardware Key")
    name += ((current_bc.login_key && current_bc.login_iv) ? " // Auth Hash: " + md5(current_bc.login_key + current_bc.login_iv) : "")
    name += ((current_bc.runtime_modify_option) ? " // Sys Arg: " + current_bc.runtime_modify_option : "")
    name += ((current_bc.network_driver) ? " // Haruna Global Matching" : "")

    res.status(200).send(name)
})
app.get("/lce/kongou/pull_id", async (req, res) => {
    try {
        const response = await pullBookcaseID();
        res.status((response) ? 200 : 500).send("ID returned was = " + response);
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});
app.get("/lce/kongou/init", async (req, res) => {
    try {
        const response = await startLifecycle();
        res.status((response[1]) ? 200 : 500).send(response[0]);
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});
app.get("/lce/kongou/start", async (req, res) => {
    try {
        const keychipPath = resolve(join(config.system_dir, config.drivers.keychip));
        const ionaBootJsonPath = resolve(join(config.ramdisk_dir, "\\iona.boot.json"));

        if (!(keychipPath && fs.existsSync(keychipPath))) {
            res.status(500).send("No Keychip Driver");
        } else if (!(ionaBootJsonPath && fs.existsSync(ionaBootJsonPath))) {
            res.status(500).send("No Game Configuration");
        } else if (keychip_process) {
            res.status(500).send("Keychip Already Running");
        } else {
            application_armed = true;
            keychip_process = spawn(keychipPath, ['--env', ionaBootJsonPath], {
                windowsHide: true,
                stdio: 'ignore'
            });
            res.status(200).send("Keychip Started");
        }
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});
app.get("/lce/kongou/stop", async (req, res) => {
    try {
        await stopLifecycle();
        res.status(200).send("Lifecycle Stopped");
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});
app.get("/lce/kongou/restart", async (req, res) => {
    try {
        await stopLifecycle();
        const response = await startLifecycle();
        res.status((response[1]) ? 200 : 500).send(response[0]);
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});
app.get("/lce/kongou/estop", async (req, res) => {
    try {
        killRunningApplications();
        if (keychip_process)
            exec('taskkill /pid ' + keychip_process.pid + ' /T /F');
        if (preboot_process) {
            exec('taskkill /pid ' + preboot_process.pid + ' /T /F');
        } else {
            exec('taskkill /F /IM preboot.exe');
        }
        keychip_process = null;
        preboot_process = null;
        application_armed = false;
        res.status(200).send("Lifecycle Stopped");
    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});

app.get("/lce/iona/config.json", async (req, res) => {
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
app.get("/lce/ramdisk/write/iona", async (req, res) => {
    const current_bc = await generateIonaConfig();
    if (config.ramdisk_dir && current_bc) {
        fs.writeFile(resolve(join(config.ramdisk_dir, "\\iona.boot.json")), JSON.stringify(current_bc), {
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

app.get("/lce/haruna/config.json", async (req, res) => {
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
app.get("/lce/ramdisk/write/haruna", async (req, res) => {
    const current_bc = await generateHarunaConfig();
    if (config.ramdisk_dir && current_bc) {
        fs.writeFile(resolve(join(config.ramdisk_dir, "\\haruna.config.json")), JSON.stringify(current_bc), {
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

app.listen(port, () => {

});
