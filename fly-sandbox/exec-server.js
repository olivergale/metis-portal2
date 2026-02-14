const http = require('http');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 8080;

const ALLOWED_COMMANDS = new Set([
  'grep', 'find', 'wc', 'cat', 'head', 'tail', 'echo', 'test',
  'ls', 'file', 'diff', 'jq', 'node', 'npm', 'npx', 'tsc',
  'python3', 'git', 'curl', 'sed', 'deno'
]);

const BLOCKED_COMMANDS = new Set([
  'rm', 'mv', 'dd', 'chmod', 'chown', 'kill', 'reboot',
  'shutdown', 'mkfs', 'fdisk'
]);

const WORKSPACE_ROOT = '/workspace';
const MAIN_WORKSPACE = '/workspace/main';

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

      // Execute command
      execFile(command, args, { 
        cwd, 
        timeout: timeout_ms || 30000, 
        maxBuffer: 1024 * 1024 
      }, (error, stdout, stderr) => {
        if (error) {
          return sendJson(res, 200, { 
            stdout: stdout || '', 
            stderr: error.message, 
            exit_code: error.code || 1 
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
  } else if (req.method === 'POST' && url === '/git-pull') {
    handleGitPull(req, res);
  } else {
    sendJson(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, () => {
  console.log(`Fly sandbox exec server listening on port ${PORT}`);
});
