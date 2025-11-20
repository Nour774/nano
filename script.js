// script.js (محدّث)
// يعتمد على تحميل commands.js قبل هذا الملف

// 🌐 إعداد Supabase (كما أرسلت)
const SUPABASE_URL = "https://hmamaaqtnzevrrmgtgxk.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhtYW1hYXF0bnpldnJybWd0Z3hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzNTgzMDAsImV4cCI6MjA3NzkzNDMwMH0.tk_S2URpkYvf8xnsPJl3Dqh4jzKwhVm0alWl8oHo-SE";

// 🌐 رابط Google Apps Script Web App (TERMINAL API)
const TERMINAL_API_URL = "https://script.google.com/macros/s/AKfycbzhYVvS4iAGVnA3N69kyVAJvTZgEKv82fMbcODr3CEpcxzcQ3MUnHOkj0fs4TGJDDBM/exec";

// ========== xterm setup ==========
const term = new Terminal({
  theme: { background: '#0c0c0c', foreground: '#00ff00' },
  cursorBlink: true,
  scrollback: 1000,
  cols: 80,
  rows: 24,
});
term.open(document.getElementById('terminal'));

// try to fit terminal to container (best-effort)
function fitTerminal() {
  try {
    const container = document.getElementById('terminal');
    const width = container.clientWidth;
    const height = container.clientHeight;
    // estimate cols/rows based on character size approx 8x16
    const cols = Math.max(20, Math.floor(width / 8));
    const rows = Math.max(8, Math.floor(height / 18));
    term.resize(cols, rows);
  } catch (e) {
    // ignore
  }
}
window.addEventListener('resize', () => { fitTerminal(); });
fitTerminal();

// المستويات اللونية
const roles = {
  user: '#00ff00',
  admin: '#ffaa00',
  root: '#ff5555',
};

let currentRole = 'user';

// === Prompt writing util ===
function hexToRgbStr(hex) {
  const bigint = parseInt(hex.replace('#',''), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `${r};${g};${b}`;
}

function writePrompt() {
  const color = roles[currentRole] || '#00ff00';
  const rgb = hexToRgbStr(color);
  const symbol = (currentRole === 'user') ? '~$' : '~#';
  term.write(`\r\n\x1b[38;2;${rgb}m${currentRole}@system:${symbol} \x1b[0m`);
}

// initial banner
term.writeln("🟢 AdminShell v1.0");
term.writeln("Type 'help' for available commands.");
writePrompt();

// ===== state for input handling =====
let buffer = '';
let passwordMode = false;
let passwordResolver = null;

// Editor mode state
let EDITOR_MODE = false;
let EDITOR_BUFFER = []; // array of lines
let EDITOR_PATH = '';
let EDITOR_ROLE = 'user';

// prompt text when editing
function showEditorHeader() {
  term.writeln(`--- EDITOR MODE: /${EDITOR_PATH} (type #@/s~ to save, #@/c~ to cancel) ---`);
  term.writeln('(ادخل سطور الملف. السطر الذي يحتوي بالضبط على #@/s~ سيحفظ ويخرج)');
  term.writeln('(السطر #@/c~ سيلغي الجلسة ويهمل التغييرات)');
}

// function to enter editor (called by commands.startpaste)
window.enterEditor = function(path, role) {
  if (!path) { term.writeln('❌ enterEditor: path missing'); return; }
  if (EDITOR_MODE) { term.writeln('⚠️ Editor already open. Finish previous session first.'); return; }
  EDITOR_MODE = true;
  EDITOR_BUFFER = [];
  EDITOR_PATH = path;
  EDITOR_ROLE = role || currentRole;
  showEditorHeader();
  writePrompt();
};

// function to save editor buffer
async function saveEditor() {
  // send to API (update/create)
  const content = EDITOR_BUFFER.join('\n');
  // POST JSON request as in commands.js expects
  try {
    const res = await fetch(TERMINAL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', path: EDITOR_PATH, data: content })
    });
    const ct = res.headers.get('content-type') || '';
    let body;
    if (ct.includes('application/json')) body = await res.json();
    else body = await res.text();
    // if API returns ok flag use it
    if (body && body.ok) {
      term.writeln(`✅ File saved: /${EDITOR_PATH}`);
    } else {
      // try create fallback
      const res2 = await fetch(TERMINAL_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', path: EDITOR_PATH, data: content })
      });
      const ct2 = res2.headers.get('content-type') || '';
      let b2;
      if (ct2.includes('application/json')) b2 = await res2.json();
      else b2 = await res2.text();
      if (b2 && b2.ok) term.writeln(`✅ File created: /${EDITOR_PATH}`);
      else term.writeln('❌ Failed to save file (server error).');
    }
  } catch (e) {
    term.writeln('❌ Network error while saving: ' + e.message);
  }
  // reset editor
  EDITOR_MODE = false;
  EDITOR_BUFFER = [];
  EDITOR_PATH = '';
  EDITOR_ROLE = 'user';
  writePrompt();
}

// cancel editor
function cancelEditor() {
  EDITOR_MODE = false;
  EDITOR_BUFFER = [];
  const p = EDITOR_PATH;
  EDITOR_PATH = '';
  EDITOR_ROLE = 'user';
  term.writeln('⚠️ Edit cancelled.');
  writePrompt();
}

// ===== password prompt (uses existing promptPassword integration) =====
function promptPassword(msg) {
  return new Promise(resolve => {
    buffer = '';
    passwordMode = true;
    passwordResolver = resolve;
    term.write(msg);
  });
}

// verifyPassword via Supabase (as in your original)
// returns boolean
async function verifyPassword(role, password) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/roles?name=eq.${encodeURIComponent(role)}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    const data = await res.json();
    return data.length && data[0].password === password;
  } catch (e) {
    return false;
  }
}

// switchRole hook used by commands.js
async function switchRole(newRole) {
  // if switching to user — no password
  if (newRole === 'user') {
    currentRole = 'user';
    term.writeln('🔒 Switched to user.');
    return;
  }
  // otherwise ask for password
  const pass = await promptPassword(`Password for ${newRole}: `);
  const ok = await verifyPassword(newRole, pass);
  if (ok) {
    currentRole = newRole;
    term.writeln(`✅ Switched to ${newRole.toUpperCase()} mode.`);
  } else {
    term.writeln('❌ Wrong password.');
  }
}

// Expose switchRole globally so commands.js can call it
window.switchRole = switchRole;
window.promptPassword = promptPassword;

// ===== command dispatcher (uses window.COMMANDS defined in commands.js) =====
async function handleCommand(cmd) {
  if (!cmd) return;
  const parts = cmd.split(' ').filter(Boolean);
  const command = parts[0];
  const args = parts.slice(1);
  const cmdObj = window.COMMANDS ? window.COMMANDS[command] : null;
  if (!cmdObj) {
    term.writeln(`❌ Unknown command: ${command}`);
    return;
  }
  try {
    const result = await cmdObj.action({ args, role: currentRole, switchRole, rawInput: cmd });
    if (result) term.writeln(result);
  } catch (err) {
    term.writeln(`⚠️ Error: ${err}`);
  }
}

// ========== term input handling ==========
// the loop distinguishes between modes:
// - passwordMode: captures input but hides characters
// - EDITOR_MODE: captures full lines (no prefix), checks for markers
// - normal mode: builds buffer and sends on Enter

term.onData(async (data) => {
  const code = data.charCodeAt(0);

  // Enter
  if (code === 13) {
    term.writeln('');
    const input = buffer;
    buffer = '';

    if (passwordMode) {
      passwordMode = false;
      if (passwordResolver) {
        const resolver = passwordResolver;
        passwordResolver = null;
        resolver(input);
      }
      // after password, show prompt
      writePrompt();
      return;
    }

    if (EDITOR_MODE) {
      // each Enter completes a line: input is the line content
      const line = input;
      // check markers exactly
      if (line.trim() === '#@/s~') {
        // save and exit editor
        await saveEditor();
        return;
      }
      if (line.trim() === '#@/c~') {
        cancelEditor();
        return;
      }
      // otherwise append to buffer and continue
      EDITOR_BUFFER.push(line);
      // echo nothing extra (already printed line)
      writePrompt();
      return;
    }

    // Normal mode -> treat as command
    await handleCommand(input.trim());
    writePrompt();
    return;
  }

  // Backspace
  if (code === 127) {
    if (buffer.length > 0) {
      buffer = buffer.slice(0, -1);
      term.write('\b \b');
    }
    return;
  }

  // in password mode, mask input
  if (passwordMode) {
    buffer += data;
    term.write('*');
    return;
  }

  // Normal and editor mode input: append to buffer and show
  // Note: in EDITOR_MODE we want to allow long lines so we do same behavior
  buffer += data;
  term.write(data);
});

// responsive tweak: ensure terminal container full height on mobile
(function enhanceMobile() {
  const el = document.getElementById('terminal');
  el.style.width = '100%';
  el.style.height = '100vh';
  // some mobile browsers require body height fix (index.html should set html,body,height:100%)
})();

// Expose helpful functions to window for debugging
window.term = term;
window.currentRole = currentRole;
window.enterEditor = window.enterEditor;