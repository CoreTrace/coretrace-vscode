/**
 * Shell code that picks the Cppcheck ctrace runs, shared by the dependency
 * check and by the analysis command so that both agree: the first
 * SARIF-capable (>= 2.14) executable among Homebrew's, CoreTrace's own
 * tools folder, and PATH. Prints nothing when there is none.
 *
 * CORETRACE_HOMEBREW_BIN replaces /opt/homebrew/bin in tests.
 */
export const CPPCHECK_RESOLVER_SH = `
coretrace_cppcheck_sarif() {
    [ -n "$1" ] && [ -x "$1" ] || return 1
    if "$1" --output-format=sarif /dev/null >/dev/null 2>&1; then return 0; fi
    v=$("$1" --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+' | head -1)
    [ -n "$v" ] || return 1
    major=\${v%%.*}; minor=\${v#*.}
    [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 14 ]; }
}
coretrace_resolve_cppcheck() {
    for candidate in "\${CORETRACE_HOMEBREW_BIN:-/opt/homebrew/bin}/cppcheck" "$HOME/.coretrace/tools/bin/cppcheck" "$(command -v cppcheck 2>/dev/null)"; do
        if coretrace_cppcheck_sarif "$candidate"; then echo "$candidate"; return 0; fi
    done
    return 0
}
`;

/** Exports CORETRACE_CPPCHECK_BIN for ctrace, keeping the former default when none is found. */
export function cppcheckEnvironment(): string {
    return `${CPPCHECK_RESOLVER_SH}
CORETRACE_CPPCHECK_PATH="$(coretrace_resolve_cppcheck)"
export CORETRACE_CPPCHECK_BIN="\${CORETRACE_CPPCHECK_PATH:-/opt/homebrew/bin/cppcheck}"
`;
}

/**
 * The Homebrew part of the installer. Homebrew refuses to run as root, so
 * it runs as the user who invoked sudo. A failure is no longer hidden: it is
 * printed and summed up on a CORETRACE_INSTALL_ERROR line, which the
 * extension shows (e.g. a tap formula that Homebrew asks to trust first).
 */
export const HOMEBREW_INSTALL_SH = `
coretrace_brew() {
    if [ "$(id -u)" = 0 ] && [ -n "$SUDO_USER" ]; then sudo -u "$SUDO_USER" brew "$@"; else brew "$@"; fi
}
coretrace_brew_install() {
    tool="$1"; shift
    if out=$(coretrace_brew install "$@" 2>&1); then
        printf '%s\\n' "$out"
    else
        printf '%s\\n' "$out"
        reason=$(printf '%s\\n' "$out" | grep -iE 'error|refus|trust|untrusted|failed' | tail -3 | tr '\\n' ' ')
        echo "CORETRACE_INSTALL_ERROR $tool: \${reason:-brew install $* failed}"
    fi
}
echo "Detected macOS (Homebrew)."
coretrace_brew_install cppcheck cppcheck
coretrace_brew_install flawfinder flawfinder
coretrace_brew_install build-tools cmake python3
# IKOS is only published through NASA's tap (builds LLVM deps, can take a while).
coretrace_brew_install ikos nasa-sw-vnv/core/ikos
`;

/** The CORETRACE_INSTALL_ERROR lines of an installer run, as "tool: reason". */
export function installErrors(output: string): string[] {
    return [...output.matchAll(/^CORETRACE_INSTALL_ERROR (.+)$/gm)].map(match => match[1].trim());
}
