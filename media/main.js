(function () {
    const vscode = acquireVsCodeApi();

    // ── DOM refs ───────────────────────────────────────────────────────────────
    const runBtn          = document.getElementById('run-btn');
    const runLabel        = document.getElementById('run-label');
    const paramsInput     = document.getElementById('params-input');
    const resultsContainer= document.getElementById('results-container');
    const vulnList        = document.getElementById('vuln-list');
    const vulnCount       = document.getElementById('vuln-count');
    const advancedBtn     = document.getElementById('advanced-btn');
    const advancedPanel   = document.getElementById('advanced-panel');
    const emptyState      = document.getElementById('empty-state');
    const fileLabel       = document.getElementById('file-label');

    // ── Init Lucide icons ──────────────────────────────────────────────────────
    // Must run BEFORE capturing chevron: createIcons() replaces <i> with <svg>,
    // so any reference taken before this call points to a detached element.
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // Captured AFTER createIcons so it references the live <svg> node

    // ── Advanced flags toggle ──────────────────────────────────────────────────
    if (advancedBtn && advancedPanel) {
        advancedBtn.addEventListener('click', () => {
            const isHidden = advancedPanel.classList.contains('advanced-hidden');
            advancedPanel.classList.toggle('advanced-hidden', !isHidden);
            advancedBtn.classList.toggle('open', isHidden);
            // Query chevron live at each click — Lucide may have replaced the node
            const liveChevron = document.getElementById('chevron');
            if (liveChevron) { liveChevron.classList.toggle('rotated', isHidden); }
        });
    }

    // ── Run button ─────────────────────────────────────────────────────────────
    if (runBtn) {
        runBtn.addEventListener('click', () => {
            const params = paramsInput ? paramsInput.value.trim() : '';

            setRunning(true);

            vscode.postMessage({
                type: 'execute-command',
                command: 'ctrace.runAnalysis',
                params: { customParams: params }
            });
        });
    }

    // ── Incoming messages ──────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'analysis-result':
                handleAnalysisResult(msg.data);
                break;
            case 'active-file':
                if (fileLabel) {
                    fileLabel.textContent = msg.name || 'No file open';
                }
                break;
        }
    });

    // ── Handlers ───────────────────────────────────────────────────────────────
    function setRunning(running) {
        if (!runBtn) { return; }
        runBtn.disabled = running;
        runBtn.classList.toggle('running', running);
        if (runLabel) { runLabel.textContent = running ? 'Analysing…' : 'Run Analysis'; }
        // Icons are toggled purely by CSS (.running .icon-idle / .icon-running)
        // No lucide.createIcons() call needed — avoids invalidating other SVG refs.
    }

    function handleAnalysisResult(sarif) {
        setRunning(false);

        if (emptyState)      { emptyState.style.display = 'none'; }
        if (resultsContainer){ resultsContainer.classList.remove('results-hidden'); }
        if (vulnList)        { vulnList.innerHTML = ''; }

        let count = 0;

        if (sarif && sarif.runs) {
            sarif.runs.forEach(run => {
                (run.results || []).forEach(res => { count++; addVulnItem(res); });
            });
        }

        if (vulnCount) {
            vulnCount.textContent = String(count);
            vulnCount.classList.toggle('zero', count === 0);
        }

        if (count === 0 && vulnList) {
            vulnList.innerHTML = '<li class="info-item">No vulnerabilities found.</li>';
            if (typeof lucide !== 'undefined') { lucide.createIcons(); }
        }
    }

    function addVulnItem(res) {
        if (!vulnList) { return; }

        const level    = (res.level || 'warning').toLowerCase();
        const ruleId   = res.ruleId || 'Rule';
        const message  = res.message ? res.message.text : 'Unknown issue';
        const loc      = res.locations && res.locations[0];

        let locText  = '';
        let line     = 0;
        let filePath = '';

        if (loc && loc.physicalLocation) {
            const pl = loc.physicalLocation;
            if (pl.artifactLocation && pl.artifactLocation.uri) {
                const parts = pl.artifactLocation.uri.split('/');
                locText  = parts[parts.length - 1];
                filePath = pl.artifactLocation.uri;
            }
            if (pl.region) {
                line     = pl.region.startLine || 0;
                locText += `:${line}`;
            }
        }

        const sevClass  = level === 'error' ? 'sev-error' : level === 'note' ? 'sev-note' : 'sev-warning';
        const sevIcon   = level === 'error' ? 'x-circle' : level === 'note' ? 'info' : 'triangle-alert';
        const ruleIcon  = 'shield-alert';

        const li = document.createElement('li');
        li.className = 'vuln-item';
        li.innerHTML = `
            <div class="vuln-header">
                <span class="vuln-rule">
                    <i data-lucide="${ruleIcon}"></i>
                    ${escapeHtml(ruleId)}
                </span>
                <span class="vuln-sev ${sevClass}">
                    <i data-lucide="${sevIcon}"></i>
                    ${escapeHtml(level)}
                </span>
            </div>
            ${locText ? `<div class="vuln-loc"><i data-lucide="map-pin"></i>${escapeHtml(locText)}</div>` : ''}
            <div class="vuln-msg">${escapeHtml(message)}</div>
        `;

        li.addEventListener('click', () => {
            vscode.postMessage({ type: 'open-file', path: filePath, line: Math.max(0, line - 1) });
        });

        vulnList.appendChild(li);

        // Scope createIcons to the new item only
        if (typeof lucide !== 'undefined') { lucide.createIcons({ nodes: [li] }); }
    }

    function escapeHtml(str) {
        if (!str) { return ''; }
        return str
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;') .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

}());
