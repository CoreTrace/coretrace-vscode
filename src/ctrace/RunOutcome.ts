/** ctrace exit codes (--fail-on): 2 = completed with findings, 3 = a tool could not run. */
export const EXIT_FINDINGS = 2;
export const EXIT_INCOMPLETE = 3;

/**
 * The tools ctrace names as not run, from lines like
 * "[ERROR] Analysis incomplete: tscancode could not run (exit code 3)" and
 * "Error: Command not found in PATH: ikos".
 */
export function failedTools(output: string): string[] {
    const tools: string[] = [];
    const add = (name: string) => {
        const tool = name.trim();
        if (tool && !tools.includes(tool)) { tools.push(tool); }
    };
    for (const match of output.matchAll(/Analysis incomplete:\s*(.+?)\s+could not run/gi)) {
        match[1].split(/\s*,\s*|\s+and\s+/).forEach(add);
    }
    for (const match of output.matchAll(/Command not found in PATH:\s*([\w.+-]+)/gi)) {
        add(match[1]);
    }
    return tools;
}
