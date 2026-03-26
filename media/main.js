(function () {
    const vscode = acquireVsCodeApi();

    // ── DOM refs ───────────────────────────────────────────────────────────────
    const runBtn           = document.getElementById('run-btn');
    const runLabel         = document.getElementById('run-label');
    const paramsInput      = document.getElementById('params-input');
    const resultsContainer = document.getElementById('results-container');
    const vulnList         = document.getElementById('vuln-list');
    const vulnCount        = document.getElementById('vuln-count');
    const advancedBtn      = document.getElementById('advanced-btn');
    const advancedPanel    = document.getElementById('advanced-panel');
    const emptyState       = document.getElementById('empty-state');
    const fileLabel        = document.getElementById('file-label');
    const filePill         = document.getElementById('file-pill');
    const scopeFile        = document.getElementById('scope-file');
    const scopeWs          = document.getElementById('scope-ws');
    const wsPill           = document.getElementById('ws-pill');
    const wsProgress       = document.getElementById('ws-progress');
    const wsProgressBar    = document.getElementById('ws-progress-bar');
    const wsProgressText   = document.getElementById('ws-progress-text');

    // ── Init Lucide icons ──────────────────────────────────────────────────────
    // Must run BEFORE capturing chevron: createIcons() replaces <i> with <svg>,
    // so any reference taken before this call points to a detached element.
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // ── Scope selector ─────────────────────────────────────────────────────────
    let workspaceMode = false;
    let isRunning = false;

    function applyScope(ws) {
        if (isRunning) { return; }
        workspaceMode = !!ws;
        if (scopeFile)  { scopeFile.classList.toggle('active', !workspaceMode); }
        if (scopeWs)    { scopeWs.classList.toggle('active',  workspaceMode); }
        if (filePill)   { filePill.classList.toggle('hidden',  workspaceMode); }
        if (wsPill)     { wsPill.classList.toggle('hidden',   !workspaceMode); }
        if (wsProgress) { wsProgress.classList.add('hidden'); }
        if (runLabel)   { runLabel.textContent = 'Run Analysis'; }
    }

    if (scopeFile) { scopeFile.addEventListener('click', () => applyScope(false)); }
    if (scopeWs)   { scopeWs.addEventListener('click',   () => applyScope(true));  }
    applyScope(false);

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

            if (workspaceMode) {
                if (wsProgress) { wsProgress.classList.remove('hidden'); }
                setWsProgress(0, 0, 0, 0);
                vscode.postMessage({
                    type: 'execute-command',
                    command: 'ctrace.runWorkspaceAnalysis',
                    params: { customParams: params }
                });
            } else {
                vscode.postMessage({
                    type: 'execute-command',
                    command: 'ctrace.runAnalysis',
                    params: { customParams: params }
                });
            }
        });
    }

    // ── Incoming messages ──────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'analysis-result':
                handleAnalysisResult(msg.data);
                break;
            case 'analysis-error':
                // Ensures the button is never stuck in loading state when
                // the analysis fails, crashes, or produces no parseable output.
                setRunning(false);
                if (wsProgress) { wsProgress.classList.add('hidden'); }
                break;
            case 'active-file':
                if (fileLabel) {
                    fileLabel.textContent = msg.name || 'No file open';
                }
                break;
            case 'workspace-progress':
                setWsProgress(msg.total, msg.changed, msg.cached, msg.done);
                break;
        }
    });

    // ── Handlers ───────────────────────────────────────────────────────────────
    function setRunning(running) {
        isRunning = running;
        if (!runBtn) { return; }
        runBtn.disabled = running;
        runBtn.classList.toggle('running', running);
        if (runLabel) { runLabel.textContent = running ? 'Analysing…' : 'Run Analysis'; }
        // Icons are toggled purely by CSS (.running .icon-idle / .icon-running)
        // No lucide.createIcons() call needed — avoids invalidating other SVG refs.
        
        if (scopeFile) scopeFile.style.opacity = running ? '0.5' : '1';
        if (scopeFile) scopeFile.style.cursor = running ? 'not-allowed' : 'pointer';
        if (scopeWs) scopeWs.style.opacity = running ? '0.5' : '1';
        if (scopeWs) scopeWs.style.cursor = running ? 'not-allowed' : 'pointer';
    }

    function setWsProgress(total, changed, cached, done) {
        if (!wsProgressBar || !wsProgressText) { return; }
        const pct = changed > 0 ? Math.round((done / changed) * 100) : 0;
        wsProgressBar.style.width = pct + '%';
        if (cached > 0) {
            wsProgressText.textContent = `${done}/${changed} analysed · ${cached} cached`;
        } else {
            wsProgressText.textContent = `${done}/${changed} files`;
        }
    }

    function handleAnalysisResult(sarif) {
        setRunning(false);
        if (wsProgress) { wsProgress.classList.add('hidden'); }

        if (emptyState)       { emptyState.style.display = 'none'; }
        if (resultsContainer) { resultsContainer.classList.remove('results-hidden'); }
        if (vulnList)         { vulnList.innerHTML = ''; }

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
        const message  = (res.message && res.message.text) ? res.message.text : 'Unknown issue';
        const loc      = res.locations && res.locations[0];

        let locText  = '';
        let line     = 0;
        let filePath = '';

        if (loc && loc.physicalLocation) {
            const pl = loc.physicalLocation;
            if (pl.artifactLocation && pl.artifactLocation.uri) {
                const parts = pl.artifactLocation.uri.split(/[\/\\]/);
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
            const safeLine = (typeof line === 'number' && isFinite(line)) ? Math.max(0, line - 1) : 0;
            vscode.postMessage({ type: 'open-file', path: filePath, line: safeLine });
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
            .replace(/'/g, '&#039;').replace(/`/g, '&#x60;');
    }

}());

