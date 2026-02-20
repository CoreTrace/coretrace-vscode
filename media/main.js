(function () {
    const vscode = acquireVsCodeApi();

    const runBtn = document.getElementById('run-btn');
    const paramsInput = document.getElementById('params-input');
    const resultsContainer = document.getElementById('results-container');
    const vulnList = document.getElementById('vuln-list');
    const volnCount = document.getElementById('vuln-count');

    // Handle Run Button
    if (runBtn) {
        runBtn.addEventListener('click', () => {
            const params = paramsInput ? paramsInput.value : '';
            // Visual feedback
            runBtn.innerText = 'Running...';
            runBtn.disabled = true;

            // Send command to extension
            vscode.postMessage({
                type: 'execute-command',
                command: 'ctrace.runAnalysis',
                params: { customParams: params }
            });
        });
    }

    // Handle Incoming Messages
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'analysis-result':
                handleAnalysisResult(message.data);
                break;
        }
    });

    function handleAnalysisResult(sarif) {
        // Reset button state
        if (runBtn) {
            runBtn.innerText = 'Run Analysis';
            runBtn.disabled = false;
        }

        // Show results container
        if (resultsContainer) {
            resultsContainer.classList.remove('results-hidden');
            resultsContainer.style.display = 'block';
        }

        // Clear previous results
        if (vulnList) vulnList.innerHTML = '';
        
        let count = 0;

        if (sarif && sarif.runs) {
            sarif.runs.forEach(run => {
                if (run.results && run.results.length > 0) {
                    run.results.forEach(res => {
                        count++;
                        addResultToDom(res);
                    });
                }
            });
        }

        if (volnCount) volnCount.innerText = count;

        if (count === 0 && vulnList) {
            vulnList.innerHTML = '<li class="info-item">No vulnerabilities found.</li>';
        }
    }

    function addResultToDom(res) {
        if (!vulnList) return;

        const li = document.createElement('li');
        li.className = 'vuln-item';

        const message = res.message ? res.message.text : 'Unknown Issue';
        const ruleId = res.ruleId || 'Rule';
        const location = res.locations && res.locations.length > 0 ? res.locations[0] : null;
        
        let locText = '';
        let line = 0;
        let filePath = '';

        if (location && location.physicalLocation) {
            const pl = location.physicalLocation;
            if (pl.artifactLocation && pl.artifactLocation.uri) {
                // Keep file name only for display
                const uri = pl.artifactLocation.uri;
                const parts = uri.split('/');
                locText = parts[parts.length - 1];
                filePath = uri; // Full path
            }
            if (pl.region) {
                line = pl.region.startLine || 0;
                locText += `:${line}`;
            }
        }

        // Construct HTML
        li.innerHTML = `
            <div class="vuln-header">
                <span class="vuln-rule">${escapeHtml(ruleId)}</span>
                <span class="vuln-loc">${escapeHtml(locText)}</span>
            </div>
            <div class="vuln-msg">${escapeHtml(message)}</div>
        `;

        // Click to open file
        li.addEventListener('click', () => {
             // Always send the request, let the extension handle path resolution
             vscode.postMessage({
                 type: 'open-file',
                 path: filePath, 
                 line: Math.max(0, line - 1) 
             });
        });

        vulnList.appendChild(li);
    }

    function escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

}());
