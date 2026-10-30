// Pure call-tree model of the Stack tab: no DOM, so that it can be unit-tested
// under Node. Loaded by the webview before main.js.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CoreTraceStackTree = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    const SEPARATOR = '\n';
    /** Key of the collapsible group holding functions without any call link. */
    const STANDALONE_KEY = '\u0001standalone';
    const DEFAULT_MAX_ROWS = 800;

    function byPeakThenName(nodes) {
        return (a, b) => {
            const left = nodes.get(a);
            const right = nodes.get(b);
            return (right.maxStack || 0) - (left.maxStack || 0) || left.name.localeCompare(right.name);
        };
    }

    /**
     * Normalises a stack report. Roots are functions nobody calls (main first);
     * a cycle nobody enters gets its heaviest member as an extra root, so every
     * connected function is reachable from a root.
     */
    function createModel(report) {
        const nodes = new Map();
        for (const node of report?.callGraph?.nodes ?? []) { nodes.set(node.id, { ...node }); }
        for (const fn of report?.functions ?? []) {
            nodes.set(fn.name, { ...(nodes.get(fn.name) ?? {}), ...fn, id: fn.name, name: fn.name });
        }

        const children = new Map();
        const parents = new Map();
        for (const id of nodes.keys()) {
            children.set(id, []);
            parents.set(id, []);
        }
        let callCount = 0;
        const linked = new Set();
        for (const edge of report?.callGraph?.edges ?? []) {
            if (!nodes.has(edge.from) || !nodes.has(edge.to) || children.get(edge.from).includes(edge.to)) { continue; }
            children.get(edge.from).push(edge.to);
            parents.get(edge.to).push(edge.from);
            linked.add(edge.from);
            linked.add(edge.to);
            callCount++;
        }
        const compare = byPeakThenName(nodes);
        children.forEach(list => list.sort(compare));
        parents.forEach(list => list.sort(compare));

        const hasCaller = id => parents.get(id).some(parent => parent !== id);
        const mainFirst = (a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : compare(a, b));
        const roots = [...linked].filter(id => !hasCaller(id)).sort(mainFirst);

        const reached = new Set();
        const visit = start => {
            const stack = [start];
            while (stack.length) {
                const id = stack.pop();
                if (reached.has(id)) { continue; }
                reached.add(id);
                stack.push(...children.get(id));
            }
        };
        roots.forEach(visit);
        for (const id of [...linked].sort(compare)) {
            if (!reached.has(id)) {
                roots.push(id);
                visit(id);
            }
        }

        const standalone = [...nodes.keys()].filter(id => !linked.has(id)).sort(compare);
        const peak = Math.max(1, report?.peakStack || 0, ...[...nodes.values()].map(node => node.maxStack || 0));
        const model = { nodes, children, parents, roots, standalone, peak, callCount, hotKeys: new Set(), hotPath: [] };
        model.hotPath = computeHotPath(model);
        // Prefixes of the path are hot too: they are the rows leading to it.
        model.hotPath.forEach((_, index) => model.hotKeys.add(keyOf(topLevelPrefix(model, model.hotPath[0]), model.hotPath.slice(0, index + 1))));
        return model;
    }

    function keyOf(prefix, ids) {
        return [...prefix, ...ids].join(SEPARATOR);
    }

    /** Standalone rows live under the group row, so their keys start with it. */
    function topLevelPrefix(model, id) {
        return model.roots.length > 0 && model.standalone.includes(id) ? [STANDALONE_KEY] : [];
    }

    /** The call path that uses the most stack, following the heaviest callee at each step. */
    function computeHotPath(model) {
        const candidates = model.roots.length > 0 ? model.roots : model.standalone;
        if (candidates.length === 0) { return []; }
        let current = [...candidates].sort(byPeakThenName(model.nodes))[0];
        const path = [];
        const seen = new Set();
        while (current !== undefined && !seen.has(current)) {
            path.push(current);
            seen.add(current);
            current = model.children.get(current).find(child => !seen.has(child));
        }
        return path;
    }

    /** Roots and their first level open, plus the rows leading to the hottest function. */
    function defaultExpanded(model) {
        const expanded = new Set();
        for (const root of model.roots) { expanded.add(root); }
        if (model.hotPath.length > 0 && model.roots.length > 0) {
            model.hotPath.slice(0, -1).forEach((_, index) => expanded.add(keyOf([], model.hotPath.slice(0, index + 1))));
        }
        return expanded;
    }

    /** Every expandable row down to `maxDepth`, for "Expand all". */
    function allExpanded(model, maxDepth = 8, maxKeys = DEFAULT_MAX_ROWS) {
        const expanded = new Set();
        const walk = (id, path) => {
            if (expanded.size >= maxKeys || path.length >= maxDepth) { return; }
            const next = [...path, id];
            const callees = model.children.get(id).filter(child => !next.includes(child));
            if (callees.length === 0 && model.children.get(id).length === 0) { return; }
            expanded.add(keyOf([], next));
            callees.forEach(child => walk(child, next));
        };
        model.roots.forEach(root => walk(root, []));
        return expanded;
    }

    function matchesQuery(node, query) {
        return node.name.toLowerCase().includes(query) || Boolean(node.file && String(node.file).toLowerCase().includes(query));
    }

    /** Matching functions and everything that leads to them. */
    function visibleForQuery(model, query) {
        const matches = new Set([...model.nodes.values()].filter(node => matchesQuery(node, query)).map(node => node.id));
        const visible = new Set(matches);
        const stack = [...matches];
        while (stack.length) {
            for (const parent of model.parents.get(stack.pop())) {
                if (!visible.has(parent)) {
                    visible.add(parent);
                    stack.push(parent);
                }
            }
        }
        return { matches, visible };
    }

    /**
     * Flattens the tree into the rows to display. With a query every visible
     * row is open, since the user wants to see where the matches are.
     * @returns {{ rows: any[], matchCount: number, truncated: boolean }}
     */
    function flattenTree(model, options = {}) {
        const query = (options.query ?? '').trim().toLowerCase();
        const expanded = options.expanded ?? new Set();
        const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
        const filter = query ? visibleForQuery(model, query) : null;
        const rows = [];
        let truncated = false;

        const push = row => {
            if (rows.length >= maxRows) {
                truncated = true;
                return false;
            }
            rows.push(row);
            return true;
        };

        const walk = (id, depth, ancestors, prefix) => {
            const path = [...ancestors, id];
            const key = keyOf(prefix, path);
            const isCycleRef = ancestors.includes(id);
            const callees = isCycleRef ? [] : model.children.get(id).filter(child => !filter || filter.visible.has(child));
            const isExpanded = callees.length > 0 && (filter !== null || expanded.has(key));
            if (!push({
                kind: 'function',
                key,
                id,
                depth,
                isCycleRef,
                expandable: callees.length > 0,
                expanded: isExpanded,
                hot: model.hotKeys.has(key),
                match: filter?.matches.has(id) === true,
            })) { return; }
            if (isExpanded) { callees.forEach(child => walk(child, depth + 1, path, prefix)); }
        };

        const roots = filter ? model.roots.filter(id => filter.visible.has(id)) : model.roots;
        roots.forEach(root => walk(root, 0, [], []));

        const standalone = filter ? model.standalone.filter(id => filter.matches.has(id)) : model.standalone;
        if (standalone.length > 0) {
            if (model.roots.length === 0) {
                // Without any call link there is nothing to group apart from.
                standalone.forEach(id => walk(id, 0, [], []));
            } else {
                const open = filter !== null || expanded.has(STANDALONE_KEY);
                if (push({ kind: 'group', key: STANDALONE_KEY, depth: 0, count: standalone.length, expandable: true, expanded: open })) {
                    if (open) { standalone.forEach(id => walk(id, 1, [], [STANDALONE_KEY])); }
                }
            }
        }
        return { rows, matchCount: filter ? filter.matches.size : model.nodes.size, truncated };
    }

    /** All functions, heaviest first, for the Ranking view. */
    function rankedRows(model, queryText = '') {
        const query = queryText.trim().toLowerCase();
        return [...model.nodes.values()]
            .filter(node => !query || matchesQuery(node, query))
            .sort((a, b) => byPeakThenName(model.nodes)(a.id, b.id))
            .map(node => ({
                kind: 'function',
                key: node.id,
                id: node.id,
                depth: 0,
                isCycleRef: false,
                expandable: false,
                expanded: false,
                hot: false,
                match: Boolean(query),
            }));
    }

    /** Key of the shortest path from a root to `id`, with the keys to open on the way. */
    function pathTo(model, id) {
        if (!model.nodes.has(id)) { return null; }
        if (model.standalone.includes(id)) {
            const prefix = topLevelPrefix(model, id);
            return { key: keyOf(prefix, [id]), open: prefix.length > 0 ? [STANDALONE_KEY] : [] };
        }
        const queue = model.roots.map(root => [root]);
        const seen = new Set(model.roots);
        while (queue.length) {
            const path = queue.shift();
            const last = path[path.length - 1];
            if (last === id) {
                return { key: keyOf([], path), open: path.slice(0, -1).map((_, index) => keyOf([], path.slice(0, index + 1))) };
            }
            for (const child of model.children.get(last)) {
                if (!seen.has(child)) {
                    seen.add(child);
                    queue.push([...path, child]);
                }
            }
        }
        return null;
    }

    /** CodeLens passes unqualified names: `run` must find `Worker::run`. */
    function resolveName(model, name) {
        if (!name) { return null; }
        if (model.nodes.has(name)) { return name; }
        const suffix = `::${name}`;
        const match = [...model.nodes.keys()].filter(id => id.endsWith(suffix)).sort(byPeakThenName(model.nodes));
        return match[0] ?? null;
    }

    /** Key of the row a nested row hangs from, or null at the top level. */
    function parentKey(key) {
        const index = key.lastIndexOf(SEPARATOR);
        return index < 0 ? null : key.slice(0, index);
    }

    return { STANDALONE_KEY, createModel, defaultExpanded, allExpanded, flattenTree, rankedRows, pathTo, resolveName, parentKey };
}));
