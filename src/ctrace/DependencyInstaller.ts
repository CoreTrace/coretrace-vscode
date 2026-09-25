import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { isWslAvailable } from './CommandBuilder';

export interface DependencyStatus {
    allInstalled: boolean;
    missing: string[];
    details: {
        cppcheck: boolean;
        cppcheckHomebrew: boolean;
        cppcheckSarif: boolean;
        flawfinder: boolean;
        ikos: boolean;
        tscancode: boolean;
    };
}

/**
 * Executes a shell command inside WSL (on Windows) or natively (on Linux/macOS).
 */
export function execShellCommand(
    cmd: string,
    options: { asRoot?: boolean; distro?: string | null; onData?: (chunk: string) => void } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        let processName = 'sh';
        let processArgs: string[] = ['-c', cmd];

        if (process.platform === 'win32') {
            processName = 'wsl';
            const prefixArgs: string[] = [];
            if (options.distro) {
                prefixArgs.push('-d', options.distro);
            }
            if (options.asRoot) {
                prefixArgs.push('-u', 'root');
            }
            // wsl.exe rewrites arguments passed to `sh -c`, expanding shell
            // variables before the script runs. Feed the script through stdin.
            processArgs = [...prefixArgs, '--exec', 'sh', '-s'];
        } else if (options.asRoot) {
            processName = 'sudo';
            processArgs = ['sh', '-c', cmd];
        }

        const child = cp.spawn(processName, processArgs);
        if (process.platform === 'win32') {
            child.stdin?.on('error', () => { /* WSL may exit before consuming stdin */ });
            child.stdin?.end(cmd);
        }
        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => {
            const str = data.toString();
            stdout += str;
            options.onData?.(str);
        });

        child.stderr?.on('data', (data) => {
            const str = data.toString();
            stderr += str;
            options.onData?.(str);
        });

        child.on('close', (code) => {
            resolve({ stdout, stderr, code: code ?? 0 });
        });

        child.on('error', (err) => {
            stderr += err.message;
            resolve({ stdout, stderr, code: 1 });
        });
    });
}

/**
 * Checks which dependencies are present and properly configured.
 */
export async function checkDependencies(distro?: string | null): Promise<DependencyStatus> {
    if (process.platform === 'win32' && !isWslAvailable()) {
        return {
            allInstalled: false,
            missing: ['wsl', 'cppcheck', 'flawfinder', 'ikos', 'tscancode'],
            details: {
                cppcheck: false,
                cppcheckHomebrew: false,
                cppcheckSarif: false,
                flawfinder: false,
                ikos: false,
                tscancode: false,
            },
        };
    }

    const checkScript = `
        has_cmd() { command -v "$1" >/dev/null 2>&1; }
        has_file() { [ -f "$1" ] || [ -L "$1" ]; }

        CPPCHECK_SYS=0
        CPPCHECK_BREW=0
        CPPCHECK_SARIF=0
        FLAWFINDER_OK=0
        IKOS_OK=0
        TSCANCODE_OK=0

        if has_cmd cppcheck; then CPPCHECK_SYS=1; fi
        if has_file /opt/homebrew/bin/cppcheck; then
            CPPCHECK_BREW=1
            if /opt/homebrew/bin/cppcheck --output-format=sarif --version >/dev/null 2>&1; then
                CPPCHECK_SARIF=1
            fi
        fi

        if has_file "$HOME/.coretrace/tools/flawfinder/src/flawfinder-build/flawfinder.py" || has_cmd flawfinder; then
            FLAWFINDER_OK=1
        fi

        if has_file "$HOME/.coretrace/tools/ikos/src/ikos-build/bin/ikos" || has_cmd ikos; then
            IKOS_OK=1
        fi

        if has_file "$HOME/.coretrace/tools/tscancode/src/tscancode/trunk/tscancode" || has_cmd tscancode; then
            TSCANCODE_OK=1
        fi

        echo "$CPPCHECK_SYS|$CPPCHECK_BREW|$CPPCHECK_SARIF|$FLAWFINDER_OK|$IKOS_OK|$TSCANCODE_OK"
    `;

    const res = await execShellCommand(checkScript, { distro });
    const output = res.stdout.trim().split('\n').pop() || '';
    const parts = output.split('|').map((v) => v.trim() === '1');

    const details = {
        cppcheck: Boolean(parts[0]),
        cppcheckHomebrew: Boolean(parts[1]),
        cppcheckSarif: Boolean(parts[2]),
        flawfinder: Boolean(parts[3]),
        ikos: Boolean(parts[4]),
        tscancode: Boolean(parts[5]),
    };

    const missing: string[] = [];
    if (!details.cppcheckHomebrew || !details.cppcheckSarif) {
        missing.push('cppcheck');
    }
    if (!details.flawfinder) {
        missing.push('flawfinder');
    }
    if (!details.ikos) {
        missing.push('ikos');
    }
    if (!details.tscancode) {
        missing.push('tscancode');
    }

    return {
        allInstalled: missing.length === 0,
        missing,
        details,
    };
}

/**
 * Shell script executed inside the target environment (WSL or Linux) to install
 * and wire all CoreTrace tools.
 */
export function getInstallationScript(): string {
    return `
set -e
echo "=== [1/5] Installing base packages (apt)... ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq cppcheck flawfinder ikos git g++ make cmake python3 curl || true

echo "=== [2/5] Creating CoreTrace tools directory structure... ==="
USER_HOME="$CORETRACE_USER_HOME"
if [ -z "$USER_HOME" ] && [ -n "$SUDO_USER" ]; then
    USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
fi
if [ -z "$USER_HOME" ]; then
    USER_HOME="$HOME"
fi
TOOLS_DIR="$USER_HOME/.coretrace/tools"
mkdir -p "$TOOLS_DIR/bin"
mkdir -p "$TOOLS_DIR/flawfinder/src/flawfinder-build"
mkdir -p "$TOOLS_DIR/ikos/src/ikos-build/bin"
mkdir -p "$TOOLS_DIR/tscancode/src/tscancode/trunk"
mkdir -p /opt/homebrew/bin

echo "=== [3/5] Setting up Flawfinder and Ikos symlinks... ==="
FLAWFINDER_BIN=$(command -v flawfinder || true)
if [ -n "$FLAWFINDER_BIN" ]; then
    ln -sf "$FLAWFINDER_BIN" "$TOOLS_DIR/flawfinder/src/flawfinder-build/flawfinder.py"
    echo "Linked flawfinder: $FLAWFINDER_BIN -> $TOOLS_DIR/flawfinder/src/flawfinder-build/flawfinder.py"
fi

IKOS_BIN=$(command -v ikos || true)
if [ -n "$IKOS_BIN" ]; then
    ln -sf "$IKOS_BIN" "$TOOLS_DIR/ikos/src/ikos-build/bin/ikos"
    echo "Linked ikos: $IKOS_BIN -> $TOOLS_DIR/ikos/src/ikos-build/bin/ikos"
fi

echo "=== [4/5] Setting up Tscancode... ==="
if [ ! -f "$TOOLS_DIR/tscancode/src/tscancode/trunk/tscancode" ]; then
    TMP_TSC="/tmp/coretrace-TscanCode"
    if [ ! -d "$TMP_TSC" ]; then
        git clone --depth 1 https://github.com/CoreTrace/coretrace-TscanCode.git "$TMP_TSC"
    fi
    cd "$TMP_TSC/trunk"
    NPROC=$(nproc 2>/dev/null || echo 2)
    make -j"$NPROC"
    cp "$TMP_TSC/trunk/tscancode" "$TOOLS_DIR/tscancode/src/tscancode/trunk/tscancode"
    cp -r "$TMP_TSC/trunk/cfg" "$TOOLS_DIR/tscancode/src/tscancode/trunk/cfg"
    cp "$TMP_TSC/trunk/tscancode" /usr/local/bin/tscancode 2>/dev/null || true
    cp -r "$TMP_TSC/trunk/cfg" /usr/local/bin/cfg 2>/dev/null || true
    chmod +x "$TOOLS_DIR/tscancode/src/tscancode/trunk/tscancode"
    echo "Built and configured tscancode successfully."
else
    echo "Tscancode is already present."
fi

echo "=== [5/5] Setting up Cppcheck and /opt/homebrew/bin/cppcheck... ==="
# Check if /usr/local/bin/cppcheck or cppcheck supports --output-format=sarif
CPPCHECK_BIN=$(command -v /usr/local/bin/cppcheck || command -v cppcheck || true)
SUPPORTS_SARIF=0
if [ -n "$CPPCHECK_BIN" ]; then
    if "$CPPCHECK_BIN" --output-format=sarif --version >/dev/null 2>&1; then
        SUPPORTS_SARIF=1
    fi
fi

if [ "$SUPPORTS_SARIF" -eq 1 ]; then
    echo "Found SARIF-compatible Cppcheck at $CPPCHECK_BIN."
    ln -sf "$CPPCHECK_BIN" /opt/homebrew/bin/cppcheck
    ln -sf "$CPPCHECK_BIN" "$TOOLS_DIR/bin/cppcheck"
else
    echo "Cppcheck does not support --output-format=sarif. Building Cppcheck 2.16.0..."
    TMP_CPP="/tmp/cppcheck-src"
    if [ ! -d "$TMP_CPP" ]; then
        git clone --depth 1 -b 2.16.0 https://github.com/danmar/cppcheck.git "$TMP_CPP"
    fi
    mkdir -p "$TMP_CPP/build"
    cd "$TMP_CPP/build"
    cmake .. -DCMAKE_BUILD_TYPE=Release
    NPROC=$(nproc 2>/dev/null || echo 2)
    cmake --build . -j"$NPROC"
    cmake --install .
    ln -sf /usr/local/bin/cppcheck /opt/homebrew/bin/cppcheck
    ln -sf /usr/local/bin/cppcheck "$TOOLS_DIR/bin/cppcheck"
    echo "Cppcheck 2.16.0 built and installed to /usr/local/bin/cppcheck."
fi

# Ensure permissions
TOOLS_OWNER="$CORETRACE_USER_NAME"
if [ -z "$TOOLS_OWNER" ]; then TOOLS_OWNER="$SUDO_USER"; fi
if [ -n "$TOOLS_OWNER" ]; then chown -R "$TOOLS_OWNER:$TOOLS_OWNER" "$TOOLS_DIR" 2>/dev/null || true; fi
chmod -R 755 "$TOOLS_DIR" 2>/dev/null || true

echo "=== All CoreTrace dependencies installed and verified successfully! ==="
`;
}

/**
 * Installs and configures all CoreTrace dependencies.
 */
export async function installDependencies(
    output: vscode.OutputChannel,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    distro?: string | null
): Promise<boolean> {
    output.show(true);
    output.appendLine('[CoreTrace] Starting automated dependency installation...');
    progress.report({ message: 'Initializing installer...', increment: 5 });

    if (process.platform === 'win32' && !isWslAvailable()) {
        const errorMsg = 'WSL is required on Windows to install CoreTrace analyzers.';
        output.appendLine(`[CoreTrace] Error: ${errorMsg}`);
        vscode.window.showErrorMessage(errorMsg);
        return false;
    }

    let script = getInstallationScript();
    if (process.platform === 'win32') {
        const user = await execShellCommand('printf "%s\\n%s\\n" "$HOME" "$(id -un)"', { distro });
        const [userHome, userName] = user.stdout.trim().split(/\r?\n/).map(value => value.trim());
        if (user.code !== 0 || !userHome || !userName || !userHome.startsWith('/')) {
            output.appendLine('[CoreTrace] Could not determine the WSL user home directory.');
            vscode.window.showErrorMessage('CoreTrace could not determine the WSL user home directory.');
            return false;
        }
        const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
        script = `CORETRACE_USER_HOME=${quote(userHome)}\nCORETRACE_USER_NAME=${quote(userName)}\n${script}`;
    }

    progress.report({ message: 'Installing packages & building analyzers in WSL/Linux...', increment: 20 });

    const result = await execShellCommand(script, {
        asRoot: true,
        distro,
        onData: (chunk) => {
            output.append(chunk);
            if (chunk.includes('[1/5]')) {
                progress.report({ message: 'Installing system packages (apt)...', increment: 15 });
            } else if (chunk.includes('[2/5]')) {
                progress.report({ message: 'Creating directory structure...', increment: 10 });
            } else if (chunk.includes('[3/5]')) {
                progress.report({ message: 'Configuring Flawfinder & Ikos...', increment: 15 });
            } else if (chunk.includes('[4/5]')) {
                progress.report({ message: 'Building Tscancode...', increment: 20 });
            } else if (chunk.includes('[5/5]')) {
                progress.report({ message: 'Configuring Cppcheck & Homebrew symlinks...', increment: 20 });
            }
        },
    });

    if (result.code !== 0) {
        output.appendLine(`[CoreTrace] Installation script failed with exit code ${result.code}`);
        vscode.window.showErrorMessage(`CoreTrace dependency installation failed (code ${result.code}). See Output channel for details.`);
        return false;
    }

    // Verify after installation
    progress.report({ message: 'Verifying installed tools...', increment: 5 });
    const status = await checkDependencies(distro);

    if (status.allInstalled) {
        output.appendLine('[CoreTrace] All dependencies (cppcheck, flawfinder, ikos, tscancode) are operational!');
        vscode.window.showInformationMessage('CoreTrace analyzers (cppcheck, flawfinder, ikos, tscancode) have been successfully installed and configured!');
        return true;
    } else {
        const missingList = status.missing.join(', ');
        output.appendLine(`[CoreTrace] Some dependencies could not be verified: ${missingList}`);
        vscode.window.showWarningMessage(`Dependency setup finished, but some tools could not be verified: ${missingList}. Check the Output channel.`);
        return false;
    }
}
