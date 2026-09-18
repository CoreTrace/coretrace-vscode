/**
 * Sanitizes a C/C++ symbol name into a clean function identifier
 * suitable for ctrace --entry-points (e.g. "main()" -> "main", "int add(int, int)" -> "add").
 */
export function cleanFunctionName(name: string): string {
    if (!name) { return ''; }
    const parenIndex = name.indexOf('(');
    const beforeParen = parenIndex !== -1 ? name.substring(0, parenIndex) : name;
    const tokens = beforeParen.trim().split(/\s+/);
    let identifier = tokens[tokens.length - 1] || '';
    const templateIndex = identifier.indexOf('<');
    if (templateIndex !== -1) {
        identifier = identifier.substring(0, templateIndex);
    }
    return identifier.replace(/[^a-zA-Z0-9_:]/g, '');
}
