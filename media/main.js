(function () {
    const vscode = acquireVsCodeApi();

    // ── DOM refs ───────────────────────────────────────────────────────────────
    const runBtn          = document.getElementById('run-btn');
    const runLabel        = document.getElementById('run-label');
    const resultsContainer= document.getElementById('results-container');
    const vulnList        = document.getElementById('vuln-list');
    const vulnCount       = document.getElementById('vuln-count');
    const findingsSearch  = document.getElementById('findings-search');
    const severityFilter  = document.getElementById('severity-filter');
    const findingsEmpty   = document.getElementById('findings-empty');
    const statusDot       = document.getElementById('status-dot');
    const statusText      = document.getElementById('status-text');
    const statusDetail    = document.getElementById('status-detail');
    const progressTrack   = document.getElementById('progress-track');
    const progressBar     = document.getElementById('progress-bar');
    const summaryErrors   = document.getElementById('summary-errors');
    const summaryWarnings = document.getElementById('summary-warnings');
    const summaryNotes    = document.getElementById('summary-notes');
    const helpBtn         = document.getElementById('help-btn');
    const emptyState      = document.getElementById('empty-state');
    const emptyRunBtn     = document.getElementById('empty-run-btn');
    const fileLabel       = document.getElementById('file-label');
    const scanModeRow     = document.getElementById('scan-mode-row');
    const scanFileBtn     = document.getElementById('scan-file-btn');
    const scanWorkspaceBtn = document.getElementById('scan-workspace-btn');
    const filePill        = document.getElementById('file-pill');
    const sidebar         = document.querySelector('.sidebar');
    const dashboardView   = document.getElementById('dashboard-view');
    const settingsView    = document.getElementById('settings-view');
    const settingsBtn     = document.getElementById('settings-btn');
    const backBtn         = document.getElementById('back-btn');
    const browseCompileCommands = document.getElementById('browse-compile-commands');
    const modeStaticCb    = document.getElementById('mode-static-cb');
    const modeDynCb       = document.getElementById('mode-dyn-cb');
    const onlyDirGroup    = document.getElementById('only-dir-group');
    const excludeDirGroup = document.getElementById('exclude-dir-group');
    const crossTuGroup    = document.getElementById('cross-tu-group');
    const crossTuCb       = document.getElementById('resource-cross-tu');
    const autoEntryGroup  = document.getElementById('auto-entry-points-group');
    const autoEntryCb     = document.getElementById('auto-entry-points');
    const autoEntryHint   = document.getElementById('auto-entry-points-hint');
    const smtSection      = document.getElementById('smt-section');
    const profileToggle   = document.getElementById('analysis-profile-toggle');
    const profileLabel    = document.getElementById('analysis-profile-label');
    const ikosTool        = document.getElementById('ikos-tool');
    const ikosCb           = ikosTool ? ikosTool.querySelector('input') : null;
    const persistedState   = vscode.getState() || {};
    let analysisProfile = 'full';
    let findings = [];
    let currentStatus = 'ready';

    // ── Init Lucide icons ──────────────────────────────────────────────────────
    // Render static Lucide icons before wiring interactive controls.
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    function setView(view) {
        const settingsOpen = view === 'settings';
        if (sidebar) { sidebar.classList.toggle('settings-open', settingsOpen); }
        if (dashboardView) { dashboardView.classList.toggle('active', !settingsOpen); }
        if (settingsView) {
            settingsView.classList.toggle('active', settingsOpen);
            settingsView.setAttribute('aria-hidden', String(!settingsOpen));
        }
    }

    if (settingsBtn) { settingsBtn.addEventListener('click', () => setView('settings')); }
    if (backBtn) { backBtn.addEventListener('click', () => setView('dashboard')); }

    // ── Scan-all toggle ────────────────────────────────────────────────────────
    let lastFileName = '';

    let scanWorkspace = false;
    function updateAnalysisModeStyles() {
        if (modeStaticCb) { modeStaticCb.parentElement.classList.toggle('active', modeStaticCb.checked); }
        if (modeDynCb) { modeDynCb.parentElement.classList.toggle('active', modeDynCb.checked); }
    }

    if (modeStaticCb) { modeStaticCb.addEventListener('change', updateAnalysisModeStyles); }
    if (modeDynCb) { modeDynCb.addEventListener('change', updateAnalysisModeStyles); }
    updateAnalysisModeStyles();

    function setScanMode(workspace) {
        scanWorkspace = workspace;
        if (scanFileBtn) { scanFileBtn.classList.toggle('active', !workspace); }
        if (scanWorkspaceBtn) { scanWorkspaceBtn.classList.toggle('active', workspace); }
        if (filePill) { filePill.classList.toggle('faded', workspace); }
        if (fileLabel) {
            fileLabel.textContent = workspace
                ? 'All C/C++ files in workspace'
                : (lastFileName || 'Open a C/C++ file to analyse');
        }
        [onlyDirGroup, excludeDirGroup].forEach(group => {
            if (group) { group.classList.toggle('is-hidden', !workspace); }
        });
        if (crossTuCb) {
            crossTuCb.disabled = !workspace;
            if (!workspace) { crossTuCb.checked = false; }
        }
        if (crossTuGroup) { crossTuGroup.classList.toggle('is-disabled', !workspace); }
        if (autoEntryCb) { autoEntryCb.disabled = workspace; }
        if (autoEntryGroup) { autoEntryGroup.classList.toggle('is-disabled', workspace); }
        if (autoEntryHint) { autoEntryHint.hidden = !workspace; }
        saveUiState();
    }

    if (scanFileBtn) { scanFileBtn.addEventListener('click', () => setScanMode(false)); }
    if (scanWorkspaceBtn) { scanWorkspaceBtn.addEventListener('click', () => setScanMode(true)); }
    setScanMode(false);

    if (scanModeRow) {
        scanModeRow.addEventListener('keydown', event => {
            if (event.key === 'ArrowLeft') { setScanMode(false); }
            if (event.key === 'ArrowRight') { setScanMode(true); }
        });
    }

    // ── CLI help ──────────────────────────────────────────────────────────────
    if (helpBtn) {
        helpBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'execute-command', command: 'ctrace.showHelp' });
        });
    }

    if (browseCompileCommands) {
        browseCompileCommands.addEventListener('click', () => {
            vscode.postMessage({ type: 'pick-compile-commands' });
        });
    }

    if (findingsSearch) { findingsSearch.addEventListener('input', renderFilteredFindings); }
    if (severityFilter) { severityFilter.addEventListener('change', renderFilteredFindings); }

    const smtEnabled = document.getElementById('smt-enabled');
    const smtControls = ['smt-backend', 'smt-secondary-backend', 'smt-mode', 'smt-timeout-ms', 'smt-rules']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    function updateSmtControls() {
        const enabled = Boolean(smtEnabled && smtEnabled.checked);
        smtControls.forEach(control => { control.disabled = !enabled; });
    }

    if (smtEnabled) {
        smtEnabled.addEventListener('change', updateSmtControls);
        updateSmtControls();
    }

    function updateProfileDependentUi() {
        const fast = analysisProfile === 'fast';
        if (fast && smtEnabled) {
            smtEnabled.checked = false;
            updateSmtControls();
        }
        if (smtSection) {
            smtSection.classList.toggle('is-disabled', fast);
            smtSection.style.display = fast ? 'none' : '';
        }
        if (ikosCb) {
            ikosCb.disabled = Boolean(fast);
            if (fast) { ikosCb.checked = false; }
        }
        if (ikosTool) { ikosTool.classList.toggle('is-disabled', Boolean(fast)); }
    }

    function setAnalysisProfile(profile) {
        analysisProfile = profile === 'fast' ? 'fast' : 'full';
        const label = analysisProfile === 'fast' ? 'Fast' : 'Full';
        if (profileLabel) { profileLabel.textContent = label; }
        if (profileToggle) {
            profileToggle.setAttribute('aria-label', `Analysis profile: ${label}`);
        }
        updateProfileDependentUi();
    }

    if (profileToggle) {
        profileToggle.addEventListener('click', () => {
            setAnalysisProfile(analysisProfile === 'full' ? 'fast' : 'full');
            saveUiState();
        });
    }
    setAnalysisProfile('full');

    function restoreUiState() {
        const saved = persistedState.uiState;
        if (!saved) { return; }

        setScanMode(persistedState.scanWorkspace === true);
        setAnalysisProfile(saved.analysisProfile || 'full');
        setChecked('mode-static-cb', saved.staticEnabled !== false);
        setChecked('mode-dyn-cb', saved.dynamicEnabled !== false);
        setValue('only-function', saved.onlyFunction || '');
        setValue('only-dir', saved.onlyDir || '');
        setValue('exclude-dir', saved.excludeDir || '');
        setChecked('include-stl', saved.includeStl === true);
        setChecked('resource-cross-tu', saved.resourceCrossTu === true);
        setChecked('auto-entry-points', saved.autoEntryPoints === true);
        setChecked('smt-enabled', saved.smtEnabled === true);
        setValue('smt-backend', saved.smtBackend || 'interval');
        setValue('smt-secondary-backend', saved.smtSecondaryBackend || 'interval');
        setValue('smt-mode', saved.smtMode || 'single');
        setValue('smt-timeout-ms', saved.smtTimeoutMs || '');
        setValue('smt-rules', saved.smtRules || '');
        setChecked('compdb-fast', saved.compdbFast === true);
        setChecked('include-compdb-deps', saved.includeCompdbDeps === true);
        setValue('compiler-extra-args', saved.compilerExtraArgs || '');
        setValue('extra-includes', saved.extraIncludes || '');
        setValue('macros', saved.macros || '');
        setChecked('quiet', saved.quiet === true);
        setChecked('warnings-only', saved.warningsOnly === true);
        setChecked('timing', saved.timing === true);
        setChecked('demangle', saved.demangle === true);
        setChecked('dump-filter', saved.dumpFilter === true);

        document.querySelectorAll('.invoke-tool').forEach(tool => {
            tool.checked = Array.isArray(saved.invokedTools) && saved.invokedTools.includes(tool.value);
        });

        updateAnalysisModeStyles();
        updateSmtControls();
        updateProfileDependentUi();
    }

    function saveUiState() {
        vscode.setState({
            uiState: readCtraceUiState(),
            scanWorkspace,
        });
    }

    function bindStatePersistence() {
        document.querySelectorAll('input, select').forEach(control => {
            control.addEventListener('input', saveUiState);
            control.addEventListener('change', saveUiState);
        });
    }

    restoreUiState();
    bindStatePersistence();

    // ── Run button ─────────────────────────────────────────────────────────────
    if (runBtn) {
        runBtn.addEventListener('click', () => {
            const uiState = readCtraceUiState();

            setRunning(true);

            vscode.postMessage({
                type: 'execute-command',
                command: 'ctrace.runAnalysis',
                params: { uiState, scanWorkspace, scanMode: scanWorkspace ? 'workspace' : 'file' }
            });
        });
    }

    if (emptyRunBtn && runBtn) {
        emptyRunBtn.addEventListener('click', () => runBtn.click());
    }

    function readCtraceUiState() {
        return {
            scanMode: scanWorkspace ? 'workspace' : 'file',
            staticEnabled: checked('mode-static-cb'),
            dynamicEnabled: checked('mode-dyn-cb'),
            onlyFunction: valueOf('only-function'),
            onlyDir: valueOf('only-dir'),
            excludeDir: valueOf('exclude-dir'),
            includeStl: checked('include-stl'),
            resourceCrossTu: scanWorkspace && checked('resource-cross-tu'),
            autoEntryPoints: !scanWorkspace && checked('auto-entry-points'),
            smtEnabled: checked('smt-enabled'),
            smtBackend: valueOf('smt-backend') || 'interval',
            smtSecondaryBackend: valueOf('smt-secondary-backend') || 'interval',
            smtMode: valueOf('smt-mode') || 'single',
            smtTimeoutMs: numberValueOf('smt-timeout-ms'),
            smtRules: valueOf('smt-rules'),
            analysisProfile,
            invokedTools: selectedInvokeTools(),
            compileCommandsPath: valueOf('compile-commands-path'),
            compdbFast: checked('compdb-fast'),
            includeCompdbDeps: checked('include-compdb-deps'),
            compilerExtraArgs: valueOf('compiler-extra-args'),
            extraIncludes: valueOf('extra-includes'),
            macros: valueOf('macros'),
            quiet: checked('quiet'),
            warningsOnly: checked('warnings-only'),
            timing: checked('timing'),
            demangle: checked('demangle'),
            dumpFilter: checked('dump-filter'),
        };
    }

    function selectedInvokeTools() {
        return Array.from(document.querySelectorAll('.invoke-tool:checked'))
            .map(element => element.value);
    }

    function checked(id) {
        const element = document.getElementById(id);
        return Boolean(element && element.checked);
    }

    function valueOf(id) {
        const element = document.getElementById(id);
        return element ? element.value.trim() : '';
    }

    function numberValueOf(id) {
        const value = valueOf(id);
        return value ? Number(value) : undefined;
    }

    function setValue(id, value) {
        const element = document.getElementById(id);
        if (element) { element.value = value; }
    }

    function setChecked(id, value) {
        const element = document.getElementById(id);
        if (element) { element.checked = value; }
    }

    // ── Incoming messages ──────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'analysis-result':
                handleAnalysisResult(msg.data);
                break;
<<<<<<< HEAD
            case 'analysis-done':
                setRunning(false);
                if (currentStatus === 'running') { setStatus('Ready to audit', '', 'ready'); }
                break;
            case 'analysis-progress':
                setStatus(msg.message || 'Analysing…', msg.detail || '', 'running');
                setProgress(msg.percent);
                break;
            case 'analysis-status':
                setStatus(msg.message || 'Analysis complete', msg.detail || '', msg.status || 'ready');
=======
            case 'analysis-error':
                // Ensures the button is never stuck in loading state when
                // the analysis fails, crashes, or produces no parseable output.
                setRunning(false);
>>>>>>> cd3ca2ef27d46ff123a8febbfd8447a3cf764b8e
                break;
            case 'active-file':
                lastFileName = msg.name || 'No file open';
                if (fileLabel && !scanWorkspace) {
                    fileLabel.textContent = lastFileName;
                }
                break;
            case 'compile-commands-selected':
                setValue('compile-commands-path', msg.path || '');
                break;
        }
    });

    function setValue(id, value) {
        const element = document.getElementById(id);
        if (element) { element.value = value; }
    }

    // ── Handlers ───────────────────────────────────────────────────────────────
    function setRunning(running) {
        if (!runBtn) { return; }
        runBtn.disabled = running;
        runBtn.classList.toggle('running', running);
        if (runLabel) { runLabel.textContent = running ? 'Analysing…' : 'Run Analysis'; }
        if (running) {
            setStatus('Analysis in progress', 'Ctrace is scanning the selected scope', 'running');
            setProgress(0);
        }
        // Icons are toggled purely by CSS (.running .icon-idle / .icon-running)
        // No lucide.createIcons() call needed — avoids invalidating other SVG refs.
    }

    function handleAnalysisResult(sarif) {
        setRunning(false);
        setStatus('Analysis complete', 'Findings are shown below', 'success');
        setProgress(100);

        if (emptyState)      { emptyState.style.display = 'none'; }
        if (resultsContainer){ resultsContainer.classList.remove('results-hidden'); }
        if (vulnList)        { vulnList.innerHTML = ''; }

        findings = [];

        if (sarif && sarif.runs) {
            sarif.runs.forEach(run => {
                (run.results || []).forEach(res => findings.push(res));
            });
        }

        const count = findings.length;
        if (vulnCount) {
            vulnCount.textContent = String(count);
            vulnCount.classList.toggle('zero', count === 0);
        }

        updateSummary(findings);
        renderFilteredFindings();

        if (count === 0 && vulnList) {
            vulnList.innerHTML = '<li class="info-item">No issues detected for the selected scope.</li>';
            if (typeof lucide !== 'undefined') { lucide.createIcons(); }
        }
    }

    function renderFilteredFindings() {
        if (!vulnList) { return; }
        const query = findingsSearch ? findingsSearch.value.trim().toLowerCase() : '';
        const severity = severityFilter ? severityFilter.value : 'all';
        const filtered = findings.filter(result => {
            const level = (result.level || 'warning').toLowerCase();
            const text = `${result.ruleId || ''} ${result.message?.text || ''} ${result.locations?.[0]?.physicalLocation?.artifactLocation?.uri || ''}`.toLowerCase();
            return (severity === 'all' || level === severity) && (!query || text.includes(query));
        });

        vulnList.innerHTML = '';
        filtered.forEach(addVulnItem);
        if (findingsEmpty) { findingsEmpty.hidden = findings.length === 0 || filtered.length > 0; }
        if (findings.length > 0 && filtered.length === 0 && vulnList) {
            vulnList.innerHTML = '<li class="info-item">No findings match the current filters.</li>';
        }
    }

    function updateSummary(results) {
        const counts = { error: 0, warning: 0, note: 0 };
        results.forEach(result => {
            const level = (result.level || 'warning').toLowerCase();
            if (counts[level] !== undefined) { counts[level]++; }
        });
        if (summaryErrors) { summaryErrors.textContent = String(counts.error); }
        if (summaryWarnings) { summaryWarnings.textContent = String(counts.warning); }
        if (summaryNotes) { summaryNotes.textContent = String(counts.note); }
    }

    function setStatus(message, detail, state) {
        currentStatus = state || 'ready';
        if (statusText) { statusText.textContent = message; }
        if (statusDetail) { statusDetail.textContent = detail; }
        if (statusDot) {
            statusDot.className = `status-dot ${state || 'ready'}`;
        }
    }

    function setProgress(percent) {
        if (!progressTrack || !progressBar) { return; }
        progressTrack.hidden = percent === undefined || percent === null || percent >= 100;
        if (percent !== undefined && percent !== null) {
            progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
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
