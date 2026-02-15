const http = require('http');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 8080;

const ALLOWED_COMMANDS = new Set([
  'grep', 'find', 'wc', 'cat', 'head', 'tail', 'echo', 'test',
  'ls', 'file', 'diff', 'jq', 'node', 'npm', 'npx', 'tsc',
  'python3', 'git', 'curl', 'sed', 'deno',
  'mkdir', 'cp', 'mv', 'touch', 'tee'
]);

// Commands that modify filesystem — must be chrooted to /workspace
const WRITE_COMMANDS = new Set(['mkdir', 'cp', 'mv', 'touch', 'tee']);

const BLOCKED_COMMANDS = new Set([
  'rm', 'dd', 'chmod', 'chown', 'kill', 'reboot',
  'shutdown', 'mkfs', 'fdisk'
]);

const AUDIT_LOG = '/var/log/sandbox-audit.jsonl';

const WORKSPACE_ROOT = '/workspace';
const MAIN_WORKSPACE = '/workspace/main';

function auditLog(wo_slug, command, args, exit_code) {
  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      wo_slug: wo_slug || 'unknown',
      command,
      args,
      exit_code
    }) + '\n';
    fs.appendFileSync(AUDIT_LOG, entry);
  } catch (_) { /* audit logging is best-effort */ }
}

function validateWriteChroot(command, args) {
  if (!WRITE_COMMANDS.has(command)) return null;
  for (const arg of args) {
    if (arg.startsWith('-')) continue; // skip flags
    const resolved = path.resolve(arg);
    if (!resolved.startsWith(WORKSPACE_ROOT)) {
      return `Write rejected: '${arg}' resolves outside /workspace`;
    }
  }
  return null;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleHealth(req, res) {
  sendJson(res, 200, { status: 'ok' });
}

function handleExec(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { command, args = [], timeout_ms, wo_slug } = JSON.parse(body);

      // Validate command
      if (!command) {
        return sendJson(res, 400, { stdout: '', stderr: 'command is required', exit_code: 1 });
      }

      // Block dangerous commands
      if (BLOCKED_COMMANDS.has(command)) {
        return sendJson(res, 400, { 
          stdout: '', 
          stderr: `Command '${command}' is blocked for security reasons`, 
          exit_code: 1 
        });
      }

      // Validate allowed commands
      if (!ALLOWED_COMMANDS.has(command)) {
        return sendJson(res, 400, { 
          stdout: '', 
          stderr: `Command '${command}' is not in the allowed list`, 
          exit_code: 1 
        });
      }

      // Determine working directory
      let cwd = MAIN_WORKSPACE;
      if (wo_slug) {
        const woPath = path.join(WORKSPACE_ROOT, wo_slug);
        if (!fs.existsSync(woPath)) {
          // Create worktree for this WO
          try {
            execFileSync('git', ['worktree', 'add', '--detach', woPath], {
              cwd: MAIN_WORKSPACE, 
              timeout: 30000 
            });
          } catch (err) {
            return sendJson(res, 500, { 
              stdout: '', 
              stderr: `Failed to create worktree: ${err.message}`, 
              exit_code: 1 
            });
          }
        }
        cwd = woPath;
      }

      // Chroot validation for write commands
      if (WRITE_COMMANDS.has(command)) {
        const chrootErr = validateWriteChroot(command, args);
        if (chrootErr) {
          auditLog(wo_slug, command, args, 1);
          return sendJson(res, 403, { stdout: '', stderr: chrootErr, exit_code: 1 });
        }
      }

      // Execute command
      execFile(command, args, {
        cwd,
        timeout: timeout_ms || 30000,
        maxBuffer: 1024 * 1024
      }, (error, stdout, stderr) => {
        const exitCode = error ? (error.code || 1) : 0;
        // Audit log write commands
        if (WRITE_COMMANDS.has(command)) {
          auditLog(wo_slug, command, args, exitCode);
        }
        if (error) {
          return sendJson(res, 200, {
            stdout: stdout || '',
            stderr: error.message,
            exit_code: exitCode
          });
        }
        sendJson(res, 200, {
          stdout: stdout || '',
          stderr: stderr || '',
          exit_code: 0
        });
      });

    } catch (err) {
      sendJson(res, 400, { stdout: '', stderr: err.message, exit_code: 1 });
    }
  });
}

function handleGitPull(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      // If workspace/main doesn't exist, clone first
      if (!fs.existsSync(MAIN_WORKSPACE)) {
        const token = process.env.GITHUB_TOKEN;
        const repoUrl = token
          ? `https://x-access-token:${token}@github.com/olivergale/metis-portal2.git`
          : 'https://github.com/olivergale/metis-portal2.git';
        execFile('git', ['clone', repoUrl, MAIN_WORKSPACE], {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
          const output = (stdout || '') + (stderr || '');
          sendJson(res, 200, {
            success: !error,
            output: error ? output : 'Repository cloned successfully',
            exit_code: error ? (error.code || 1) : 0
          });
        });
        return;
      }
      execFile('git', ['pull'], {
        cwd: MAIN_WORKSPACE,
        timeout: 60000,
        maxBuffer: 1024 * 1024
      }, (error, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        sendJson(res, 200, {
          success: !error,
          output: output,
          exit_code: error ? (error.code || 1) : 0
        });
      });
    } catch (err) {
      sendJson(res, 500, { success: false, output: err.message });
    }
  });
}

function handlePipeline(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { commands = [], timeout_ms, wo_slug } = JSON.parse(body);

      if (!Array.isArray(commands) || commands.length === 0) {
        return sendJson(res, 400, { steps: [], overall_success: false, error: 'commands array is required' });
      }

      // Determine working directory
      let cwd = MAIN_WORKSPACE;
      if (wo_slug) {
        const woPath = path.join(WORKSPACE_ROOT, wo_slug);
        if (fs.existsSync(woPath)) cwd = woPath;
      }

      const steps = [];
      let stepIndex = 0;

      function runStep() {
        if (stepIndex >= commands.length) {
          return sendJson(res, 200, { steps, overall_success: true });
        }

        const step = commands[stepIndex];
        const { command, args = [] } = step;

        // Validate each command
        if (!command || BLOCKED_COMMANDS.has(command) || !ALLOWED_COMMANDS.has(command)) {
          const errMsg = !command ? 'command is required'
            : BLOCKED_COMMANDS.has(command) ? `'${command}' is blocked`
            : `'${command}' is not allowed`;
          steps.push({ command, args, stdout: '', stderr: errMsg, exit_code: 1, duration_ms: 0 });
          return sendJson(res, 200, { steps, overall_success: false });
        }

        // Chroot validation for write commands
        if (WRITE_COMMANDS.has(command)) {
          const chrootErr = validateWriteChroot(command, args);
          if (chrootErr) {
            auditLog(wo_slug, command, args, 1);
            steps.push({ command, args, stdout: '', stderr: chrootErr, exit_code: 1, duration_ms: 0 });
            return sendJson(res, 200, { steps, overall_success: false });
          }
        }

        const startTime = Date.now();
        execFile(command, args, {
          cwd,
          timeout: timeout_ms || 30000,
          maxBuffer: 1024 * 1024
        }, (error, stdout, stderr) => {
          const duration_ms = Date.now() - startTime;
          const exit_code = error ? (error.code || 1) : 0;

          if (WRITE_COMMANDS.has(command)) {
            auditLog(wo_slug, command, args, exit_code);
          }

          steps.push({
            command,
            args,
            stdout: stdout || '',
            stderr: error ? error.message : (stderr || ''),
            exit_code,
            duration_ms
          });

          if (exit_code !== 0) {
            return sendJson(res, 200, { steps, overall_success: false });
          }

          stepIndex++;
          runStep();
        });
      }

      runStep();
    } catch (err) {
      sendJson(res, 400, { steps: [], overall_success: false, error: err.message });
    }
  });
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    handleHealth(req, res);
  } else if (req.method === 'POST' && url === '/exec') {
    handleExec(req, res);
  } else if (req.method === 'POST' && url === '/pipeline') {
    handlePipeline(req, res);
  } else if (req.method === 'POST' && url === '/git-pull') {
    handleGitPull(req, res);
  } else {
    sendJson(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, () => {
  console.log(`Fly sandbox exec server listening on port ${PORT}`);
});
